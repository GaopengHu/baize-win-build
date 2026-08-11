import { execSync } from 'child_process';
import { platform } from 'os';

export interface DetectedTools {
  shells: string[];
  available: string[];
}

let cached: DetectedTools | null = null;

function isToolAvailable(name: string): boolean {
  try {
    const cmd = platform() === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const COMMON_SHELLS_WIN = ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'wsl.exe'];
const COMMON_SHELLS_UNIX = ['bash', 'zsh', 'sh', 'fish'];
const COMMON_TOOLS_WIN = ['python.exe', 'node.exe', 'git.exe', 'findstr', 'where'];
const COMMON_TOOLS_UNIX = ['python3', 'node', 'git', 'grep', 'find', 'sed', 'awk'];

export function detectCommandTools(): DetectedTools {
  if (cached) return cached;

  const isWin = platform() === 'win32';
  const shells = (isWin ? COMMON_SHELLS_WIN : COMMON_SHELLS_UNIX)
    .filter((s) => isToolAvailable(s));
  const available = (isWin ? COMMON_TOOLS_WIN : COMMON_TOOLS_UNIX)
    .filter((t) => isToolAvailable(t));

  // Ensure cmd.exe is always in the list on Windows (always available)
  if (isWin && !shells.includes('cmd.exe')) {
    shells.push('cmd.exe');
  }

  cached = { shells, available };
  return cached;
}

export function clearDetectCache(): void {
  cached = null;
}

export function formatDetectedTools(detected?: DetectedTools): string {
  const d = detected || detectCommandTools();
  const parts: string[] = [];
  if (d.shells.length > 0) {
    parts.push(`Available shells: ${d.shells.join(', ')}`);
  }
  if (d.available.length > 0) {
    parts.push(`Available tools: ${d.available.join(', ')}`);
  }
  return parts.join('\n');
}