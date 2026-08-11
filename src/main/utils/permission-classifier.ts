/**
 * Pure classifier that maps a tool request to a permission kind so the
 * permission gate can auto-allow safe in-workspace operations and only
 * interrupt the user for elevated / destructive / out-of-workspace actions.
 *
 * No IPC, no Electron, no side effects on the input. Platform-specific
 * pattern tables are UNIONED so cross-platform detection stays conservative;
 * path semantics (system dirs, workspace boundary) follow the active
 * platform, which is inferred from the cwd (drive-letter / UNC → win32).
 */
import * as path from 'path';
import * as fs from 'fs';
import {
  ADVANCED_TABLES,
  LINUX_ADVANCED,
  UNION_DANGEROUS,
  UNION_DELETE,
  UNION_INSTALL,
  UNION_PRIVILEGE,
  type Platform,
} from '../../shared/permission-patterns';

// Kept re-exported for existing consumers
export type { Platform } from '../../shared/permission-patterns';

export type PermissionKind = 'advanced' | 'delete' | 'outside' | 'normal';

export interface ClassificationResult {
  kind: PermissionKind;
  reason?: string;
}

const PATH_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
]);

const WRITE_TOOLS = new Set(['write', 'edit', 'write_file', 'edit_file']);

const COMMAND_TOOLS = new Set(['bash', 'execute_command', 'shell']);

/** Extract a path candidate from a tool input object. */
function extractPath(input: Record<string, unknown>): string | null {
  for (const key of ['path', 'file_path', 'filePath', 'directory']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function extractCommand(input: Record<string, unknown>): string {
  const v = input.command ?? input.cmd;
  return typeof v === 'string' ? v : '';
}

function isPathInside(cwd: string, target: string, platform: string): boolean {
  const isWin = platform === 'win32';
  const p = isWin ? path.win32 : path.posix;

  let resolvedTarget: string;
  let resolvedCwd: string;
  try {
    if (isWin) {
      // Expand %USERPROFILE% and ~, normalize backslashes
      const expanded = target
        .replace(/%USERPROFILE%/i, process.env.USERPROFILE ?? '')
        .replace(/^~[\\/]/, process.env.USERPROFILE ?? '');
      resolvedTarget = path.win32.resolve(expanded);
      resolvedCwd = path.win32.resolve(cwd);
    } else {
      const expanded = target.replace(/^~(?=[\\/]|$)/, process.env.HOME ?? '');
      resolvedTarget = path.resolve(expanded);
      resolvedCwd = path.resolve(cwd);
    }
  } catch {
    return false; // unresolvable → conservative (outside)
  }

  if (isWin) {
    resolvedTarget = resolvedTarget.toLowerCase();
    resolvedCwd = resolvedCwd.toLowerCase();
    // UNC target can never be inside a drive-letter cwd
    if (resolvedTarget.startsWith('\\\\')) return false;
  }

  if (resolvedTarget === resolvedCwd) return true;
  const prefix = resolvedCwd.endsWith(p.sep) ? resolvedCwd : resolvedCwd + p.sep;
  if (resolvedTarget.startsWith(prefix)) return true;

  // Symlink-aware check when the path exists (best-effort)
  try {
    const real = fs.realpathSync(resolvedTarget);
    const realCwd = fs.realpathSync(resolvedCwd);
    const realPrefix = realCwd.endsWith(p.sep) ? realCwd : realCwd + p.sep;
    if (real === realCwd || real.startsWith(realPrefix)) return true;
  } catch {
    // realpath failure → fall back to string prefix result above
  }
  return false;
}

/** Detect advanced / delete patterns in a shell command string (union tables). */
function classifyCommand(command: string): ClassificationResult | null {
  if (!command || command.trim().length === 0) return null;
  const matches = (patterns: RegExp[]) => patterns.some((re) => re.test(command));
  if (matches(UNION_PRIVILEGE) || matches(UNION_INSTALL) || matches(UNION_DANGEROUS)) {
    return { kind: 'advanced', reason: 'command matches elevated/installation/dangerous patterns' };
  }
  if (matches(UNION_DELETE)) return { kind: 'delete', reason: 'command deletes files' };
  return null;
}

/** Detect advanced system-directory writes for path tools. */
function classifyPath(
  cwd: string | null,
  toolName: string,
  input: Record<string, unknown>,
  platform: string
): ClassificationResult | null {
  const target = extractPath(input);
  if (!target) return null;

  // Control characters can never be part of a legitimate path.
  // eslint-disable-next-line no-control-regex -- intentional control-char rejection
  if (/[\u0000-\u001F]/.test(target)) {
    return { kind: 'outside', reason: 'path contains control characters' };
  }

  const table = ADVANCED_TABLES[platform] ?? LINUX_ADVANCED;
  const isWin = platform === 'win32';
  const norm = (s: string) => (isWin ? s.toLowerCase() : s);

  // Writes into system directories are advanced; reads are judged purely by
  // the workspace boundary below so they only need confirmation when outside.
  if (WRITE_TOOLS.has(toolName)) {
    for (const dir of table.systemDirs) {
      if (norm(target).startsWith(norm(dir))) {
        return { kind: 'advanced', reason: `path is in system directory: ${dir}` };
      }
    }
  }

  if (cwd) {
    const inside = isPathInside(cwd, target, platform);
    if (inside) return { kind: 'normal', reason: 'path is inside the session working directory' };
    return { kind: 'outside', reason: 'path is outside the session working directory' };
  }

  // No cwd: relative paths are presumed in-workspace; absolute are outside.
  const absolute = isWin
    ? /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\\\')
    : target.startsWith('/');
  return absolute
    ? { kind: 'outside', reason: 'absolute path with no session cwd' }
    : { kind: 'normal', reason: 'relative path with no session cwd' };
}

/** Infer the path semantics platform from the session cwd. */
function inferPlatform(cwd: string | null): Platform {
  if (cwd && (/^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith('\\\\'))) return 'win32';
  return process.platform;
}

/**
 * Classify a tool request. Priority: advanced > delete > outside > normal.
 */
export function classifyPermission(
  cwd: string | null,
  toolName: string,
  input: Record<string, unknown>
): ClassificationResult {
  return classifyPermissionForPlatform(cwd, toolName, input, inferPlatform(cwd));
}

/** Testable variant with an explicit platform override. */
export function classifyPermissionForPlatform(
  cwd: string | null,
  toolName: string,
  input: Record<string, unknown>,
  platform: Platform
): ClassificationResult {
  const lowered = toolName.toLowerCase();

  if (COMMAND_TOOLS.has(lowered)) {
    try {
      const fromCommand = classifyCommand(extractCommand(input));
      if (fromCommand) return fromCommand;
    } catch {
      return { kind: 'normal', reason: 'command classification failed; falling back to normal' };
    }
  }

  if (PATH_TOOLS.has(lowered)) {
    try {
      const fromPath = classifyPath(cwd, lowered, input, platform);
      if (fromPath) return fromPath;
    } catch {
      return { kind: 'outside', reason: 'path classification failed; conservative outside' };
    }
  }

  return { kind: 'normal', reason: 'no classification rule matched' };
}

/**
 * Decision gate combining classification, rule decision and the session
 * allow-all flag. Pure — the only place the allow/ask/deny logic lives.
 *
 *   - ruleDecision === 'deny'             → 'deny' (rules always win)
 *   - kind advanced | delete              → 'ask' (never auto-allowed)
 *   - kind outside                        → sessionAllowAll ? 'allow' : 'ask'
 *   - kind normal                         → ruleDecision ('allow' | 'ask' | 'deny')
 */
export function resolvePermissionGate(
  kind: PermissionKind,
  ruleDecision: 'allow' | 'deny' | 'ask',
  sessionAllowAll: boolean
): 'allow' | 'ask' | 'deny' {
  if (ruleDecision === 'deny') return 'deny';
  if (kind === 'advanced' || kind === 'delete') return 'ask';
  if (kind === 'outside') return sessionAllowAll ? 'allow' : 'ask';
  return ruleDecision;
}
