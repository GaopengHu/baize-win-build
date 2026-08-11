/**
 * Shared permission pattern tables (pure data).
 *
 * No node:fs / node:path / electron imports — safe to import from both the
 * main process (permission-classifier) and the renderer (permission-summary).
 * Tables are unioned across Linux/macOS/Windows so cross-platform detection
 * stays conservative regardless of the current platform.
 */
export type Platform = 'linux' | 'darwin' | 'win32' | string;

export interface AdvancedPatterns {
  privilege: RegExp[];
  install: RegExp[];
  systemDirs: string[];
  dangerous: RegExp[];
}

export const LINUX_ADVANCED: AdvancedPatterns = {
  privilege: [/\bsudo\b/, /\bsu\s+-/],
  install: [
    /\bapt(-get)?\s+install\b/,
    /\byum\s+install\b/,
    /\bdnf\s+install\b/,
    /\bpip3?\s+install\b/,
    /\bnpm\s+install\b/,
    /\bgem\s+install\b/,
    /\bcargo\s+install\b/,
    /\bpacman\s+-S\b/,
  ],
  systemDirs: ['/etc', '/usr', '/var', '/boot', '/sbin', '/bin'],
  dangerous: [
    /\bmkfs(\.\w+)?\b/,
    /\bfdisk\b/,
    /\bdd\s+if=/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bchmod\s+-R\b/,
    /\bchown\s+-R\b/,
    /\b(curl|wget).*\|\s*(sh|bash)\b/,
    /\brm\s+-[a-z]*r[a-z]*(?:\s+-\w+)*\s+\/(?:etc|usr|var|boot|sbin|bin)\b/,
  ],
};

export const DARWIN_ADVANCED: AdvancedPatterns = {
  privilege: [/\bsudo\b/, /\bsudo\s+-s\b/],
  install: [/\bbrew\s+install\b/, /\bpip3?\s+install\b/, /\bnpm\s+install\b/, /\bgem\s+install\b/],
  systemDirs: ['/etc', '/usr', '/var', '/System', '/Applications'],
  dangerous: [
    ...LINUX_ADVANCED.dangerous,
    /\bdiskutil\s+eraseDisk\b/,
    /osascript.*System\s+Events/,
  ],
};

export const WINDOWS_ADVANCED: AdvancedPatterns = {
  privilege: [/\brunas\b/, /\bgsudo\b/, /Start-Process.*-Verb\s+RunAs/i, /-Verb\s+RunAs/i],
  install: [
    /\bwinget\s+install\b/,
    /\bchoco\s+install\b/,
    /\bscoop\s+install\b/,
    /\bpip\s+install\b/,
    /npm\s+install\s+-g\b/,
    /Install-Package\b/,
    /msiexec\s+\/i\b/,
  ],
  systemDirs: ['C:\\Windows', 'C:\\Program Files', 'C:\\ProgramData', 'HKLM'],
  dangerous: [
    /\bformat\s+[a-z]:/i,
    /\bdiskpart\b/,
    /shutdown\s+\/s\b/,
    /\breg\s+delete\b/i,
    /taskkill\s+\/f\b/i,
    /Remove-Item\s+.*-Recurse\b.*-Force\b/i,
    /Stop-Process\s+-Force\b/i,
    /Invoke-Expression\b/i,
    /\b(curl|iwr).*\|\s*(sh|bash|iex)\b/i,
  ],
};

export const ADVANCED_TABLES: Record<string, AdvancedPatterns> = {
  linux: LINUX_ADVANCED,
  darwin: DARWIN_ADVANCED,
  win32: WINDOWS_ADVANCED,
};

export const LINUX_DELETE = [
  /\brm\b/,
  /\brm\s+-[a-z]*r[a-z]*\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\btrash\b/,
  /\bfind\b.*\s-delete\b/,
];
export const DARWIN_DELETE = [
  /\brm\b/,
  /\brm\s+-[a-z]*r[a-z]*\b/,
  /\brmdir\b/,
  /\bunlink\b/,
  /\btrash\b/,
];
export const WINDOWS_DELETE = [
  /\bdel\b/i,
  /\bdel\s+\/[sfq]+\b/i,
  /\brmdir\b/i,
  /\bdeltree\b/i,
  /\berase\b/i,
  /\bRemove-Item\b/i,
  /\brd\b/i,
];

const unionAll = <T>(arrays: T[][]): T[] => [...new Set(arrays.flat())];
export const UNION_PRIVILEGE: RegExp[] = unionAll([
  LINUX_ADVANCED.privilege,
  DARWIN_ADVANCED.privilege,
  WINDOWS_ADVANCED.privilege,
]);
export const UNION_INSTALL: RegExp[] = unionAll([
  LINUX_ADVANCED.install,
  DARWIN_ADVANCED.install,
  WINDOWS_ADVANCED.install,
]);
export const UNION_DANGEROUS: RegExp[] = unionAll([
  LINUX_ADVANCED.dangerous,
  DARWIN_ADVANCED.dangerous,
  WINDOWS_ADVANCED.dangerous,
]);
export const UNION_DELETE: RegExp[] = unionAll([LINUX_DELETE, DARWIN_DELETE, WINDOWS_DELETE]);
export const UNION_SYSTEM_DIRS: string[] = [
  ...new Set([
    ...LINUX_ADVANCED.systemDirs,
    ...DARWIN_ADVANCED.systemDirs,
    ...WINDOWS_ADVANCED.systemDirs,
  ]),
];
