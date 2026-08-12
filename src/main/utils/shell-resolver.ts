import { platform } from 'os'
import { detectCommandTools } from './detect-command-tools'

let cachedDefaultShell: string | null = null

const SHELL_PRIORITY_WIN = ['powershell.exe', 'pwsh.exe', 'bash.exe', 'cmd.exe']

/**
 * Returns the appropriate shell for the current platform.
 * Windows: detects available shells at runtime, prefers PowerShell (has Unix
 *          command aliases), falls back to cmd.exe if nothing else is found.
 * Unix: uses SHELL env var or falls back to /bin/bash
 */
export function getDefaultShell(): string {
  if (cachedDefaultShell) return cachedDefaultShell

  if (platform() === 'win32') {
    const detected = detectCommandTools()
    for (const shell of SHELL_PRIORITY_WIN) {
      if (detected.shells.includes(shell)) {
        cachedDefaultShell = shell
        return cachedDefaultShell
      }
    }
    cachedDefaultShell = process.env.COMSPEC || 'cmd.exe'
    return cachedDefaultShell
  }

  cachedDefaultShell = process.env.SHELL || '/bin/bash'
  return cachedDefaultShell
}

/**
 * Returns shell execution arguments for running a command string.
 * Windows cmd: ['/c', command]
 * Unix bash/zsh: ['-c', command]
 */
export function getShellArgs(command: string): [string, string[]] {
  const shell = getDefaultShell()
  if (platform() === 'win32') {
    return [shell, ['/c', command]]
  }
  return [shell, ['-c', command]]
}

/**
 * Escape special characters in a command string for Windows shells.
 * - PowerShell: escapes `$` and `` ` `` with backtick
 * - cmd.exe: escapes `^`, `&`, `|`, `<`, `>`, `(`, `)` with caret
 * - Both: wraps paths containing spaces in double quotes
 */
export function escapeWinCommand(command: string, shell?: string): string {
  const s = (shell || getDefaultShell()).toLowerCase()
  const isPowerShell = s.includes('powershell') || s === 'pwsh.exe' || s === 'pwsh'
  const isCmd = s === 'cmd' || s === 'cmd.exe'

  let result = command

  if (isPowerShell) {
    // Escape $ and ` with backtick (PowerShell escape char)
    // Only escape $ when not followed by valid variable chars to avoid breaking $env:VAR
    result = result.replace(/`/g, '``')
    // Escape $ only when it's a literal $ (not $ followed by variable name chars)
    result = result.replace(/\$(?![a-zA-Z_0-9:{(\[\]])/g, '`$')
  }

  if (isCmd) {
    // Escape special chars with caret (^) for cmd.exe
    // Order matters: ^ must be first
    result = result.replace(/\^/g, '^^')
    result = result.replace(/&/g, '^&')
    result = result.replace(/\|/g, '^|')
    result = result.replace(/</g, '^<')
    result = result.replace(/>/g, '^>')
    result = result.replace(/\(/g, '^(')
    result = result.replace(/\)/g, '^)')
  }

  return result
}
