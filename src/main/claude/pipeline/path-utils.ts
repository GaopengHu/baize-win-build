/**
 * @module main/claude/pipeline/path-utils
 *
 * PATH / bundled 可执行文件（node、npx、python、tools、ffmpeg、whisper 模型）
 * 解析与 build 模式下的 process.env.PATH 一次性增强。
 *
 * 注意 __dirname 语义：主进程被 vite 打包为单 chunk（inlineDynamicImports），
 * 运行时 __dirname 恒为 dist-electron/main，与源码所在目录无关，因此
 * `path.join(__dirname, '..', '..')` 依旧指向项目根，行为与迁移前一致。
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { app } from 'electron';
import { log, logWarn } from '../../utils/logger';
import { getDefaultShell } from '../../utils/shell-resolver';

// Bundled node/npx paths never change at runtime — resolve once.
let cachedBundledNodePaths: { node: string; npx: string } | null | undefined = undefined;

export function getBundledNodePaths(): { node: string; npx: string } | null {
  if (cachedBundledNodePaths !== undefined) {
    return cachedBundledNodePaths;
  }
  const platform = process.platform;
  const arch = process.arch;
  let resourcesPath: string;
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    resourcesPath = path.join(projectRoot, 'resources', 'node', `${platform}-${arch}`);
  } else {
    resourcesPath = path.join(process.resourcesPath, 'node');
  }
  const binDir = platform === 'win32' ? resourcesPath : path.join(resourcesPath, 'bin');
  const nodePath = path.join(binDir, platform === 'win32' ? 'node.exe' : 'node');
  const npxPath = path.join(binDir, platform === 'win32' ? 'npx.cmd' : 'npx');
  cachedBundledNodePaths =
    fs.existsSync(nodePath) && fs.existsSync(npxPath) ? { node: nodePath, npx: npxPath } : null;
  return cachedBundledNodePaths;
}

/**
 * Resolve bundled Python bin directory path (if available).
 * Checks packaged and dev layouts, returns the bin dir containing python3.
 */
export function resolveBundledPythonBinDir(): string | null {
  const platform = process.platform;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    if (platform === 'darwin') {
      candidates.push(path.join(projectRoot, 'resources', 'python', `darwin-${arch}`, 'bin'));
    }
    candidates.push(path.join(projectRoot, 'resources', 'python', 'bin'));
  } else {
    // Packaged layout: Resources/python/bin/python3
    candidates.push(path.join(process.resourcesPath, 'python', 'bin'));
  }

  const pythonExe = platform === 'win32' ? 'python.exe' : 'python3';
  for (const binDir of candidates) {
    if (fs.existsSync(path.join(binDir, pythonExe))) return binDir;
  }
  return null;
}

/**
 * Resolve bundled tools directory (cliclick etc., macOS only).
 */
export function resolveBundledToolsBinDir(): string | null {
  if (process.platform !== 'darwin') return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    candidates.push(path.join(projectRoot, 'resources', 'tools', `darwin-${arch}`, 'bin'));
    candidates.push(path.join(projectRoot, 'resources', 'tools', 'bin'));
  } else {
    candidates.push(path.join(process.resourcesPath, 'tools', `darwin-${arch}`, 'bin'));
    candidates.push(path.join(process.resourcesPath, 'tools', 'bin'));
  }

  for (const binDir of candidates) {
    if (fs.existsSync(binDir)) return binDir;
  }
  return null;
}

/**
 * Resolve bundled ffmpeg executable (used by the ASR skill for audio decode).
 * Dev: <projectRoot>/resources/ffmpeg/<platform>/ffmpeg[.exe]
 * Packaged: <process.resourcesPath>/ffmpeg/<platform>/ffmpeg[.exe]
 */
export function resolveBundledFfmpegPath(): string | null {
  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'ffmpeg.exe' : 'ffmpeg';

  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    candidates.push(path.join(projectRoot, 'resources', 'ffmpeg', 'windows', 'ffmpeg.exe'));
    candidates.push(path.join(projectRoot, 'resources', 'ffmpeg', 'macos', 'ffmpeg'));
    candidates.push(path.join(projectRoot, 'resources', 'ffmpeg', 'linux', 'ffmpeg'));
  } else {
    const platformDir = process.platform === 'win32' ? 'windows' : process.platform;
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', platformDir, exeName));
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'windows', 'ffmpeg.exe'));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * One-time enrichment of process.env.PATH for build (production) mode.
 *
 * In dev mode, Electron inherits the user's full shell PATH, so Skill commands
 * like `python3` and `node` just work. In build mode, `process.env.PATH` is
 * minimal (often just `/usr/bin:/bin`).
 *
 * This function:
 * 1. Restores the user's login-shell PATH (safe: uses execFileSync, not execSync)
 * 2. Prepends bundled Node, Python, and tools bin dirs (highest priority)
 * 3. Deduplicates all entries
 * 4. Writes the result back to `process.env.PATH`
 *
 * Called once before the first `createCodingTools()` — subsequent calls are no-ops.
 */
let pathEnriched = false;

/**
 * Resolve the directory that holds bundled whisper models (read-only, shipped with the app).
 * Dev: <projectRoot>/resources/whisper-models  Packaged: <process.resourcesPath>/whisper-models
 */
export function resolveBundledWhisperModelsDir(): string | null {
  const candidates: string[] = [];
  if (!app.isPackaged) {
    const projectRoot = path.join(__dirname, '..', '..');
    candidates.push(path.join(projectRoot, 'resources', 'whisper-models'));
  } else {
    candidates.push(path.join(process.resourcesPath, 'whisper-models'));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export async function enrichProcessPathForBuild(): Promise<void> {
  if (pathEnriched) return;
  pathEnriched = true;

  // ASR model dir resolution order:
  // 1. Bundled models shipped inside the app (resources/whisper-models) — read-only, no download needed.
  // 2. Per-user writable cache in userData/models/whisper — used when the app ships no bundled model.
  const bundledWhisperModels = resolveBundledWhisperModelsDir();
  const asrModelDir =
    bundledWhisperModels ?? path.join(app.getPath('userData'), 'models', 'whisper');
  if (!process.env.ASR_WHISPER_MODEL_DIR) {
    process.env.ASR_WHISPER_MODEL_DIR = asrModelDir;
    log(
      `[ClaudeAgentRunner] ASR_WHISPER_MODEL_DIR=${asrModelDir}${bundledWhisperModels ? ' (bundled, read-only)' : ' (userData cache)'}`
    );
  }

  if (!app.isPackaged) {
    log('[ClaudeAgentRunner] Dev mode — skipping PATH enrichment');
    return;
  }

  const platform = process.platform;
  const delimiter = platform === 'win32' ? ';' : ':';
  const currentPaths = (process.env.PATH || '').split(delimiter).filter((p: string) => p.trim());

  // 1. Restore user's login-shell PATH
  let shellPaths: string[] = [];
  if (platform === 'darwin' || platform === 'linux') {
    try {
      const shell = getDefaultShell();
      const output = (
        execFileSync(shell, ['-l', '-c', 'echo $PATH'], {
          encoding: 'utf-8',
          timeout: 5000,
          env: { ...process.env, HOME: os.homedir() },
        }) as string
      ).trim();
      if (output) {
        shellPaths = output.split(':').filter((p: string) => p.trim());
        log(`[ClaudeAgentRunner] Restored ${shellPaths.length} paths from login shell`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[ClaudeAgentRunner] Could not restore shell PATH: ${message}`);
    }
  } else if (platform === 'win32') {
    try {
      const output = (
        execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            "[Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine')",
          ],
          { encoding: 'utf-8', timeout: 5000 }
        ) as string
      ).trim();
      if (output) {
        shellPaths = output.split(';').filter((p: string) => p.trim());
        log(`[ClaudeAgentRunner] Restored ${shellPaths.length} paths from Windows registry`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logWarn(`[ClaudeAgentRunner] Could not restore Windows PATH: ${message}`);
    }
  }

  // 2. Collect bundled bin directories (highest priority)
  const bundledDirs: string[] = [];

  const nodePaths = getBundledNodePaths();
  if (nodePaths) {
    bundledDirs.push(path.dirname(nodePaths.node));
  }

  const pythonBinDir = resolveBundledPythonBinDir();
  if (pythonBinDir) {
    bundledDirs.push(pythonBinDir);
  }

  const toolsBinDir = resolveBundledToolsBinDir();
  if (toolsBinDir) {
    bundledDirs.push(toolsBinDir);
  }

  const ffmpegPath = resolveBundledFfmpegPath();
  if (ffmpegPath) {
    process.env.ASR_FFMPEG_PATH = ffmpegPath;
    const ffmpegDir = path.dirname(ffmpegPath);
    bundledDirs.push(ffmpegDir);
    log(`[ClaudeAgentRunner] Using bundled ffmpeg: ${ffmpegPath}`);
  }

  // 3. Merge: bundled (highest) → shell → current process, deduplicate
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const p of [...bundledDirs, ...shellPaths, ...currentPaths]) {
    const normalized = platform === 'win32' ? p.toLowerCase() : p;
    if (!seen.has(normalized)) {
      seen.add(normalized);
      merged.push(p);
    }
  }

  process.env.PATH = merged.join(delimiter);
  log(
    `[ClaudeAgentRunner] Enriched process.env.PATH for build mode: ${bundledDirs.length} bundled + ${shellPaths.length} shell + ${currentPaths.length} process → ${merged.length} total`
  );
}
