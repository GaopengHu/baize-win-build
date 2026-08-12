# 权限确认优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作目录内普通文件读写/命令执行免确认；仅高级权限（sudo/安装/系统目录/危险命令）、删除、工作目录外文件需要人工确认；弹窗新增「允许本会话全部操作」（不豁免高级权限），信任仅当前会话生效。

**Architecture:** 新增纯函数模块 `permission-classifier.ts`（命令/路径分类 + 决策门），在 `agent-runner` 的权限 hook 中先行分类再走规则；`SessionManager` 维护会话级 allowAll 集合；`PermissionDialog` 按分类显示三/四按钮并增加分级告警文案。决策逻辑全部收敛为可单测的纯函数。

**Tech Stack:** TypeScript, vitest, Electron 22, pi-coding-agent SDK

**Spec:** `docs/superpowers/specs/2026-08-09-permission-classifier-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/main/utils/permission-classifier.ts`（新建）| `classifyPermission()` 分类 + `resolvePermissionGate()` 决策门（纯函数）|
| `src/main/session/session-manager.ts`（修改）| `sessionAllowAll` 集合、`pendingPermissions` 记录 sessionId、`requestPermission` 透传 kind、handlePermissionResponse 支持 allowAll、清理同步、AgentRunnerOptions 注入 |
| `src/main/claude/agent-runner.ts`（修改）| hook 内调用 classify + gate，`requestPermission` 传 kind 与 cwd |
| `src/main/index.ts`（修改）| `permission.response` 透传 allowAll |
| `src/renderer/types/index.ts`（修改）| `PermissionKind`、`PermissionRequest.kind`、ClientEvent 增加 allowAll |
| `src/renderer/hooks/useIPC.ts`（修改）| `respondToPermission` 支持 allowAll |
| `src/renderer/components/PermissionDialog.tsx`（修改）| 三/四按钮分支 + 分级告警 |
| `src/renderer/store/index.ts`（修改）| 默认规则 write/edit/bash → allow |
| `src/main/config/permission-rules-store.ts`（修改）| 默认规则同步 |
| `src/renderer/i18n/locales/zh.json`、`en.json`（修改）| 新增文案 |
| `src/tests/permission-classifier.test.ts`（新建）| 分类器测试 |

**注意**：提交时必须用 `git commit --no-verify`（本环境 lint-staged 与 git 2.20.1 不兼容），并先手动运行 `npx eslint --fix` / `npx prettier --write` 于暂存文件。

---

### Task 1: permission-classifier 分类函数（TDD）

**Files:**
- Create: `src/main/utils/permission-classifier.ts`
- Test: `src/tests/permission-classifier.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/tests/permission-classifier.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { classifyPermission } from '../main/utils/permission-classifier';

const CWD = '/home/user/project';

describe('classifyPermission', () => {
  describe('advanced: privilege escalation', () => {
    it('detects sudo on linux', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'sudo apt update' }).kind).toBe('advanced');
    });
    it('detects runas on windows', () => {
      expect(classifyPermission('C:\\work', 'bash', { command: 'runas /user:Administrator cmd' }).kind).toBe('advanced');
    });
    it('does not flag plain commands', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'ls -la' }).kind).toBe('normal');
    });
  });

  describe('advanced: package installation', () => {
    it('detects apt install', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'apt install nginx' }).kind).toBe('advanced');
    });
    it('detects brew install on darwin', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'brew install wget' }).kind).toBe('advanced');
    });
    it('detects npm install -g', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'npm install -g typescript' }).kind).toBe('advanced');
    });
    it('detects choco install on windows', () => {
      expect(classifyPermission('C:\\work', 'bash', { command: 'choco install git' }).kind).toBe('advanced');
    });
  });

  describe('advanced: dangerous commands', () => {
    it('detects rm -rf on system paths', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'rm -rf /etc' }).kind).toBe('advanced');
    });
    it('detects mkfs', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'mkfs.ext4 /dev/sdb1' }).kind).toBe('advanced');
    });
    it('detects curl pipe sh', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'curl -sSL https://x.sh | sh' }).kind).toBe('advanced');
    });
    it('detects Remove-Item -Recurse -Force on windows', () => {
      expect(classifyPermission('C:\\work', 'bash', { command: 'Remove-Item -Recurse -Force C:\\Windows\\temp' }).kind).toBe('advanced');
    });
  });

  describe('advanced: system directory writes via write tool', () => {
    it('detects /etc path on linux', () => {
      expect(classifyPermission(CWD, 'write', { path: '/etc/hosts' }).kind).toBe('advanced');
    });
    it('detects C:\\Windows path on windows', () => {
      expect(classifyPermission('C:\\work', 'write', { path: 'C:\\Windows\\system32\\hosts' }).kind).toBe('advanced');
    });
    it('allows cwd-internal write', () => {
      expect(classifyPermission(CWD, 'write', { path: '/home/user/project/a.txt' }).kind).toBe('normal');
    });
  });

  describe('delete', () => {
    it('flags rm even inside cwd', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'rm old.txt' }).kind).toBe('delete');
    });
    it('flags rm -rf', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'rm -rf build' }).kind).toBe('delete');
    });
    it('flags del on windows cmd', () => {
      expect(classifyPermission('C:\\work', 'bash', { command: 'del /s /q old.txt' }).kind).toBe('delete');
    });
    it('flags Remove-Item plain (no recurse/force)', () => {
      expect(classifyPermission('C:\\work', 'bash', { command: 'Remove-Item old.txt' }).kind).toBe('delete');
    });
    it('flags rmdir on linux', () => {
      expect(classifyPermission(CWD, 'bash', { command: 'rmdir emptydir' }).kind).toBe('delete');
    });
  });

  describe('outside', () => {
    it('flags read outside cwd', () => {
      expect(classifyPermission(CWD, 'read', { file_path: '/etc/passwd' }).kind).toBe('outside');
    });
    it('allows read inside cwd subtree', () => {
      expect(classifyPermission(CWD, 'read', { file_path: '/home/user/project/src/a.ts' }).kind).toBe('normal');
    });
    it('flags path escaping via ..', () => {
      expect(classifyPermission(CWD, 'read', { file_path: '/home/user/project/../../etc/passwd' }).kind).toBe('outside');
    });
    it('flags windows path outside cwd (case-insensitive)', () => {
      expect(classifyPermission('C:\\work', 'read', { file_path: 'c:\\Users\\other\\a.txt' }).kind).toBe('outside');
    });
    it('allows windows path inside cwd (case-insensitive)', () => {
      expect(classifyPermission('C:\\Work', 'read', { file_path: 'C:\\work\\src\\a.ts' }).kind).toBe('normal');
    });
    it('flags UNC path outside cwd', () => {
      expect(classifyPermission('C:\\work', 'read', { file_path: '\\\\server\\share\\a.txt' }).kind).toBe('outside');
    });
    it('flags write outside cwd', () => {
      expect(classifyPermission(CWD, 'write', { path: '/tmp/out.txt' }).kind).toBe('outside');
    });
  });

  describe('priority', () => {
    it('advanced wins over delete when both match', () => {
      // sudo rm -rf /etc — sudo → advanced (delete would also match)
      expect(classifyPermission(CWD, 'bash', { command: 'sudo rm -rf /etc' }).kind).toBe('advanced');
    });
    it('delete wins over outside', () => {
      // removing a file outside cwd → delete (more specific risk)
      expect(classifyPermission(CWD, 'bash', { command: 'rm /etc/passwd' }).kind).toBe('delete');
    });
  });

  describe('error handling', () => {
    it('invalid path input falls back to outside (conservative)', () => {
      expect(classifyPermission(CWD, 'read', { file_path: ':::bad:::' }).kind).toBe('outside');
    });
    it('null cwd with absolute path → outside', () => {
      expect(classifyPermission(null, 'read', { file_path: '/tmp/x' }).kind).toBe('outside');
    });
    it('null cwd with relative path → normal', () => {
      expect(classifyPermission(null, 'read', { file_path: 'a.txt' }).kind).toBe('normal');
    });
    it('classifier never throws on garbage input', () => {
      expect(() => classifyPermission(CWD, 'bash', { command: 42 as unknown as string }).kind).not.toThrow();
      expect(() => classifyPermission(CWD, 'read', { file_path: null as unknown as string }).kind).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/tests/permission-classifier.test.ts`
Expected: FAIL — `Cannot find module '../main/utils/permission-classifier'`

- [ ] **Step 3: 实现 `permission-classifier.ts`**

创建 `src/main/utils/permission-classifier.ts`：

```ts
/**
 * @module main/utils/permission-classifier
 *
 * Classifies a tool request into a permission kind so the permission gate
 * can auto-allow safe in-workspace operations and only interrupt the user
 * for elevated / destructive / out-of-workspace actions.
 *
 * Pure functions only — no IPC, no Electron. Platform-agnostic rule tables
 * are indexed by `process.platform` at call time (tests may pass a custom
 * platform via `classifyPermissionForPlatform`).
 */
import * as path from 'path';
import * as fs from 'fs';

export type PermissionKind = 'advanced' | 'delete' | 'outside' | 'normal';

export interface ClassificationResult {
  kind: PermissionKind;
  reason?: string;
}

type Platform = 'linux' | 'darwin' | 'win32' | string;

interface AdvancedPatterns {
  privilege: RegExp[];
  install: RegExp[];
  systemDirs: string[];
  dangerous: RegExp[];
}

const LINUX_ADVANCED: AdvancedPatterns = {
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
  ],
};

const DARWIN_ADVANCED: AdvancedPatterns = {
  privilege: [/\bsudo\b/, /\bsudo\s+-s\b/],
  install: [/\bbrew\s+install\b/, /\bpip3?\s+install\b/, /\bnpm\s+install\b/, /\bgem\s+install\b/],
  systemDirs: ['/etc', '/usr', '/var', '/System', '/Applications'],
  dangerous: [
    ...LINUX_ADVANCED.dangerous,
    /\bdiskutil\s+eraseDisk\b/,
    /osascript.*System\s+Events/,
  ],
};

const WINDOWS_ADVANCED: AdvancedPatterns = {
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

const ADVANCED_TABLES: Record<string, AdvancedPatterns> = {
  linux: LINUX_ADVANCED,
  darwin: DARWIN_ADVANCED,
  win32: WINDOWS_ADVANCED,
};

const DELETE_PATTERNS: Record<string, RegExp[]> = {
  linux: [/\brm\b/, /\brm\s+-[a-z]*r[a-z]*\b/, /\brmdir\b/, /\bunlink\b/, /\btrash\b/, /\bfind\b.*\s-delete\b/],
  darwin: [/\brm\b/, /\brm\s+-[a-z]*r[a-z]*\b/, /\brmdir\b/, /\bunlink\b/, /\btrash\b/],
  win32: [
    /\bdel\b/i,
    /\bdel\s+\/[sfq]+\b/i,
    /\brmdir\b/i,
    /\bdeltree\b/i,
    /\berase\b/i,
    /\bRemove-Item\b/i,
    /\brd\b/i,
  ],
};

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

/** Detect advanced / delete patterns in a shell command string. */
function classifyCommand(command: string, platform: string): ClassificationResult | null {
  if (!command || command.trim().length === 0) return null;
  const table = ADVANCED_TABLES[platform] ?? LINUX_ADVANCED;
  const matches = (patterns: RegExp[]) => patterns.some((re) => re.test(command));
  if (matches(table.privilege) || matches(table.install) || matches(table.dangerous)) {
    return { kind: 'advanced', reason: 'command matches elevated/installation/dangerous patterns' };
  }
  const deletePatterns = DELETE_PATTERNS[platform] ?? DELETE_PATTERNS.linux;
  if (matches(deletePatterns)) return { kind: 'delete', reason: 'command deletes files' };
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

  const table = ADVANCED_TABLES[platform] ?? LINUX_ADVANCED;
  const isWin = platform === 'win32';
  const norm = (s: string) => (isWin ? s.toLowerCase() : s);

  for (const dir of table.systemDirs) {
    if (norm(target).startsWith(norm(dir))) {
      return { kind: 'advanced', reason: `path is in system directory: ${dir}` };
    }
  }

  if (cwd) {
    const inside = isPathInside(cwd, target, platform);
    if (inside) return { kind: 'normal', reason: 'path is inside the session working directory' };
    return { kind: 'outside', reason: 'path is outside the session working directory' };
  }

  // No cwd: relative paths are presumed in-workspace; absolute are outside.
  return isWin ? /^[a-zA-Z]:[\\/]/.test(target) || target.startsWith('\\\\') : target.startsWith('/')
    ? { kind: 'outside', reason: 'absolute path with no session cwd' }
    : { kind: 'normal', reason: 'relative path with no session cwd' };
}

/**
 * Classify a tool request. Priority: advanced > delete > outside > normal.
 */
export function classifyPermission(
  cwd: string | null,
  toolName: string,
  input: Record<string, unknown>
): ClassificationResult {
  return classifyPermissionForPlatform(cwd, toolName, input, process.platform);
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
      const fromCommand = classifyCommand(extractCommand(input), platform);
      if (fromCommand) return fromCommand;
    } catch {
      return { kind: 'normal', reason: 'command classification failed; falling back to normal' };
    }
  }

  if (PATH_TOOLS.has(lowered)) {
    try {
      return classifyPath(cwd, lowered, input, platform);
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tests/permission-classifier.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/utils/permission-classifier.ts src/tests/permission-classifier.test.ts
npx eslint --fix src/main/utils/permission-classifier.ts src/tests/permission-classifier.test.ts
npx prettier --write src/main/utils/permission-classifier.ts src/tests/permission-classifier.test.ts
git commit --no-verify -m "feat: add permission classifier and decision gate (pure functions)"
```

---

### Task 2: 默认规则调整（write/edit/bash → allow）

**Files:**
- Modify: `src/main/config/permission-rules-store.ts:19-28`
- Modify: `src/renderer/store/index.ts:207-214`
- Modify: `src/tests/config/permission-rules-store.test.ts:44-50`

- [ ] **Step 1: 更新 main 侧默认规则**

在 `src/main/config/permission-rules-store.ts` 将 DEFAULT_RULES 改为：

```ts
const DEFAULT_RULES: PermissionRule[] = [
  { tool: 'read', action: 'allow' },
  { tool: 'glob', action: 'allow' },
  { tool: 'grep', action: 'allow' },
  { tool: 'ls', action: 'allow' },
  { tool: 'find', action: 'allow' },
  // In-workspace normal operations are auto-allowed; elevated / delete /
  // out-of-workspace requests are intercepted by the permission classifier.
  { tool: 'write', action: 'allow' },
  { tool: 'edit', action: 'allow' },
  { tool: 'bash', action: 'allow' },
];
```

- [ ] **Step 2: 更新 renderer 默认规则**

在 `src/renderer/store/index.ts:207-214` 同样改为上表的 write/edit/bash → allow。

- [ ] **Step 3: 更新规则测试**

在 `src/tests/config/permission-rules-store.test.ts` 中：

- 将 `'returns ask for default-ask bash tool'` 测试改为：

```ts
it('returns allow for default-allow bash tool (classifier gates risk)', () => {
  expect(decidePermission(SESSION_A, 'bash', { command: 'ls' })).toBe('allow');
});
```

- 将 `'returns ask for default-ask write tool'` 测试改为：

```ts
it('returns allow for default-allow write tool (classifier gates risk)', () => {
  expect(decidePermission(SESSION_A, 'write', { path: '/etc/passwd' })).toBe('allow');
});
```

- 第 58 行 `expect(decidePermission(SESSION_A, 'BaSh', { command: 'ls' })).toBe('ask');` 改为 `toBe('allow')`
- 第 181/187/196 行（fail-safe 部分）的 `bash → ask` 断言改为 `bash → allow`

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/tests/config/permission-rules-store.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main/config/permission-rules-store.ts src/renderer/store/index.ts src/tests/config/permission-rules-store.test.ts
npx prettier --write src/main/config/permission-rules-store.ts src/renderer/store/index.ts src/tests/config/permission-rules-store.test.ts
git commit --no-verify -m "feat: default-allow write/edit/bash; classifier gates elevated/delete/outside"
```

---

### Task 3: 类型与 IPC 协议扩展

**Files:**
- Modify: `src/renderer/types/index.ts`
- Modify: `src/renderer/hooks/useIPC.ts:732-741`
- Modify: `src/main/index.ts:2771-2772`

- [ ] **Step 1: 扩展类型**

在 `src/renderer/types/index.ts` 的 `PermissionRequest` 前新增：

```ts
export type PermissionKind = 'advanced' | 'delete' | 'outside' | 'normal';
```

将 `PermissionRequest` 改为：

```ts
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  sessionId: string;
  kind?: PermissionKind;
}
```

将 ClientEvent 的 `permission.response` 改为：

```ts
| {
    type: 'permission.response';
    payload: { toolUseId: string; result: PermissionResult; allowAll?: boolean };
  }
```

- [ ] **Step 2: useIPC 透传 allowAll**

在 `src/renderer/hooks/useIPC.ts` 将 `respondToPermission` 改为：

```ts
const respondToPermission = useCallback(
  (toolUseId: string, result: PermissionResult, allowAll?: boolean) => {
    send({
      type: 'permission.response',
      payload: { toolUseId, result, allowAll },
    });
    setPendingPermission(null);
  },
  [send, setPendingPermission]
);
```

- [ ] **Step 3: main 透传 allowAll**

在 `src/main/index.ts:2771` 改为：

```ts
case 'permission.response':
  return sm.handlePermissionResponse(
    event.payload.toolUseId,
    event.payload.result,
    event.payload.allowAll
  );
```

- [ ] **Step 4: typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 5: 提交**

```bash
git add src/renderer/types/index.ts src/renderer/hooks/useIPC.ts src/main/index.ts
git commit --no-verify -m "feat: extend permission IPC with kind and allowAll"
```

---

### Task 4: SessionManager 会话级 allowAll + requestPermission kind

**Files:**
- Modify: `src/main/session/session-manager.ts`

- [ ] **Step 1: 新增 sessionAllowAll 集合与访问器**

在 `src/main/session/session-manager.ts` 中 `pendingPermissions` 声明（第 83 行）附近新增：

```ts
private pendingPermissions: Map<string, { sessionId: string; resolve: (result: PermissionResult) => void }> = new Map();
/** Session-scoped "allow all non-elevated operations" flag (renderer button). */
private sessionAllowAll = new Set<string>();

setSessionAllowAll(sessionId: string, enabled: boolean): void {
  if (enabled) {
    this.sessionAllowAll.add(sessionId);
  } else {
    this.sessionAllowAll.delete(sessionId);
  }
}

hasSessionAllowAll(sessionId: string): boolean {
  return this.sessionAllowAll.has(sessionId);
}
```

- [ ] **Step 2: requestPermission 记录 sessionId 并透传 kind**

将 `requestPermission`（第 1196-1217 行）改为：

```ts
async requestPermission(
  sessionId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  kind?: 'advanced' | 'delete' | 'outside' | 'normal'
): Promise<PermissionResult> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      this.pendingPermissions.delete(toolUseId);
      resolve('deny');
      this.sendToRenderer({ type: 'permission.dismiss', payload: { toolUseId } });
    }, 60_000);
    this.pendingPermissions.set(toolUseId, {
      sessionId,
      resolve: (result: PermissionResult) => {
        clearTimeout(timeoutId);
        resolve(result);
      },
    });
    this.sendToRenderer({
      type: 'permission.request',
      payload: { toolUseId, toolName, input, sessionId, kind },
    });
  });
}
```

- [ ] **Step 3: handlePermissionResponse 支持 allowAll**

将 `handlePermissionResponse`（第 1187-1193 行）改为：

```ts
handlePermissionResponse(toolUseId: string, result: PermissionResult, allowAll?: boolean): void {
  const pending = this.pendingPermissions.get(toolUseId);
  if (pending) {
    if (allowAll) {
      this.setSessionAllowAll(pending.sessionId, true);
      log('[SessionManager] Session allow-all enabled:', pending.sessionId);
    }
    this.pendingPermissions.delete(toolUseId);
    pending.resolve(result);
  }
}
```

- [ ] **Step 4: 会话清理时同步清除 allowAll**

在第 982 行与 1010 行的 `forgetSessionPermissions(sessionId)` 之后各加一行：

```ts
this.setSessionAllowAll(sessionId, false);
```

- [ ] **Step 5: 注入 AgentRunnerOptions**

在 `createClaudeAgentRunner`（第 134-154 行）的 options 中新增：

```ts
requestPermission: (
  sessionId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  kind?: 'advanced' | 'delete' | 'outside' | 'normal'
) => this.requestPermission(sessionId, toolUseId, toolName, input, kind),
sessionAllowAll: (sessionId: string) => this.hasSessionAllowAll(sessionId),
```

- [ ] **Step 6: typecheck**

Run: `npm run typecheck`
Expected: no errors（agent-runner 接口暂未匹配会报错，Task 5 修复，可先确认报错仅来自接口签名）

- [ ] **Step 7: 提交**

```bash
git add src/main/session/session-manager.ts
npx prettier --write src/main/session/session-manager.ts
git commit --no-verify -m "feat: session-scoped allow-all flag and permission request kind passthrough"
```

---

### Task 5: agent-runner hook 集成分类器

**Files:**
- Modify: `src/main/claude/agent-runner.ts`

- [ ] **Step 1: 扩展 AgentRunnerOptions 接口**

在 `src/main/claude/agent-runner.ts` 的 `AgentRunnerOptions` 接口（第 522-536 行）中，`requestPermission` 签名改为：

```ts
requestPermission?: (
  sessionId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  kind?: 'advanced' | 'delete' | 'outside' | 'normal'
) => Promise<'allow' | 'deny' | 'allow_always'>;
sessionAllowAll?: (sessionId: string) => boolean;
```

同步修改类内私有字段声明（第 563-568 行附近）与构造函数赋值。

- [ ] **Step 2: 导入分类器**

在 import 区（第 28 行 `rememberAlwaysAllow` 之后）新增：

```ts
import { classifyPermission, resolvePermissionGate } from '../utils/permission-classifier';
```

- [ ] **Step 3: installPermissionHook 增加 sessionCwd 参数与分类逻辑**

将 `installPermissionHook(piSession: PiAgentSession, sessionId: string)` 签名改为：

```ts
private installPermissionHook(piSession: PiAgentSession, sessionId: string, sessionCwd: string | null): void {
```

将 hook 内部（第 961 行起）替换为：

```ts
const sessionAllowAll = this.optionsAllowAll?.call(this, sessionId) ?? false;
const { kind, reason } = classifyPermission(sessionCwd, toolName, input);
const decision = decidePermission(sessionId, toolName, input);
const gate = resolvePermissionGate(kind, decision, sessionAllowAll);

if (gate === 'deny') {
  log(`[ClaudeAgentRunner] Tool '${toolName}' denied by rule`);
  return {
    block: true,
    reason: `Tool '${displayName}' is denied by your permission rules.`,
  };
}

if (gate === 'ask') {
  const toolUseId = `${ctx.toolCall?.id ?? 'unknown'}-perm-${uuidv4().slice(0, 8)}`;
  let result: 'allow' | 'deny' | 'allow_always';
  try {
    result = await requestPermission(sessionId, toolUseId, displayName, input, kind);
  } catch (permErr) {
    logError(
      `[ClaudeAgentRunner] Permission request failed for '${toolName}' — failing closed`,
      permErr
    );
    return {
      block: true,
      reason: `Permission request failed for '${displayName}'; tool not executed.`,
    };
  }

  if (result === 'deny') {
    log(`[ClaudeAgentRunner] Tool '${toolName}' denied by user`);
    return { block: true, reason: `User denied permission for '${displayName}'.` };
  }

  if (result === 'allow_always') {
    rememberAlwaysAllow(sessionId, toolName);
  }
}

log(`[ClaudeAgentRunner] Permission gate allowed '${toolName}' (${kind}${reason ? `: ${reason}` : ''})`);
// Allowed — delegate to SDK's original hook for event pipeline
return sdkBeforeToolCall ? sdkBeforeToolCall(ctx, signal) : undefined;
```

在类内新增字段（hook 需要读取 options.sessionAllowAll，保存在 `installPermissionHook` 前）：

```ts
private optionsAllowAll?: (sessionId: string) => boolean;
```

并在构造函数中赋值 `this.optionsAllowAll = options.sessionAllowAll;`。

- [ ] **Step 4: 更新 hook 调用点**

将第 2303 行：

```ts
this.installPermissionHook(piSession, session.id);
```

改为：

```ts
this.installPermissionHook(piSession, session.id, session.cwd ?? null);
```

- [ ] **Step 5: typecheck + 相关测试**

Run: `npm run typecheck && npx vitest run src/tests/claude`
Expected: PASS（若 agent-runner 相关旧测试因签名变化报错，同步修复测试中的构造参数）

- [ ] **Step 6: 提交**

```bash
git add src/main/claude/agent-runner.ts
npx eslint --fix src/main/claude/agent-runner.ts
npx prettier --write src/main/claude/agent-runner.ts
git commit --no-verify -m "feat: integrate permission classifier into agent-runner hook"
```

---

### Task 6: PermissionDialog 三/四按钮 + 分级告警

**Files:**
- Modify: `src/renderer/components/PermissionDialog.tsx`
- Modify: `src/renderer/i18n/locales/zh.json`
- Modify: `src/renderer/i18n/locales/en.json`

- [ ] **Step 1: 新增 i18n 文案**

`zh.json` 的 `permission` 节点内新增：

```json
"allowAllSession": "允许本会话全部操作",
"allowAllSessionDesc": "放行本会话内的工作目录外文件操作。高级权限与删除操作仍会单独确认。",
"advancedWarning": "此操作需要高级权限（提权/安装/系统目录/危险命令），请仔细确认。",
"deleteWarning": "此操作将删除文件，无法撤销。",
"outsideWarning": "此操作涉及工作目录之外的文件。"
```

`en.json` 的 `permission` 节点内新增：

```json
"allowAllSession": "Allow all operations this session",
"allowAllSessionDesc": "Allow out-of-workspace file operations for this session. Elevated and delete operations are still confirmed individually.",
"advancedWarning": "This action requires elevated privileges (sudo/install/system directories/dangerous commands). Review carefully.",
"deleteWarning": "This action deletes files and cannot be undone.",
"outsideWarning": "This action touches files outside the working directory."
```

- [ ] **Step 2: 改造 PermissionDialog**

将 `src/renderer/components/PermissionDialog.tsx` 替换为：

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIPC } from '../hooks/useIPC';
import type { PermissionRequest } from '../types';
import { Shield, X, Check, AlertTriangle } from 'lucide-react';

interface PermissionDialogProps {
  permission: PermissionRequest;
}

function getWarningKey(kind?: 'advanced' | 'delete' | 'outside' | 'normal'): string | null {
  if (kind === 'advanced') return 'permission.advancedWarning';
  if (kind === 'delete') return 'permission.deleteWarning';
  if (kind === 'outside') return 'permission.outsideWarning';
  return null;
}

export function PermissionDialog({ permission }: PermissionDialogProps) {
  const { t } = useTranslation();
  const { respondToPermission } = useIPC();
  const [pendingAlwaysAllow, setPendingAlwaysAllow] = useState(false);

  const getToolDescription = (toolName: string): string => {
    const key = `permission.toolDescriptions.${toolName}`;
    const translated = t(key);
    if (translated !== key) {
      return translated;
    }
    return t('permission.useTool', { toolName });
  };

  // Elevated / delete requests never offer the session allow-all shortcut.
  const isElevatedOnly = permission.kind === 'advanced' || permission.kind === 'delete';
  const isHighRisk = isElevatedOnly || [
    'bash',
    'write',
    'edit',
    'execute_command',
    'write_file',
    'edit_file',
  ].includes(permission.toolName);
  const warningKey = getWarningKey(permission.kind);

  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
      <div className="card w-full max-w-md p-6 m-4 shadow-elevated animate-slide-up">
        {/* Header */}
        <div className="flex items-start gap-4">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isHighRisk ? 'bg-warning/10' : 'bg-accent-muted'
            }`}
          >
            {isHighRisk ? (
              <AlertTriangle className="w-6 h-6 text-warning" />
            ) : (
              <Shield className="w-6 h-6 text-accent" />
            )}
          </div>

          <div className="flex-1">
            <h2 className="text-lg font-semibold text-text-primary">
              {t('permission.permissionRequired')}
            </h2>
            <p className="text-sm text-text-secondary mt-1">
              {getToolDescription(permission.toolName)}
            </p>
          </div>
        </div>

        {/* Tool Details */}
        <div className="mt-4 p-4 bg-surface-muted rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-medium text-text-primary">{t('permission.tool')}</span>
            <span className="font-mono text-accent text-sm">{permission.toolName}</span>
          </div>

          <div className="text-sm text-text-secondary">
            <span className="font-medium text-text-primary">{t('permission.input')}</span>
            <pre className="mt-1 text-xs code-block max-h-32 overflow-auto">
              {JSON.stringify(permission.input, null, 2)}
            </pre>
          </div>
        </div>

        {/* Warning (kind-specific) */}
        {warningKey && (
          <div className="mt-4 p-3 bg-warning/10 border border-warning/20 rounded-xl">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
              <p className="text-sm text-warning">{t(warningKey)}</p>
            </div>
          </div>
        )}
        {!warningKey && isHighRisk && (
          <div className="mt-4 p-3 bg-warning/10 border border-warning/20 rounded-xl">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
              <p className="text-sm text-warning">{t('permission.warning')}</p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={() => respondToPermission(permission.toolUseId, 'deny')}
            className="flex-1 btn btn-secondary"
          >
            <X className="w-4 h-4" />
            {t('permission.deny')}
          </button>

          <button
            onClick={() => respondToPermission(permission.toolUseId, 'allow')}
            className="flex-1 btn btn-primary"
          >
            <Check className="w-4 h-4" />
            {t('permission.allow')}
          </button>
        </div>

        {/* Always Allow option */}
        {!pendingAlwaysAllow ? (
          <button
            onClick={() => {
              const dangerousTools = ['bash', 'write', 'edit', 'execute_command'];
              const isDangerous = dangerousTools.some((tool) =>
                permission.toolName?.toLowerCase().includes(tool)
              );
              if (isDangerous) {
                setPendingAlwaysAllow(true);
              } else {
                respondToPermission(permission.toolUseId, 'allow_always');
              }
            }}
            className="w-full mt-2 btn btn-ghost text-sm"
          >
            {t('permission.alwaysAllow')}
          </button>
        ) : (
          <div className="mt-2 p-3 bg-warning/10 border border-warning/20 rounded-xl">
            <p className="text-sm text-warning mb-2">
              {`Are you sure you want to always allow "${permission.toolName}"? This tool can modify your system.`}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPendingAlwaysAllow(false)}
                className="flex-1 btn btn-secondary text-sm"
              >
                {t('permission.deny')}
              </button>
              <button
                onClick={() => {
                  setPendingAlwaysAllow(false);
                  respondToPermission(permission.toolUseId, 'allow_always');
                }}
                className="flex-1 btn btn-primary text-sm"
              >
                {t('permission.alwaysAllow')}
              </button>
            </div>
          </div>
        )}

        {/* Allow all (session) — hidden for elevated/delete requests */}
        {!isElevatedOnly && (
          <div className="mt-2 border-t border-border/50 pt-2">
            <button
              onClick={() => respondToPermission(permission.toolUseId, 'allow', true)}
              className="w-full btn btn-ghost text-sm text-accent"
            >
              <Check className="w-4 h-4" />
              {t('permission.allowAllSession')}
            </button>
            <p className="text-[11px] text-text-muted mt-1 text-center">
              {t('permission.allowAllSessionDesc')}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 前端测试**

运行相关前端测试并检查是否有依赖旧按钮布局的测试需要同步：

Run: `npx vitest run tests/remote-control-panel-links.test.ts`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/renderer/components/PermissionDialog.tsx src/renderer/i18n/locales/zh.json src/renderer/i18n/locales/en.json
npx eslint --fix src/renderer/components/PermissionDialog.tsx
npx prettier --write src/renderer/components/PermissionDialog.tsx src/renderer/i18n/locales/zh.json src/renderer/i18n/locales/en.json
git commit --no-verify -m "feat: permission dialog three/four-button branches with kind warnings"
```

---

### Task 7: 全量验证

- [ ] **Step 1: typecheck + 全量测试**

Run: `npm run typecheck && npm test -- run`
Expected: 140 files / 933+ tests PASS

注意：如 memory 相关测试失败，先运行 `npm rebuild better-sqlite3` 再重跑。

- [ ] **Step 2: 前端构建验证**

Run: `npx vite build`
Expected: build succeeds

- [ ] **Step 3: 更新 session-history.md**

在 `session-history.md` 末尾追加本节记录（参照 2026-08-09 既有格式），概述：分类器、allowAll 会话 flag、弹窗三/四按钮、默认规则变更、测试与构建结果。

```bash
git add session-history.md
git commit --no-verify -m "docs: record permission optimization session in session-history"
```

- [ ] **Step 4: Docker 构建 .deb（可选，用户需要时执行）**

```bash
docker-compose -f docker/docker-compose.uos.yml run --rm build
```

产物：`release/今点通-3.3.1-linux-amd64.deb`

---

## Self-Review

**Spec coverage:**
- ✅ 决策流程（Task 5 hook 集成）
- ✅ 跨平台命令表 Linux/macOS/Windows（Task 1 分类器）
- ✅ 删除一律确认（Task 1 delete 分类 + gate 永远 ask）
- ✅ 目录外边界 + 符号链接/Windows 盘符（Task 1 isPathInside）
- ✅ 会话 allowAll flag 且不豁免高级权限（Task 4 + Task 5 gate）
- ✅ 弹窗三/四按钮 + 分级告警（Task 6）
- ✅ 默认规则 write/edit/bash → allow（Task 2）
- ✅ 错误处理（Task 1 保守回退）
- ✅ 测试计划（Task 1 分类器测试 + Task 7 全量）

**Type consistency:**
- `PermissionKind` 在 renderer types（Task 3）定义，main 侧 requestPermission/hook 使用字符串字面量类型 `'advanced' | 'delete' | 'outside' | 'normal'` — 类型等价
- `resolvePermissionGate(kind, ruleDecision, sessionAllowAll)` 签名在 Task 1 定义，Task 5 使用一致
- `requestPermission` 6 参数签名（sessionId, toolUseId, toolName, input, kind?）在 Task 4 SessionManager 与 Task 5 AgentRunnerOptions 保持一致
- `handlePermissionResponse(toolUseId, result, allowAll?)` 在 Task 3（main/index.ts）与 Task 4（SessionManager）一致
- `respondToPermission(toolUseId, result, allowAll?)` 在 Task 3 useIPC 与 Task 6 Dialog 一致
