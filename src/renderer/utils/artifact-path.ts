import { resolvePathAgainstWorkspace } from '../../shared/workspace-path';

function cwdBaseName(cwd: string): string {
  const normalized = cwd.replace(/[/\\]+$/, '').replace(/\\/g, '/');
  return (normalized.split('/').pop() || '').toLowerCase();
}

export function resolveArtifactPath(pathValue: string, cwd?: string | null): string {
  const normalized = (pathValue || '').trim();
  // 嵌套默认目录回收（与主进程 reveal/checkPaths 对齐）：
  // "default_working_dir/outputs/a.pdf" 或 "<cwd>/default_working_dir/outputs/a.pdf"
  // 这类模型手拼路径，相对 cwd 解析必定落空。cwd 本身通常就已经是
  // .../default_working_dir，直接把冗余的那段掐掉再拼。
  if (cwd && /default_working_dir/i.test(normalized)) {
    if (cwdBaseName(cwd) === 'default_working_dir') {
      const stripped = normalized.replace(/^.*default_working_dir[/\\]+/i, '');
      if (stripped && stripped !== normalized) {
        return resolvePathAgainstWorkspace(stripped, cwd);
      }
    }
  }
  return resolvePathAgainstWorkspace(pathValue, cwd);
}
