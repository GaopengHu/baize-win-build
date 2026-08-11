import { getPlatformInfo } from './platform-info';

export interface CommandValidationResult {
  suitable: boolean;
  reason?: string;
  mappedCommand?: string;
}

// Simple command-name mappings for the most common cross-platform mistakes.
// Arguments are preserved as-is; this is a best-effort fallback.
const UNIX_TO_WINDOWS: Record<string, string> = {
  ls: 'dir',
  cat: 'type',
  grep: 'findstr',
  pwd: 'cd',
  rm: 'del',
  cp: 'copy',
  mv: 'move',
  mkdir: 'md',
  rmdir: 'rd',
  clear: 'cls',
  touch: 'type nul >',
};

const WINDOWS_TO_UNIX: Record<string, string> = {
  dir: 'ls',
  type: 'cat',
  findstr: 'grep',
  cls: 'clear',
  md: 'mkdir',
  rd: 'rmdir',
};

/**
 * Extract the first command token from a shell command string.
 * Handles simple leading whitespace and quotes, but not complex shell syntax.
 */
function extractCommandName(command: string): string {
  const trimmed = command.trim();
  const match = trimmed.match(/^['"]?([^\s'"]+)['"]?/);
  return (match?.[1] ?? trimmed).toLowerCase();
}

/**
 * Check whether a command is suitable for the current platform.
 * If it looks like a foreign command, try a lightweight local mapping first.
 */
export function validateCommandForPlatform(command: string): CommandValidationResult {
  const { platform } = getPlatformInfo();
  const name = extractCommandName(command);

  if (!name) {
    return { suitable: true };
  }

  if (platform === 'win32') {
    // On Windows, a Unix-only command may still work if the shell is PowerShell
    // (PowerShell has aliases for ls/cat/etc.). We only map the most common cases.
    if (UNIX_TO_WINDOWS[name]) {
      return {
        suitable: false,
        reason: `Command "${name}" is a Unix command on Windows.`,
        mappedCommand: command.replace(new RegExp(`^${name}\\b`, 'i'), UNIX_TO_WINDOWS[name]),
      };
    }
    return { suitable: true };
  }

  // Darwin / Linux / UOS
  if (WINDOWS_TO_UNIX[name]) {
    return {
      suitable: false,
      reason: `Command "${name}" is a Windows command on ${platform}.`,
      mappedCommand: command.replace(new RegExp(`^${name}\\b`, 'i'), WINDOWS_TO_UNIX[name]),
    };
  }

  return { suitable: true };
}

/**
 * Determine whether a command failure is likely caused by platform incompatibility.
 */
export function isPlatformError(stderr: string, platform: string): boolean {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();

  const commonPlatformErrors = [
    'command not found',
    'is not recognized',
    '不是内部或外部命令',
    '无法将命令',
    'cannot find the command',
  ];

  if (commonPlatformErrors.some((err) => lower.includes(err.toLowerCase()))) {
    return true;
  }

  if (platform === 'win32') {
    return lower.includes('not recognized as an internal or external command');
  }

  return false;
}

/**
 * Build a concise prompt asking the model to rewrite a command for the current platform.
 */
export function buildRewriteCommandPrompt(command: string, error: string): string {
  const { platform, prettyName, shell } = getPlatformInfo();
  return `The following shell command failed on ${prettyName} (platform: ${platform}, shell: ${shell}):

Command:
\`\`\`
${command}
\`\`\`

Error output:
\`\`\`
${error}
\`\`\`

Please rewrite this command so it works correctly on ${prettyName} using ${shell}.
Return ONLY the rewritten command, with no markdown, no explanation, and no code fences.`;
}
