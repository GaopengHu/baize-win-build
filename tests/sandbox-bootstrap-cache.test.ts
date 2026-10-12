/**
 * Tests for the sandbox bootstrap cache acceptance criteria and the
 * Python install failure cooldown.
 *
 * Regression context (Windows): the bootstrap used to save the status cache
 * even when Python installation failed (non-critical), but isWSLReady()
 * required pythonAvailable && pipAvailable, so the cache was never accepted
 * and every launch re-ran the full slow bootstrap (probes + apt install).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => {
  const state = {
    checkWSLStatus: vi.fn(),
    installPythonInWSL: vi.fn(),
    installPipInWSL: vi.fn(),
    installNodeInWSL: vi.fn(),
    installSkillDependencies: vi.fn(),
    configGet: vi.fn(() => true),
  };
  return state;
});

let userDataDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
    isPackaged: false,
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../src/main/config/config-store', () => ({
  configStore: {
    get: mocks.configGet,
  },
}));

vi.mock('../src/main/sandbox/wsl-bridge', () => ({
  WSLBridge: {
    checkWSLStatus: mocks.checkWSLStatus,
    installNodeInWSL: mocks.installNodeInWSL,
    installPythonInWSL: mocks.installPythonInWSL,
    installPipInWSL: mocks.installPipInWSL,
    installSkillDependencies: mocks.installSkillDependencies,
  },
}));

vi.mock('../src/main/sandbox/lima-bridge', () => ({
  LimaBridge: {
    checkLimaStatus: vi.fn(),
    isInstanceRunning: vi.fn(async () => true),
    installNodeInLima: vi.fn(),
    installPythonInLima: vi.fn(),
  },
}));

function baseWSLStatus(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    distro: 'Ubuntu',
    nodeAvailable: true,
    pythonAvailable: true,
    pipAvailable: true,
    claudeCodeAvailable: false,
    version: 'v20.11.0',
    pythonVersion: 'Python 3.10.12',
    ...overrides,
  };
}

const CACHE_FILE = 'sandbox-status-cache.json';

function readCache(): Record<string, unknown> | null {
  const filePath = path.join(userDataDir, CACHE_FILE);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Import a fresh SandboxBootstrap singleton (module state is reset per test). */
async function freshBootstrap() {
  vi.resetModules();
  const mod = await import('../src/main/sandbox/sandbox-bootstrap');
  return mod.getSandboxBootstrap();
}

beforeEach(() => {
  vi.clearAllMocks();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-bootstrap-test-'));
  mocks.configGet.mockReturnValue(true);
  // checkWSLStatus runs on the Windows bootstrap path
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
});

describe('sandbox bootstrap cache acceptance', () => {
  it('accepts cached WSL status without Python (cache is not gated on python)', async () => {
    // Pre-seed a cache entry where Python is missing
    fs.writeFileSync(
      path.join(userDataDir, CACHE_FILE),
      JSON.stringify({
        platform: 'win32',
        mode: 'wsl',
        wslStatus: baseWSLStatus({ pythonAvailable: false, pipAvailable: false }),
        limaStatus: null,
        verifiedAt: Date.now(),
      }),
      'utf-8'
    );

    const bootstrap = await freshBootstrap();
    const result = await bootstrap.bootstrap();

    // Cache accepted: no subprocess probes or installs run
    expect(mocks.checkWSLStatus).not.toHaveBeenCalled();
    expect(mocks.installPythonInWSL).not.toHaveBeenCalled();
    expect(result.mode).toBe('wsl');
    expect(result.wslStatus?.pythonAvailable).toBe(false);
  });

  it('rejects cached WSL status when Node is missing', async () => {
    fs.writeFileSync(
      path.join(userDataDir, CACHE_FILE),
      JSON.stringify({
        platform: 'win32',
        mode: 'wsl',
        wslStatus: baseWSLStatus({ nodeAvailable: false }),
        limaStatus: null,
        verifiedAt: Date.now(),
      }),
      'utf-8'
    );
    mocks.checkWSLStatus.mockResolvedValue(baseWSLStatus({ nodeAvailable: false }));
    mocks.installNodeInWSL.mockResolvedValue(true);

    const bootstrap = await freshBootstrap();
    await bootstrap.bootstrap();

    // Cache rejected -> full re-check happened
    expect(mocks.checkWSLStatus).toHaveBeenCalled();
  });

  it('records pythonInstallFailedAt when Python install fails', async () => {
    mocks.checkWSLStatus.mockResolvedValue(
      baseWSLStatus({ pythonAvailable: false, pipAvailable: false })
    );
    mocks.installPythonInWSL.mockResolvedValue(false);

    const bootstrap = await freshBootstrap();
    const result = await bootstrap.bootstrap();

    // Failure is non-critical: bootstrap still reports ready
    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('wsl');
    const cache = readCache();
    expect(cache).not.toBeNull();
    expect(typeof cache?.pythonInstallFailedAt).toBe('number');
  });
});

describe('python install failure cooldown', () => {
  it('skips auto-install within the cooldown window', async () => {
    mocks.checkWSLStatus.mockResolvedValue(
      baseWSLStatus({ pythonAvailable: false, pipAvailable: false })
    );
    mocks.installPythonInWSL.mockResolvedValue(false);

    // Cache entry that is rejected by isWSLReady (incomplete status) but
    // still within TTL, carrying a recent Python failure timestamp.
    fs.writeFileSync(
      path.join(userDataDir, CACHE_FILE),
      JSON.stringify({
        platform: 'win32',
        mode: 'wsl',
        wslStatus: null,
        limaStatus: null,
        verifiedAt: Date.now(),
        pythonInstallFailedAt: Date.now() - 60 * 1000, // failed 1 minute ago
      }),
      'utf-8'
    );

    const bootstrap = await freshBootstrap();
    await bootstrap.bootstrap();

    // Full re-check happened, but cooldown suppressed the doomed install
    expect(mocks.checkWSLStatus).toHaveBeenCalledTimes(1);
    expect(mocks.installPythonInWSL).not.toHaveBeenCalled();

    // Failure timestamp is preserved in the newly saved cache
    const cache = readCache();
    expect(typeof cache?.pythonInstallFailedAt).toBe('number');
  });

  it('retries auto-install once the cooldown has expired', async () => {
    mocks.checkWSLStatus.mockResolvedValue(
      baseWSLStatus({ pythonAvailable: false, pipAvailable: false })
    );
    mocks.installPythonInWSL.mockResolvedValue(false);

    fs.writeFileSync(
      path.join(userDataDir, CACHE_FILE),
      JSON.stringify({
        platform: 'win32',
        mode: 'wsl',
        wslStatus: null,
        limaStatus: null,
        verifiedAt: Date.now(),
        pythonInstallFailedAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago
      }),
      'utf-8'
    );

    const bootstrap = await freshBootstrap();
    await bootstrap.bootstrap();

    // Cooldown expired -> install retried
    expect(mocks.installPythonInWSL).toHaveBeenCalledTimes(1);
  });

  it('reset() clears the cooldown so manual retry reinstalls', async () => {
    mocks.checkWSLStatus.mockResolvedValue(
      baseWSLStatus({ pythonAvailable: false, pipAvailable: false })
    );
    mocks.installPythonInWSL.mockResolvedValue(false);

    const bootstrap = await freshBootstrap();
    await bootstrap.bootstrap();
    expect(mocks.installPythonInWSL).toHaveBeenCalledTimes(1);

    // Manual retry via Settings ("retry setup") calls reset() then bootstrap()
    bootstrap.reset();
    expect(fs.existsSync(path.join(userDataDir, CACHE_FILE))).toBe(false);
    mocks.installPythonInWSL.mockClear();

    await bootstrap.bootstrap();
    expect(mocks.installPythonInWSL).toHaveBeenCalledTimes(1);
  });

  it('clears pythonInstallFailedAt when a later install succeeds', async () => {
    mocks.checkWSLStatus.mockResolvedValue(
      baseWSLStatus({ pythonAvailable: false, pipAvailable: false })
    );
    mocks.installPythonInWSL.mockResolvedValue(true);

    // Pre-seed an expired cache with an old failure timestamp
    fs.writeFileSync(
      path.join(userDataDir, CACHE_FILE),
      JSON.stringify({
        platform: 'win32',
        mode: 'wsl',
        wslStatus: baseWSLStatus({ pythonAvailable: false, pipAvailable: false }),
        limaStatus: null,
        verifiedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // expired
        pythonInstallFailedAt: Date.now() - 30 * 24 * 60 * 60 * 1000, // outside 7d cooldown
      }),
      'utf-8'
    );

    const bootstrap = await freshBootstrap();
    await bootstrap.bootstrap();

    // Old failure outside cooldown -> install retried and succeeded
    expect(mocks.installPythonInWSL).toHaveBeenCalledTimes(1);
    const cache = readCache();
    expect(cache?.pythonInstallFailedAt).toBeUndefined();
  });
});
