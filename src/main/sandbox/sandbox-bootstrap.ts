/**
 * Sandbox Bootstrap Service
 *
 * Handles early sandbox initialization at app startup
 * Provides progress feedback to the renderer process
 * Caches status to avoid repeated slow checks
 *
 * Cache strategy:
 *   After the first successful bootstrap, the WSL / Lima / native status is
 *   persisted to a JSON file in userData.  On subsequent launches the
 *   expensive platform checks (multiple WSL/lima subprocess spawns) are
 *   skipped entirely and the cached result is reported as "ready"
 *   immediately.  Calling reset() deletes the cache so the user can
 *   force a re-check via the "retry" UI button.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { log, logError } from '../utils/logger';
import { WSLBridge } from './wsl-bridge';
import { LimaBridge } from './lima-bridge';
import { configStore } from '../config/config-store';
import type { WSLStatus, LimaStatus } from './types';

export type SandboxSetupPhase =
  | 'checking' // Checking WSL/Lima availability
  | 'creating' // Creating Lima instance (macOS only)
  | 'starting' // Starting Lima instance (macOS only)
  | 'installing_node' // Installing Node.js
  | 'installing_python' // Installing Python
  | 'installing_pip' // Installing pip
  | 'installing_deps' // Installing skill dependencies (markitdown, pypdf, etc.)
  | 'ready' // Ready to use
  | 'skipped' // No sandbox needed (native mode)
  | 'error'; // Setup failed

export interface SandboxSetupProgress {
  phase: SandboxSetupPhase;
  message: string;
  detail?: string;
  progress?: number; // 0-100
  error?: string;
}

export interface SandboxBootstrapResult {
  mode: 'wsl' | 'lima' | 'native';
  wslStatus?: WSLStatus;
  limaStatus?: LimaStatus;
  error?: string;
}

type ProgressCallback = (progress: SandboxSetupProgress) => void;

/**
 * Persisted sandbox status cache.
 * Written after a successful bootstrap so the next launch can skip the
 * slow platform checks (WSL/Lima spawns) entirely.
 */
interface SandboxCacheEntry {
  platform: NodeJS.Platform;
  mode: 'wsl' | 'lima' | 'native';
  wslStatus?: WSLStatus | null;
  limaStatus?: LimaStatus | null;
  verifiedAt: number;
}

const SANDBOX_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function isWSLReady(status: WSLStatus | null | undefined): boolean {
  return Boolean(
    status?.available && status.nodeAvailable && status.pythonAvailable && status.pipAvailable
  );
}

function isLimaReady(status: LimaStatus | null | undefined): boolean {
  return Boolean(
    status?.available &&
      status.instanceRunning &&
      status.nodeAvailable &&
      status.pythonAvailable &&
      status.pipAvailable
  );
}

/**
 * Bootstrap sandbox environment at app startup
 * This runs in the background and reports progress to the renderer
 * Caches the result so SandboxAdapter can skip slow status checks
 */
export class SandboxBootstrap {
  private static instance: SandboxBootstrap | null = null;
  private setupPromise: Promise<SandboxBootstrapResult> | null = null;
  private progressCallback: ProgressCallback | null = null;
  private result: SandboxBootstrapResult | null = null;

  // Cached status for quick access by SandboxAdapter
  private cachedWSLStatus: WSLStatus | null = null;
  private cachedLimaStatus: LimaStatus | null = null;

  static getInstance(): SandboxBootstrap {
    if (!SandboxBootstrap.instance) {
      SandboxBootstrap.instance = new SandboxBootstrap();
    }
    return SandboxBootstrap.instance;
  }

  /**
   * Get cached WSL status (available after bootstrap completes)
   */
  getCachedWSLStatus(): WSLStatus | null {
    return this.cachedWSLStatus;
  }

  /**
   * Get cached Lima status (available after bootstrap completes)
   */
  getCachedLimaStatus(): LimaStatus | null {
    return this.cachedLimaStatus;
  }

  /**
   * Set progress callback for UI updates
   */
  setProgressCallback(callback: ProgressCallback): void {
    this.progressCallback = callback;
  }

  /**
   * Report progress to renderer
   */
  private reportProgress(progress: SandboxSetupProgress): void {
    log(`[SandboxBootstrap] ${progress.phase}: ${progress.message}`);
    if (progress.detail) {
      log(`[SandboxBootstrap]   Detail: ${progress.detail}`);
    }
    if (this.progressCallback) {
      this.progressCallback(progress);
    }
  }

  /**
   * Check if setup is complete
   */
  isComplete(): boolean {
    return this.result !== null;
  }

  private getCacheFilePath(): string {
    return path.join(app.getPath('userData'), 'sandbox-status-cache.json');
  }

  private loadCache(): SandboxCacheEntry | null {
    try {
      const filePath = this.getCacheFilePath();
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SandboxCacheEntry;
      if (typeof raw !== 'object' || raw === null || !raw.mode || !raw.platform) {
        return null;
      }
      if (Date.now() - raw.verifiedAt > SANDBOX_CACHE_TTL_MS) {
        log('[SandboxBootstrap] Sandbox cache expired, will re-check platform');
        return null;
      }
      return raw;
    } catch (error) {
      log('[SandboxBootstrap] Failed to load sandbox cache:', error);
      return null;
    }
  }

  private saveCache(entry: SandboxCacheEntry): void {
    try {
      const filePath = this.getCacheFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(entry, null, 2), 'utf-8');
      log('[SandboxBootstrap] Saved sandbox cache:', entry.mode);
    } catch (error) {
      log('[SandboxBootstrap] Failed to save sandbox cache:', error);
    }
  }

  private clearCache(): void {
    try {
      const filePath = this.getCacheFilePath();
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log('[SandboxBootstrap] Cleared sandbox cache');
      }
    } catch (error) {
      log('[SandboxBootstrap] Failed to clear sandbox cache:', error);
    }
  }

  /**
   * Try to serve a valid cached bootstrap result so we can skip the slow
   * WSL/Lima platform checks on subsequent launches.
   *
   * Returns null when there is no usable cache (first run, cache expired,
   * platform changed, or the previous run did not finish successfully).
   */
  private async tryLoadCachedResult(): Promise<SandboxBootstrapResult | null> {
    const cache = this.loadCache();
    if (!cache || cache.platform !== process.platform) {
      return null;
    }

    if (cache.mode === 'native') {
      log('[SandboxBootstrap] Using cached native mode');
      this.reportProgress({
        phase: 'skipped',
        message: 'Using native execution mode',
        detail: 'Reusing previous sandbox check result',
        progress: 100,
      });
      return { mode: 'native' };
    }

    if (cache.mode === 'wsl' && isWSLReady(cache.wslStatus)) {
      const wslStatus = cache.wslStatus as WSLStatus;
      this.cachedWSLStatus = wslStatus;
      this.reportProgress({
        phase: 'ready',
        message: 'WSL2 sandbox ready',
        detail: `Reusing previous check - Node.js ${wslStatus.version || 'installed'}`,
        progress: 100,
      });
      return { mode: 'wsl', wslStatus };
    }

    if (cache.mode === 'lima' && isLimaReady(cache.limaStatus)) {
      // The Lima VM can be stopped between app launches, so verify it is
      // actually still running before trusting the cache. This is a fast
      // `limactl list` check, not a full node/python probe.
      const running = await LimaBridge.isInstanceRunning();
      if (running) {
        const limaStatus = cache.limaStatus as LimaStatus;
        this.cachedLimaStatus = limaStatus;
        this.reportProgress({
          phase: 'ready',
          message: 'Lima sandbox ready',
          detail: `Reusing previous check - Node.js ${limaStatus.version || 'installed'}`,
          progress: 100,
        });
        return { mode: 'lima', limaStatus };
      }
      log('[SandboxBootstrap] Lima cache found but VM is not running, re-checking...');
      return null;
    }

    return null;
  }

  reset(): void {
    this.setupPromise = null;
    this.result = null;
    this.cachedWSLStatus = null;
    this.cachedLimaStatus = null;
    this.clearCache();
  }

  /**
   * Get the bootstrap result (if complete)
   */
  getResult(): SandboxBootstrapResult | null {
    return this.result;
  }

  /**
   * Start sandbox bootstrap (idempotent - returns existing promise if running)
   */
  async bootstrap(): Promise<SandboxBootstrapResult> {
    if (this.setupPromise) {
      return this.setupPromise;
    }

    this.setupPromise = this._bootstrap().catch((err) => {
      // Clear setupPromise on error so next call retries instead of reusing failed promise
      this.setupPromise = null;
      throw err;
    });
    this.result = await this.setupPromise;
    return this.result;
  }

  private async _bootstrap(): Promise<SandboxBootstrapResult> {
    const platform = process.platform;
    log('[SandboxBootstrap] Starting bootstrap for platform:', platform);

    // Check if sandbox is enabled in config
    const sandboxEnabled = configStore.get('sandboxEnabled');
    if (sandboxEnabled === false) {
      log('[SandboxBootstrap] Sandbox disabled by user configuration');
      this.reportProgress({
        phase: 'skipped',
        message: 'Sandbox disabled',
        detail: 'Using native execution mode (sandbox disabled in settings)',
        progress: 100,
      });
      return { mode: 'native' };
    }

    // Fast path: reuse the persisted status so the slow WSL/Lima checks
    // (multiple subprocess spawns that can take 30+ seconds) are skipped
    // on every launch after the first successful setup.
    const cached = await this.tryLoadCachedResult();
    if (cached) {
      return cached;
    }

    try {
      let result: SandboxBootstrapResult;
      if (platform === 'win32') {
        result = await this.bootstrapWSL();
      } else if (platform === 'darwin') {
        result = await this.bootstrapLima();
      } else {
        // Linux - native mode
        this.reportProgress({
          phase: 'skipped',
          message: 'Using native execution mode',
          detail: 'Linux runs commands directly',
          progress: 100,
        });
        result = { mode: 'native' };
      }

      // Persist the successful result for the next launch
      if (!result.error) {
        this.saveCache({
          platform,
          mode: result.mode,
          wslStatus: result.wslStatus || null,
          limaStatus: result.limaStatus || null,
          verifiedAt: Date.now(),
        });
      }
      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logError('[SandboxBootstrap] Bootstrap failed:', error);
      this.reportProgress({
        phase: 'error',
        message: 'Sandbox setup failed',
        detail: errorMsg,
        error: errorMsg,
      });
      return { mode: 'native', error: errorMsg };
    }
  }

  /**
   * Bootstrap WSL on Windows
   */
  private async bootstrapWSL(): Promise<SandboxBootstrapResult> {
    // Phase 1: Check WSL availability
    this.reportProgress({
      phase: 'checking',
      message: 'Checking WSL2 environment...',
      progress: 10,
    });

    const wslStatus = await WSLBridge.checkWSLStatus();

    // Cache the status for SandboxAdapter to use later
    this.cachedWSLStatus = wslStatus;

    if (!wslStatus.available) {
      this.reportProgress({
        phase: 'skipped',
        message: 'WSL2 not detected, using native mode',
        detail: 'Install WSL2 for better sandbox isolation',
        progress: 100,
      });
      return { mode: 'native', wslStatus };
    }

    log('[SandboxBootstrap] WSL detected:', wslStatus.distro);

    // Phase 2: Install Node.js if needed
    if (!wslStatus.nodeAvailable) {
      this.reportProgress({
        phase: 'installing_node',
        message: 'Installing Node.js...',
        detail: `Installing Node.js runtime in ${wslStatus.distro}`,
        progress: 30,
      });

      const nodeInstalled = await WSLBridge.installNodeInWSL(wslStatus.distro!);
      if (!nodeInstalled) {
        this.reportProgress({
          phase: 'error',
          message: 'Node.js installation failed',
          detail: 'Please install Node.js manually in WSL',
          error: 'Failed to install Node.js in WSL',
        });
        return { mode: 'native', wslStatus, error: 'Node.js installation failed' };
      }
      wslStatus.nodeAvailable = true;
    }

    // Phase 3: Install Python if needed
    if (!wslStatus.pythonAvailable) {
      this.reportProgress({
        phase: 'installing_python',
        message: 'Installing Python...',
        detail: `Installing Python runtime in ${wslStatus.distro}`,
        progress: 50,
      });

      const pythonInstalled = await WSLBridge.installPythonInWSL(wslStatus.distro!);
      if (pythonInstalled) {
        wslStatus.pythonAvailable = true;
        wslStatus.pipAvailable = true;

        // Python install also installs skill deps, so report progress
        this.reportProgress({
          phase: 'installing_deps',
          message: 'Installing skill dependencies...',
          detail: 'Installing markitdown, pypdf, pdfplumber for PDF/PPTX skills',
          progress: 80,
        });
      } else {
        log('[SandboxBootstrap] Python installation failed (non-critical)');
      }
    } else if (!wslStatus.pipAvailable) {
      // Python available but pip is not
      this.reportProgress({
        phase: 'installing_pip',
        message: 'Installing pip...',
        detail: `Installing Python package manager in ${wslStatus.distro}`,
        progress: 60,
      });

      const pipInstalled = await WSLBridge.installPipInWSL(wslStatus.distro!);
      if (pipInstalled) {
        wslStatus.pipAvailable = true;

        // After pip install, also install skill dependencies
        this.reportProgress({
          phase: 'installing_deps',
          message: 'Installing skill dependencies...',
          detail: 'Installing markitdown, pypdf, pdfplumber for PDF/PPTX skills',
          progress: 80,
        });
        await WSLBridge.installSkillDependencies(wslStatus.distro!);
      }
    }

    // Ready - update cached status
    this.cachedWSLStatus = wslStatus;

    this.reportProgress({
      phase: 'ready',
      message: 'WSL2 sandbox ready',
      detail: `${wslStatus.distro} - Node.js ${wslStatus.version || 'installed'}`,
      progress: 100,
    });

    return { mode: 'wsl', wslStatus };
  }

  /**
   * Bootstrap Lima on macOS
   */
  private async bootstrapLima(): Promise<SandboxBootstrapResult> {
    // Phase 1: Check Lima availability
    this.reportProgress({
      phase: 'checking',
      message: 'Checking Lima environment...',
      progress: 10,
    });

    let limaStatus = await LimaBridge.checkLimaStatus();

    // Cache the status
    this.cachedLimaStatus = limaStatus;

    if (!limaStatus.available) {
      this.reportProgress({
        phase: 'skipped',
        message: 'Lima not detected, using native mode',
        detail: 'Install Lima for better sandbox isolation (brew install lima)',
        progress: 100,
      });
      return { mode: 'native', limaStatus };
    }

    log('[SandboxBootstrap] Lima detected');

    // Phase 2: Create instance if needed
    if (!limaStatus.instanceExists) {
      this.reportProgress({
        phase: 'creating',
        message: 'Creating Lima VM...',
        detail: 'First run requires image download, may take a few minutes',
        progress: 20,
      });

      const created = await LimaBridge.createLimaInstance();
      if (!created) {
        this.reportProgress({
          phase: 'error',
          message: 'Lima VM creation failed',
          error: 'Failed to create Lima instance',
        });
        return { mode: 'native', limaStatus, error: 'Lima instance creation failed' };
      }
      limaStatus.instanceExists = true;
    }

    // Phase 3: Start instance if needed
    if (!limaStatus.instanceRunning) {
      this.reportProgress({
        phase: 'starting',
        message: 'Starting Lima VM...',
        detail: 'VM startup may take a few minutes',
        progress: 40,
      });

      const started = await LimaBridge.startLimaInstance();
      if (!started) {
        this.reportProgress({
          phase: 'error',
          message: 'Lima VM startup failed',
          error: 'Failed to start Lima instance',
        });
        return { mode: 'native', limaStatus, error: 'Lima instance start failed' };
      }
      limaStatus.instanceRunning = true;

      // Re-check status after starting
      limaStatus = await LimaBridge.checkLimaStatus();
    }

    // Phase 4: Install Node.js if needed
    if (!limaStatus.nodeAvailable) {
      this.reportProgress({
        phase: 'installing_node',
        message: 'Installing Node.js...',
        detail: 'Installing Node.js runtime in Lima VM',
        progress: 60,
      });

      const nodeInstalled = await LimaBridge.installNodeInLima();
      if (!nodeInstalled) {
        const refreshedStatus = await LimaBridge.checkLimaStatus();
        if (refreshedStatus.nodeAvailable) {
          limaStatus = refreshedStatus;
        } else {
          this.reportProgress({
            phase: 'error',
            message: 'Node.js installation failed',
            error: 'Failed to install Node.js in Lima',
          });
          return { mode: 'native', limaStatus, error: 'Node.js installation failed' };
        }
      }
      limaStatus.nodeAvailable = true;
    }

    // Phase 5: Install Python if needed
    if (!limaStatus.pythonAvailable) {
      this.reportProgress({
        phase: 'installing_python',
        message: 'Installing Python...',
        detail: 'Installing Python runtime in Lima VM',
        progress: 75,
      });

      const pythonInstalled = await LimaBridge.installPythonInLima();
      if (pythonInstalled) {
        limaStatus.pythonAvailable = true;
        limaStatus.pipAvailable = true;

        // Python install also installs skill deps, so report progress
        this.reportProgress({
          phase: 'installing_deps',
          message: 'Installing skill dependencies...',
          detail: 'Installing markitdown, pypdf, pdfplumber for PDF/PPTX skills',
          progress: 90,
        });
      }
    }

    // Ready - update cached status
    this.cachedLimaStatus = limaStatus;

    this.reportProgress({
      phase: 'ready',
      message: 'Lima sandbox ready',
      detail: `VM running - Node.js ${limaStatus.version || 'installed'}`,
      progress: 100,
    });

    return { mode: 'lima', limaStatus };
  }
}

// Export singleton getter
export function getSandboxBootstrap(): SandboxBootstrap {
  return SandboxBootstrap.getInstance();
}
