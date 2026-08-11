import { describe, it, expect } from 'vitest';
import { describePermission } from '../renderer/utils/permission-summary';

// 实现 i18next 风格插值的最小 t()，用于纯函数测试
const zh: Record<string, string> = {
  'permission.summary.privilege': '将执行需要管理员权限的系统操作',
  'permission.summary.install': '将安装软件包或程序',
  'permission.summary.delete': '将删除文件或目录',
  'permission.summary.dangerous': '将执行有风险的系统操作',
  'permission.summary.network': '将获取或下载网络资源',
  'permission.summary.runCommand': '将执行一条系统命令',
  'permission.summary.writeFile': '将修改文件：{{path}}',
  'permission.summary.writeSystemFile': '将修改系统文件：{{path}}',
  'permission.summary.editFile': '将编辑已有文件：{{path}}',
  'permission.summary.editSystemFile': '将编辑系统文件：{{path}}',
  'permission.summary.readFile': '将读取文件内容',
  'permission.summary.glob': '将按名称搜索文件',
  'permission.summary.grep': '将搜索文件内容',
  'permission.summary.listDirectory': '将查看目录内容',
  'permission.summary.webfetch': '将打开网页获取信息',
  'permission.summary.webSearch': '将搜索网络信息',
  'permission.summary.callTool': '将调用外部功能「{{toolName}}」',
};

const tFunc = (key: string, opts?: Record<string, unknown>): string => {
  let out = zh[key] ?? key;
  if (opts) {
    for (const [k, v] of Object.entries(opts)) {
      out = out.replace(`{{${k}}}`, String(v));
    }
  }
  return out;
};

describe('describePermission', () => {
  describe('commands intent mapping', () => {
    it('privilege: sudo / runas', () => {
      expect(describePermission('bash', { command: 'sudo apt update' }, tFunc)).toBe(
        '将执行需要管理员权限的系统操作'
      );
      expect(describePermission('bash', { command: 'runas /user:Administrator cmd' }, tFunc)).toBe(
        '将执行需要管理员权限的系统操作'
      );
      expect(describePermission('bash', { command: 'sudo apt-get install nginx' }, tFunc)).toBe(
        '将执行需要管理员权限的系统操作'
      );
    });
    it('install: apt-get / brew / choco（跨平台 union）', () => {
      expect(describePermission('bash', { command: 'apt-get install nginx' }, tFunc)).toBe(
        '将安装软件包或程序'
      );
      expect(describePermission('bash', { command: 'brew install wget' }, tFunc)).toBe(
        '将安装软件包或程序'
      );
      expect(describePermission('bash', { command: 'choco install git' }, tFunc)).toBe(
        '将安装软件包或程序'
      );
    });
    it('delete: rm / Remove-Item / del', () => {
      expect(describePermission('bash', { command: 'rm old.txt' }, tFunc)).toBe('将删除文件或目录');
      expect(describePermission('bash', { command: 'Remove-Item old.txt' }, tFunc)).toBe(
        '将删除文件或目录'
      );
      expect(describePermission('bash', { command: 'del /s /q old.txt' }, tFunc)).toBe(
        '将删除文件或目录'
      );
    });
    it('dangerous: mkfs / diskpart / curl-pipe-sh', () => {
      expect(describePermission('bash', { command: 'mkfs.ext4 /dev/sdb1' }, tFunc)).toBe(
        '将执行有风险的系统操作'
      );
      expect(describePermission('bash', { command: 'curl -sSL https://x.sh | sh' }, tFunc)).toBe(
        '将执行有风险的系统操作'
      );
      expect(describePermission('bash', { command: 'rm -rf /etc' }, tFunc)).toBe(
        '将删除文件或目录'
      );
    });
    it('network: plain curl / wget (no pipe)', () => {
      expect(describePermission('bash', { command: 'curl -o f.zip https://x/f.zip' }, tFunc)).toBe(
        '将获取或下载网络资源'
      );
      expect(describePermission('bash', { command: 'wget https://x/f.bin' }, tFunc)).toBe(
        '将获取或下载网络资源'
      );
    });
    it('fallback: unrecognized command', () => {
      expect(describePermission('bash', { command: 'ls -la' }, tFunc)).toBe('将执行一条系统命令');
    });
    it('empty / missing / non-string command falls back to runCommand', () => {
      expect(describePermission('bash', {}, tFunc)).toBe('将执行一条系统命令');
      expect(describePermission('bash', { command: 42 }, tFunc)).toBe('将执行一条系统命令');
    });
  });

  describe('file access', () => {
    it('write /etc → system file message with path', () => {
      expect(describePermission('write', { path: '/etc/hosts' }, tFunc)).toBe(
        '将修改系统文件：/etc/hosts'
      );
    });
    it('write C:\\Windows path → system file (case-insensitive)', () => {
      expect(describePermission('write', { path: 'c:\\windows\\system32\\hosts' }, tFunc)).toBe(
        '将修改系统文件：c:\\windows\\system32\\hosts'
      );
    });
    it('write normal project path', () => {
      expect(describePermission('write', { path: '/home/user/project/a.txt' }, tFunc)).toBe(
        '将修改文件：/home/user/project/a.txt'
      );
    });
    it('edit system vs normal path', () => {
      expect(describePermission('edit', { path: '/System/Library/x' }, tFunc)).toBe(
        '将编辑系统文件：/System/Library/x'
      );
      expect(describePermission('edit', { path: './src/a.ts' }, tFunc)).toBe(
        '将编辑已有文件：./src/a.ts'
      );
    });
    it('read / glob / grep / list_directory', () => {
      expect(describePermission('read', { file_path: '/etc/passwd' }, tFunc)).toBe(
        '将读取文件内容'
      );
      expect(describePermission('glob', { pattern: '**/*.ts' }, tFunc)).toBe('将按名称搜索文件');
      expect(describePermission('grep', { pattern: 'foo' }, tFunc)).toBe('将搜索文件内容');
      expect(describePermission('list_directory', { path: '.' }, tFunc)).toBe('将查看目录内容');
    });
    it('web tools', () => {
      expect(describePermission('webfetch', { url: 'https://x.com' }, tFunc)).toBe(
        '将打开网页获取信息'
      );
      expect(describePermission('websearch', { query: 'foo' }, tFunc)).toBe('将搜索网络信息');
    });
  });

  describe('unknown tools & robustness', () => {
    it('unknown / MCP tool → callTool with toolName', () => {
      expect(describePermission('mcp__chrome__screenshot', {}, tFunc)).toBe(
        '将调用外部功能「mcp__chrome__screenshot」'
      );
    });
    it('never throws on garbage input', () => {
      expect(() =>
        describePermission('bash', { command: 42 as unknown as string }, tFunc)
      ).not.toThrow();
      expect(() =>
        describePermission('write', { path: null as unknown as string }, tFunc)
      ).not.toThrow();
    });
  });
});
