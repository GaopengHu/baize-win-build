/**
 * Natural-language description of a permission request.
 *
 * Pure renderer util — no DOM/IPC. Maps (toolName, input) to a single
 * human-readable sentence that omits raw command/JSON in favor of plain
 * intent, e.g. bash "sudo apt update" → "运行需要管理员权限的系统操作"。
 * Cross-platform intent detection reuses the shared pattern tables.
 */
import {
  UNION_DANGEROUS,
  UNION_DELETE,
  UNION_INSTALL,
  UNION_PRIVILEGE,
  UNION_SYSTEM_DIRS,
} from '../../shared/permission-patterns';

const COMMAND_TOOLS = new Set(['bash', 'execute_command', 'shell']);

const NETWORK_RE = /(?:^|\s)(?:curl|wget|iwr|Invoke-WebRequest)(?:\.exe)?\b/i;

function testAny(patterns: RegExp[], value: string): boolean {
  return patterns.some((re) => re.test(value));
}

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

function isSystemPath(path: string): boolean {
  const norm = path.toLowerCase();
  // Windows dirs arrive mixed-case ('C:\\Windows')
  return UNION_SYSTEM_DIRS.some((dir) => norm.startsWith(dir.toLowerCase()));
}

export type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

/**
 * 生成一句话自然语言确认文案。优先级：privilege > install > delete >
 * dangerous > network > runCommand > 路径类 > web > 未知工具 callTool。
 * 任何异常都兜底为「将调用外部功能」，绝不抛出。
 */
export function describePermission(
  toolName: string,
  input: Record<string, unknown>,
  t: TranslateFn
): string {
  const name = (toolName || '').toLowerCase();
  try {
    if (COMMAND_TOOLS.has(name)) {
      const command = extractCommand(input);
      if (command.trim().length > 0) {
        if (testAny(UNION_PRIVILEGE, command)) return t('permission.summary.privilege');
        if (testAny(UNION_INSTALL, command)) return t('permission.summary.install');
        if (testAny(UNION_DELETE, command)) return t('permission.summary.delete');
        if (testAny(UNION_DANGEROUS, command)) return t('permission.summary.dangerous');
        if (NETWORK_RE.test(command)) return t('permission.summary.network');
      }
      return t('permission.summary.runCommand');
    }

    const target = extractPath(input);
    if (name === 'write' || name === 'write_file') {
      return isSystemPath(target ?? '')
        ? t('permission.summary.writeSystemFile', { path: target ?? '' })
        : t('permission.summary.writeFile', { path: target ?? '' });
    }
    if (name === 'edit' || name === 'edit_file') {
      return isSystemPath(target ?? '')
        ? t('permission.summary.editSystemFile', { path: target ?? '' })
        : t('permission.summary.editFile', { path: target ?? '' });
    }
    if (name === 'read' || name === 'read_file') return t('permission.summary.readFile');
    if (name === 'glob') return t('permission.summary.glob');
    if (name === 'grep') return t('permission.summary.grep');
    if (name === 'list_directory') return t('permission.summary.listDirectory');
    if (name === 'webfetch') return t('permission.summary.webfetch');
    if (name === 'websearch') return t('permission.summary.webSearch');

    return t('permission.summary.callTool', { toolName: toolName || '' });
  } catch {
    return t('permission.summary.callTool', { toolName: toolName || '' });
  }
}
