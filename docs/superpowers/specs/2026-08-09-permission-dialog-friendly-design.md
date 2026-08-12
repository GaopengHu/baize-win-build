# 权限确认弹窗友好化设计（自然语言摘要 + 按钮风格统一）

日期：2026-08-09
状态：已确认（用户逐节确认：摘要形态、allowAll 按钮、始终允许文案、跨平台适配、共享模式表）

## 目标

1. **非技术用户友好**：权限弹窗不再直接展示「工具：bash」+ 原始 JSON。改为一句
   自然语言目的句（不含 raw 命令/参数）；「查看详细信息」可展开原始 JSON 与命令。
2. **按钮风格统一**：「允许本会话全部操作」由 ghost 小按钮改为与拒绝/允许同款的全宽
   描边按钮；「始终允许此工具」文案友好化，确认框硬编码英文改为 i18n。
3. **跨平台**：意图识别与路径友好化覆盖 Linux / macOS / Windows 三平台命令与目录。

## 范围

- `src/renderer/components/PermissionDialog.tsx` — 布局与文案
- `src/renderer/utils/permission-summary.ts` — 新增纯函数 `describePermission`
- `src/shared/permission-patterns.ts` — 新增共享模式表（从分类器抽出）
- `src/main/utils/permission-classifier.ts` — 改为从共享表引入（行为不变）
- `src/renderer/i18n/locales/{zh,en}.json` — 新增文案
- `src/tests/` — 新增摘要器单测；分类器 37 测试保持通过
- **不改动**：主进程 IPC 协议、SessionManager、agent-runner、分类器逻辑

## 1. 共享模式表（src/shared/permission-patterns.ts）

从 `src/main/utils/permission-classifier.ts` 抽出，纯数据、无 node:fs/node:path 依赖
（渲染进程安全）：

```ts
export type Platform = 'linux' | 'darwin' | 'win32' | string;
export interface AdvancedPatterns { privilege: RegExp[]; install: RegExp[]; systemDirs: string[]; dangerous: RegExp[]; }
export const ADVANCED_TABLES: Record<string, AdvancedPatterns>; // linux / darwin / win32
export const DELETE_PATTERNS: Record<string, RegExp[]>;
export const UNION_PRIVILEGE / UNION_INSTALL / UNION_DANGEROUS / UNION_SYSTEM_DIRS / UNION_DELETE;
```

- 内容与当前 `permission-classifier.ts` 完全一致（含 `rm -rf` 系统目录危险规则）。
- 分类器改为 import（`classifyCommand` 等逻辑不变，37 条测试保持通过）。

## 2. 自然语言摘要（src/renderer/utils/permission-summary.ts）

```ts
export function describePermission(
  toolName: string,
  input: Record<string, unknown>,
  t: (key: string, opts?: Record<string, unknown>) => string
): string;
```

摘要 = 一句话目的句，**不含命令原文/原始 JSON 值、不用「AI」前缀**。

### 命令类（bash / execute_command / shell）— 按优先级取第一条命中：

| 命中 | 摘要（zh 示例） | i18n key |
|---|---|---|
| `UNION_PRIVILEGE`（sudo/runas…） | 将需要管理员权限的系统操作 | `permission.summary.privilege` |
| `UNION_INSTALL`（apt/brew/choco/…） | 将安装软件包或程序 | `permission.summary.install` |
| `UNION_DELETE`（rm/Remove-Item/del…） | 将删除文件或目录 | `permission.summary.delete` |
| `UNION_DANGEROUS`（mkfs/diskpart/dd…） | 将执行有风险的系统操作 | `permission.summary.dangerous` |
| `curl` / `wget` / PowerShell `iwr`（无管道，纯下载/网页访问） | 将获取或下载网络资源 | `permission.summary.network` |
| 兜底 | 将执行一条系统命令 | `permission.summary.runCommand` |

### 路径类：
- write / write_file：命中 `UNION_SYSTEM_DIRS` 前缀 → 「将修改系统文件：{路径}」，
  否则 → 「将修改文件：{路径}」（Windows 路径大小写不敏感、`C:\Windows` / `\\UNC`、
  macOS `/System` 均覆盖）
- edit / edit_file → 「将编辑已有文件：{路径}」
- read / read_file → 「将读取文件内容」
- glob → 「将按名称搜索文件」；grep → 「将搜索文件内容」
- webFetch → 「将打开网页获取信息」；webSearch → 「将搜索网络信息」

### 未知 / MCP 工具
- → 「将调用外部功能「{工具名}」」（`permission.summary.callTool`，带 toolName 插值）

### 错误处理
- 非字符串 command / 无路径 / 非法输入 → 兜底文案，绝不抛异常。

## 3. 详细信息折叠（PermissionDialog）

- 摘要下方新增 ghost 小按钮：「查看详细信息」⇄「收起」
- 展开内容 = 现「工具：{toolName} + 输入：{JSON}」区块（原样保留）
- i18n：`permission.detailsExpand` / `permission.detailsCollapse`

## 4. 按钮布局（自上而下）

| 按钮 | 样式 |
|---|---|
| 拒绝 / 允许 | `btn btn-secondary` / `btn btn-primary` 并排（现状） |
| 允许本会话全部操作 | **全宽 `btn btn-secondary`**（原 ghost+分隔线删除），下方保留小字说明 `allowAllSessionDesc` |
| 以后不再询问（原「始终允许此工具」） | ghost 全宽同现状，文案改为「以后类似操作不再询问」 |
| 不再询问确认框 | 硬编码英文 → i18n（如「以后不再询问“{操作}”吗？此操作可能修改您的系统。」，含 toolName 插值） |

- 仍遵行：`isElevatedOnly`（advanced/delete）不显示 allowAll 与会话级按钮的分支逻辑不变；
  always-allow 的危险工具二次确认流程不变。

## 5. 测试

- `src/tests/permission-summary.test.ts`（新）：约 14 例
  - 命令意图：sudo/apt/brew(非 linux)/choco/Remove-Item/rm/mkfs/curl 管道/普通命令兜底
  - 路径：`/etc/hosts`→系统文件；`C:\Windows\...`→系统文件（大小写）；`/home/x/p.txt`→普通；UNC
  - 未知工具兜底含工具名、非字符串输入不抛错
- 分类器测试不变（回归）
- 无 PermissionDialog 组件测试（现状无）；验证靠 typecheck + vite build + 人工

## 5. 提交顺序（实现阶段按计划执行）

1. 共享模式表抽取（分类器行为不变，测试保持绿）
2. 摘要器 + 测试（TDD）
3. i18n + PermissionDialog 布局
4. typecheck / 全量测试 / vite build / session-history 记录