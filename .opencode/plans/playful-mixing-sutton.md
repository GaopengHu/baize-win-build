# 今点通 命令/代码质量与效率问题 深度分析报告

## 问题概述

用户反馈 AI Agent 生成的命令和代码质量不高、效率较低。经过对以下维度的完整分析，识别出 **4 大类 16 个根因**：

- 完整 prompt 构建链（system prompt → append prompt → memory prefix → history injection → SDK prompt assembly）
- 工具执行管道（bash timeout wrap → sudo wrap → permission hook → SDK tool registry）
- 上下文管理系统（compaction trigger → summarization → iterative drift → cold-start replay）
- Skills 加载管道（SkillsManager UI → agent-runner sync → resolveSkillPaths → SDK DefaultResourceLoader → formatSkillsForPrompt）
- 模型解析管道（config → resolvePiModelString → resolvePiRegistryModel → buildSyntheticPiModel → applyPiModelRuntimeOverrides）
- SDK 升级影响（0.60.0 → 0.73.1，13 个版本跨越，5 个 Critical 级 breaking change）

---

## 第一大类：Prompt 工程问题（对质量影响最大）

### 1. System Prompt 缺乏代码质量指导 [关键]

**完整的 prompt 结构**（实际发送到模型的内容）：

```
[SDK Base Prompt - system-prompt.js]
  "You are an expert coding assistant operating inside pi, a coding agent harness."
  + Available tools (read/bash/edit/write 各一行极简描述)
  + Guidelines (5-6 条通用规则，如 "Be concise")
  + Pi documentation references (对用户完全无用，浪费 ~200 tokens)

[appendSystemPrompt = coworkAppendPrompt - agent-runner.ts:2121-2187]
  + "你是今点通智能助手，请用中文回复用户。"
  + CRITICAL BEHAVIORAL RULES (6 条行为规则，重点是 "CHAT FIRST" 和 "START DOING IT")
  + workspace_info (当前工作目录)
  + platform_info (仅 Windows: shell 类型 + 命令映射表)
  + citation_requirements
  + tool_behavior (Chrome MCP vs WebSearch 路由)
  + document_generation_rules (文档生成效率规则)
  + bundled_executables (仅生产模式: node/python 绝对路径)

[Project Context - AGENTS.md files, 从 cwd 向上遍历]
[Skills - XML 格式: name + description + location]
[Date + CWD]
```

**缺失的关键指导**：
- 代码风格/规范（缩进、命名、import 模式）
- 错误处理要求（try-catch、边界条件、null check）
- 安全实践（输入验证、参数化查询、不硬编码密钥）
- 依赖检查（先查 package.json 确认库是否可用再使用）
- 验证步骤（修改后运行 lint/typecheck/test）
- 项目结构感知（先 read 确认文件内容再修改，不要假设）

**影响**：模型"裸奔"写代码，没有任何质量标准约束。对比 Claude Code、Cursor 等产品都有详细的代码质量规范段落。

**代码位置**：`src/main/claude/agent-runner.ts:2121-2187`

### 2. 文档生成规则过度追求速度 [高]

**当前规则**（`document_generation_rules` 段落）：
```
1. MINIMIZE TOOL CALLS: Write ONE script...
2. DO NOT READ SKILL DOCS IN FULL...    ← 直接导致 API 使用错误
3. ONE SCRIPT, ONE EXECUTION...Maximum 2 retry attempts.  ← 过早放弃
4. NO ITERATIVE REFINEMENT...
5. CONTENT FIRST: Do not spend time on elaborate styling...
6. TIME BUDGET: 3-5 tool calls total...If > 8...STOP...   ← 复杂文档不够
```

**因果链**：禁止读 skill 文档 → 模型不了解 PptxGenJS/docx/openpyxl 的 API → 凭"记忆"生成代码 → API 调用参数错误 → 执行失败 → 最多重试 2 次 → 放弃

**建议修改**：
```
1. READ SKILL DOCS FIRST: Read the relevant SKILL.md to understand the API before writing code.
2. ONE COMPLETE SCRIPT: Write the full generation script in one file.
3. EXECUTE AND FIX: Run the script. If it fails, read the error, fix, and re-run. Max 3 retries.
4. BUDGET: Aim for 5-10 tool calls total for a complete document.
5. CONTENT FIRST: Focus on correct content. Use simple, clean formatting.
```

### 3. Thinking Level 只有二元开关 [高]

```typescript
// agent-runner.ts:1830-1833
const thinkingLevel = enableThinking ? 'medium' : 'off';
```

SDK 支持 6 级（off/minimal/low/medium/high/xhigh），项目只用 2 级。关键问题：

- **默认 `enableThinking: false`** → 大部分用户 thinking=off → 弱模型质量急剧下降
- LoopGuard 文档明确记录：*"gemini-3.1-pro with thinking=off produces hundreds of empty-text + single-tool-call responses"*
- 复杂编程任务（多文件重构、架构设计）需要 `high`/`xhigh`，但不可选

### 4. 使用 `appendSystemPrompt` 而非 `systemPromptOverride` [中等]

**当前**：SDK 基础 prompt 作为基底，今点通内容追加在后面。

**问题**：
- SDK 基础 prompt 包含 pi 文档引用（约 200 tokens），对今点通用户完全无用
- 无法覆盖 SDK 的 Guidelines（如 "Be concise in your responses" 可能与项目需求冲突）
- 无法定制内置工具描述（当前只有一行极简描述）

**SDK 支持 `systemPromptOverride`**（`system-prompt.js:25-47`）：当提供 `customPrompt` 时，SDK 使用更简洁的结构，仍追加 `appendSystemPrompt`、context files 和 skills。

---

## 第二大类：上下文管理与退化问题（对话越长质量越差）

### 5. Compaction 导致上下文渐进退化 [关键]

这是**长对话中代码质量下降的核心原因**。

**触发条件**：
```
shouldCompact = contextTokens > (contextWindow - reserveTokens)
```

| 模型 | contextWindow | reserveTokens | 触发阈值 |
|------|--------------|---------------|---------|
| Claude 128K | 128,000 | 16,384 | ~112K tokens |
| GPT-5.4 | 128,000 | 16,384 | ~112K tokens |
| Ollama 32K | 32,768 | 4,915 (15%) | ~27.8K tokens |
| Ollama 8K | 8,192 | 禁用 | 永不触发 |

**保留的内容**（`keepRecentTokens` 默认 20,000）：
- 最近 ~20K tokens 的完整对话
- 之前的所有内容被总结为结构化摘要

**总结保留的信息**（SUMMARIZATION_PROMPT）：
- Goal（用户目标）
- Progress（Done / In Progress / Blocked）
- Key Decisions + rationale
- Next Steps
- Critical Context（文件路径、函数名、错误消息）

**总结丢失的信息**：
- Tool results 被截断到 2000 字符
- Thinking/reasoning 链被压缩为摘要文本
- 完整代码片段（除非被显式列入 Critical Context）
- 多步骤调试过程（只保留结果）
- 图片完全丢失
- 微妙的约束和偏好（只有被显式提到的才保留）

**渐进退化曲线**：
```
对话开始 → 完整上下文 → 代码质量: 高
   ↓
第 1 次 compaction → 摘要 + 最近 20K tokens
   丢失: 早期调试痕迹、初始代码探索、详细 tool 结果
   代码质量: 尚可（近期工作完整）
   ↓
第 2 次 compaction → 摘要的摘要 + 最近 20K tokens
   丢失: "不再相关" 的早期决策、随口提到的约束
   代码质量: 开始退化（可能重新建议被否决的方案）
   ↓
第 N 次 compaction → 摘要的摘要的摘要...
   丢失: 架构推理、微妙偏好、边界条件
   代码质量: 明显下降（重复建议、遗忘约束、风格不一致）
```

**UPDATE_SUMMARIZATION_PROMPT 的遗忘条款**：
> "If something is no longer relevant, you may remove it."

这导致每次 compaction 都有一定程度的信息衰减。

**NowLink 特有的缓解措施**：
- Memory 系统：`<core_memory>` 和 `<experience_memory>` 跨 session 持久化
- 文件操作追踪：`<read-files>` 和 `<modified-files>` XML 列表跨 compaction 保留
- Ollama 小上下文保护：< 16K 的模型直接禁用 compaction

### 6. Cold-Start History 预算与叠加问题 [中等]

当 SDK session 被 dispose（cwd 变化、runtime signature 变化、缓存淘汰）后，agent-runner 重新注入历史：

| 场景 | Budget | 128K 模型 | 16K 模型 |
|------|--------|----------|---------|
| Ollama < 16K | 15% | N/A | ~2,458 tokens |
| 其他 | 30% | ~38,400 | ~4,915 |

**叠加问题**：cold-start history + memory prefix + system prompt 三层叠加，在 128K 模型上可能消耗 40K+ tokens 还没开始对话。在 16K 模型上，可用空间被挤压到不足 8K tokens。

### 7. Memory Prefix 无 Token 上限 [低-中]

```typescript
// memory-service.ts:buildPromptPrefix
const sections = [core_memory, experience_memory];
// wrapped in <memory_context> with safety instructions
```

- Core memory 无显式大小限制
- Experience memory 通过 retrieval 参数间接限制（`chunkTopK: 10`, `sessionTopK: 5`, `maxNavSteps: 2`），但实际文本量不可控
- 大量历史对话时 memory prefix 可能占用 3000+ tokens

### 8. Skills Enable/Disable 状态断裂 [低-中]

**两套独立的 skills 管理系统**：

| 系统 | 职责 | 位置 |
|------|------|------|
| `SkillsManager` | UI 管理、启用/禁用 | `skills-manager.ts` |
| agent-runner `resolveSkillPaths` | 运行时路径解析 | `agent-runner.ts:676-712` |

**问题**：`SkillsManager` 的 `enabled` 状态**不会传递给 SDK**。用户禁用某个 skill 后，SDK 的 `DefaultResourceLoader` 仍然会加载它。`SkillsManager.getActiveSkills()` 方法**从未被 agent-runner 调用**。

---

## 第三大类：工具与命令问题

### 9. 工具描述过于稀疏 [中等]

**内置工具**（system-prompt.js）：
```
- read: Read file contents
- bash: Execute bash commands (ls, grep, find, etc.)
- edit: Make surgical edits to files (find exact text and replace)
- write: Create or overwrite files
```

模型不知道：
- `edit` 的 old_text 必须**精确匹配**原文
- `bash` 有 120s 默认超时
- `read` 支持行号偏移量

**MCP 工具**：使用 `Type.Unsafe()` 包装 raw JSON Schema，丢失类型信息。不提供 `promptSnippet` 的 custom tool 在升级 SDK 0.59.0+ 后不会出现在 system prompt 中。

### 10. Windows 命令生成信号混乱 [高-Windows]

三层处理互相矛盾：

| 层 | 行为 | 位置 |
|----|------|------|
| System Prompt `platform_info` | 告诉模型用 `dir/type/findstr` 代替 `ls/cat/grep` | `agent-runner.ts:2131-2156` |
| `validateCommandForPlatform` | 运行时静默替换 Unix 命令为 Windows 等价命令 | `platform-command-utils.ts:56-66` |
| `buildRewriteCommandPrompt` | 命令失败后注入重写提示到 tool output | `platform-command-utils.ts:110-126` |

模型同时收到矛盾信号：prompt 说"用 dir"，但运行时把 `ls` 静默改成 `dir` 后执行成功，模型不理解发生了什么。

### 11. 虚拟路径与实际路径语义鸿沟 [低]

- System prompt 告诉模型 workspace 在 `/workspace`
- `sanitizeOutputPaths` 将 tool output 中的真实路径替换为 `/workspace`
- 模型在生成的脚本中可能硬编码 `/workspace/foo.txt`，但该路径在文件系统上不存在

---

## 第四大类：pi-coding-agent SDK 升级分析（0.60.0 → 0.73.1）

### Critical 级 Breaking Changes（运行时崩溃）

#### C1. `agent.setBeforeToolCall()` 被移除 → 权限系统完全失效

**变化**：Agent 不再提供 `setBeforeToolCall()` 方法和 `_beforeToolCall` 私有属性，改为公开属性 `beforeToolCall`。

**当前代码**（`agent-runner.ts:953-1030`）：
```typescript
// 检查不存在的方法
if (!agent || typeof agent.setBeforeToolCall !== 'function') { return; }
// 读取不存在的私有属性
const sdkBeforeToolCall = (agent as any)._beforeToolCall;
// 调用不存在的方法
agent.setBeforeToolCall(async (ctx, signal) => { ... });
```

**影响**：权限系统（allow/deny/ask）静默安装失败，所有工具调用无需权限确认即可执行。

**修复**：改为 `agent.beforeToolCall = async (ctx, signal) => { ... }`，链式调用改为保存旧值后覆盖。

#### C2. `createAgentSession({ tools })` 期望 `string[]` 而非 `Tool[]`

**变化（0.68.0）**：`tools` 参数从 `Tool[]` 对象改为 `string[]` 工具名。内置工具不再导出（`readTool`, `bashTool`, `codingTools` 等被移除）。

**当前代码**（`agent-runner.ts:2327`）：
```typescript
tools: wrappedTools as unknown as ReturnType<typeof createCodingTools>
```

`wrappedTools` 是经过 timeout wrap 和 sudo wrap 的 `ToolDefinition[]` 对象。新 SDK 期望 `["read", "bash", "edit", "write"]`。

**影响**：session 创建失败或无工具可用。bash timeout 和 sudo 拦截的包装方式需要完全重构。

**修复**：`tools: ["read", "bash", "edit", "write"]`，将 bash 包装逻辑迁移到 `customTools` 或 extension `tool_call` 事件。

#### C3. `agent._onPayload` 猴子补丁可能失效 → Ollama num_ctx 注入失败

**变化**：新 SDK 引入 `streamFn` 架构，`onPayload` 的调用路径可能已改变。

**当前代码**（`agent-runner.ts:2386`）：
```typescript
agent._onPayload = async (payload, modelArg) => {
  return { ...result, num_ctx: ollamaNumCtx.value };
};
```

**影响**：Ollama 模型使用默认上下文窗口（通常 2048 或 4096），导致长对话截断。

**修复**：需要验证新 SDK 中 `_onPayload` 是否仍被调用，或改用 `streamFn` 构造参数。

#### C4. `@sinclair/typebox` → `typebox` 1.x 迁移

**变化（0.69.0）**：SDK 从 `@sinclair/typebox` 0.34.x 迁移到 `typebox` 1.x。

**当前项目中的导入**：
```typescript
import { Type, type TSchema } from '@sinclair/typebox';  // agent-runner.ts
import type { TSchema } from '@sinclair/typebox';         // agent-runtime-extension.ts, memory-types.ts
import { Type } from '@sinclair/typebox';                 // memory-tools.ts
```

**影响**：如果项目的 `@sinclair/typebox` 与 SDK 的 `typebox` 产生两个实例，`ToolDefinition<TSchema>` 类型可能不兼容。基本 `Type.Object`/`Type.String` 结构兼容，但高级特性可能不兼容。

**修复**：将所有 `@sinclair/typebox` 导入改为 `typebox`，添加到项目依赖。

#### C5. `compat.reasoningEffortMap` → `thinkingLevelMap`

**变化（0.72.0）**：`compat.reasoningEffortMap` 被模型级 `thinkingLevelMap` 替代。

**当前代码**（`pi-model-resolution.ts:314-328`）：
```typescript
nextModel = {
  ...nextModel,
  compat: {
    ...currentCompat,
    supportsReasoningEffort: true,
    reasoningEffortMap: { ...currentReasoningEffortMap, off: 'none' },
  },
};
```

**影响**：`reasoningEffortMap` 被新 SDK 静默忽略，Ollama reasoning 模型的 `off: 'none'` 映射不生效。

**修复**：改为 `thinkingLevelMap: { off: 'none', ... }` 放在模型顶层。

### High 级 Breaking Changes

#### H1. `ModelRegistry` 构造函数不再公开（0.64.0）
需改用 `ModelRegistry.create(authStorage)` 或 `ModelRegistry.inMemory()`。当前 `new ModelRegistry(authStorage)` 在 0.73.1 中仍可工作但已不推荐。

#### H2. `ModelRegistry.getApiKey()` → `getApiKeyAndHeaders()`（0.63.0）
返回值从 `string | null` 改为 `{ ok, apiKey?, headers?, error? }`。项目未直接调用此方法，安全。

#### H3. `DefaultResourceLoader` 不再 fallback 到 `process.cwd()`（0.68.0）
项目已显式传入 `cwd: effectiveCwd`，安全。但如果 `effectiveCwd` 为 undefined 将崩溃。

#### H4. System prompt 中内置工具描述被移除（新版）
新版 system-prompt.js 中 `toolDescriptions` map 被移除，只有提供 `toolSnippets` 的工具才出现在 "Available tools" 列表中。如果升级到新版，read/bash/edit/write 的描述可能消失。

### 升级所需改动量评估

| 文件 | 改动类型 | 预估行数 |
|------|---------|---------|
| `agent-runner.ts` | 权限 hook 重写 + tools 参数重构 + Ollama patch 验证 | ~80 行 |
| `pi-model-resolution.ts` | thinkingLevelMap 迁移 | ~10 行 |
| `agent-runtime-extension.ts` | typebox 导入迁移 | ~2 行 |
| `memory-tools.ts` / `memory-types.ts` | typebox 导入迁移 | ~4 行 |
| `package.json` | 添加 `typebox` 依赖 + 移除 `@sinclair/typebox` | ~2 行 |
| 3 个 patch 文件 | 重新生成适配新版本 | 需要手动对比 |
| `electron-builder.yml` | 无变化 | 0 |

**总计**：~100 行代码修改 + 3 个 patch 文件重新适配 + 全面功能回归测试

### 升级收益

| 版本 | 关键改进 | 对项目价值 |
|------|---------|-----------|
| 0.73.0 | Bash 输出增量流式传输 | 命令执行时实时看到输出 |
| 0.71.0 | message_end extension 可替换消息 | 可改进消息后处理 |
| 0.70.1 | DeepSeek V4 replay 400 error 修复 | 直接消除 DeepSeek 对话断裂 |
| 0.70.0 | SettingsManager.inMemory() settings 丢失 bug 修复 | Ollama compaction 设置修复 |
| 0.70.0 | uuid@11 → uuid@14 安全修复 | 消除 npm audit 警告 |
| 0.67-0.69 | 多项 OpenAI/Anthropic/Gemini 流式修复 | 减少 API 兼容性问题 |

---

## 改进方案（按优先级排序）

### P0：Prompt 工程改进（改动最小，效果最大）

#### P0-1：新增 `<code_quality_rules>` 段落

在 `coworkAppendPrompt` 中（`agent-runner.ts:2121` 附近）新增：

```
<code_quality_rules>
When writing or modifying code:
1. DEPENDENCY CHECK: Before using any library, verify it exists in package.json
   (or equivalent manifest). If not available, install it first or use an existing alternative.
2. READ BEFORE WRITE: Always read existing files before modifying them.
   Never assume file contents or structure.
3. ERROR HANDLING: Include proper error handling (try-catch, null checks,
   boundary validation). Never silently swallow errors.
4. SECURITY: Validate user inputs. Never hardcode secrets or API keys.
   Use parameterized queries for databases.
5. CODE STYLE: Match the existing project style — indentation, naming
   conventions, import patterns, and comment style.
6. VERIFICATION: After making changes, run available verification commands
   (lint, typecheck, test) if defined in package.json scripts or equivalent.
7. MINIMAL CHANGES: Make the smallest change that achieves the goal.
   Do not refactor unrelated code unless asked.
8. EXPLAIN BRIEFLY: After completing changes, summarize what was done
   and why in 2-3 sentences.
</code_quality_rules>
```

#### P0-2：修复 `<document_generation_rules>` 段落

替换当前规则为：
```
<document_generation_rules>
When generating documents (DOCX, PPTX, XLSX, PDF):
1. READ SKILL DOCS FIRST: Read the relevant SKILL.md to understand the API
   before writing code. Do not skip this step.
2. ONE COMPLETE SCRIPT: Plan the full document, then write ONE script that
   generates everything. Execute it once.
3. EXECUTE AND FIX: If the script fails, read the error, fix the issue,
   and re-run. Maximum 3 retry attempts.
4. BUDGET: Aim for 5-10 tool calls total. Complex documents may need more.
5. CONTENT FIRST: Focus on correct, complete content. Use clean, simple
   formatting unless the user requests otherwise.
</document_generation_rules>
```

### P1：Thinking Level 与命令处理

#### P1-1：Thinking Level 多级别

UI 和 config 支持三档选择（off / medium / high），修改 `agent-runner.ts:1830`：
```typescript
type ThinkingSetting = 'off' | 'medium' | 'high';
const setting = configStore.get('thinkingLevel') || 'off';
const thinkingLevel: PiThinkingLevel = setting as PiThinkingLevel;
```

#### P1-2：统一 Windows 命令信号

- `platform_info` 只声明当前 shell 类型和版本，不列命令映射
- 删除 `validateCommandForPlatform` 的静默命令替换
- 保留 `isPlatformError` + `buildRewriteCommandPrompt` 作为失败后引导

### P2：SDK 升级 + 架构改进

#### P2-1：升级 pi-coding-agent 到 0.73.1

按 Critical 级别逐项修复：
1. **权限 hook**：`setBeforeToolCall()` → `agent.beforeToolCall = fn`
2. **tools 参数**：`Tool[]` → `string[]`，bash wrap 迁移到 customTools
3. **Ollama patch**：验证 `_onPayload` 在新 SDK 中是否仍有效
4. **typebox**：全局替换 `@sinclair/typebox` → `typebox`
5. **reasoningEffortMap**：→ `thinkingLevelMap`
6. **Patch 文件**：重新生成 3 个 patch 适配新版本

#### P2-2：使用 `systemPromptOverride` 控制 prompt

完全控制 system prompt 内容，去掉 pi 文档引用，定制工具描述。

#### P2-3：修复 Skills Enable/Disable 断裂

在 `resolveSkillPaths` 中过滤掉 `SkillsManager` 中标记为 disabled 的 skills。

#### P2-4：Compaction 配置优化

对非 Ollama 的强模型，增加 `keepRecentTokens` 到 30000-40000，减少 compaction 后的信息丢失。

---

## 总结矩阵

| 优先级 | 问题 | 根因类别 | 预期效果 | 改动量 | 风险 |
|--------|------|---------|---------|-------|------|
| **P0** | 缺少代码质量指导 | Prompt | 代码质量显著提升 | ~15 行 prompt | 极低 |
| **P0** | 文档生成规则过于激进 | Prompt | 文档质量显著提升 | ~6 行 prompt | 极低 |
| **P1** | Thinking Level 二元化 | 模型 | 复杂任务质量提升 | ~5 行 + UI | 低 |
| **P1** | Windows 命令信号混乱 | 工具 | Windows 命令准确性提升 | ~30 行 | 低 |
| **P1** | Compaction 渐进退化 | 上下文 | 长对话质量改善 | ~3 行配置 | 低 |
| **P1** | Skills 启用状态断裂 | Skills | 禁用 skill 真正生效 | ~10 行 | 低 |
| **P2** | SDK 升级 0.60→0.73 | 基础 | 稳定性+功能全面提升 | ~100 行 + 3 patch | **高** |
| **P2** | systemPromptOverride | Prompt | 节省 token + 精准控制 | ~50 行重构 | 中 |
| **P2** | Memory prefix 无上限 | 上下文 | 防止 context 溢出 | ~5 行 | 低 |

---

## 附录 B：回复速度慢 — 基于生产日志的根因分析与修复计划

### 测试环境

- **模型**: `DS/DeepSeek-V4-Flash` 通过 `http://172.31.30.155:3000/v1`（OpenAI 兼容 API）
- **API 端点网络延迟**: 11ms（正常）
- **MCP Servers**: 2 个（beijing-weather 1 tool, Idenote 8 tools）
- **日志来源**: `/home/JDJT/.config/今点通/logs/app-2026-09-08_06-17-41-773-1.log`

### 实际计时数据（6 轮对话）

| 轮次 | 消息数 | 类型 | 预处理 | LLM API 调用次数 | 工具执行 | 总耗时 |
|------|-------|------|--------|-----------------|---------|-------|
| Turn 1 | 54 | 冷启动 | 727ms | 2 次 (4s + ~54s) | 有 | **58.0s** |
| Turn 2 | 55 | 热启动 | 453ms | 2 次 (6ms + 35s) | 无 | **41.9s** |
| Turn 3 | 55 | 热启动 | 446ms | 多轮 (含工具) | 4 次 | **147.8s** |
| Turn 4 | 67 | 热启动 | 453ms | 多轮 | 多次 | **35.2 分钟 ❌** |
| Turn 5 | 1 | 冷启动 | 733ms | 2 次 | 有 | **43.2s** |
| Turn 6 | 3 | 热启动 | 454ms | 多轮 | 多次 | **16.8 分钟 ❌** |

### 关键发现

**1. 预处理管道不是瓶颈（450-730ms，合理）**

**2. 真正的瓶颈是 `piSession.prompt()` 内的多轮 Agent 循环**

每条用户消息触发：
```
用户消息 → LLM API 调用 #1（模型决定用工具，4-6s）
         → 工具执行
         → LLM API 调用 #2（处理结果 + 生成文本，5-35s）
         → [可能还有更多轮]
```

Turn 3 示例：10 次 LLM API 调用 + 4 次工具执行 = 147.8s

**3. 每次 API 调用都发送 ~6,400 tokens 的固定开销**

| 组件 | 字符数 | Token 估算 | 每次请求都发？ | 是否相关？ |
|------|-------|-----------|-------------|-----------|
| AGENTS.md（今点通开发文档） | 7,616 | **~2,307** | ✅ 每次都发 | ❌ **无关** — 这是开发今点通自己的文档 |
| coworkAppendPrompt（行为规则） | 4,528 | ~1,140 | ✅ 每次都发 | ✅ 相关 |
| Skills XML（5 个技能元数据） | 2,725 | ~681 | ✅ 每次都发 | ✅ 相关 |
| SDK 基础 prompt | 1,942 | ~486 | ✅ 每次都发 | ⚠️ 部分相关（含 pi 文档引用） |
| 工具定义 | ~7,080 | ~1,770 | ✅ 每次都发 | ✅ 相关 |
| **总计** | **~24,091** | **~6,434** | | |

**4. 累积输入 token 量巨大**

Turn 3（55 条消息 + 10 次 API 调用）：
- 系统 prompt: 10 × 6,434 = **64,340 tokens**
- 对话历史: 55 条消息 × ~500 tokens ≈ **27,500 tokens**（每轮都完整发送）
- 工具定义 + 结果: 散布在各轮中
- **总输入: ~100K+ tokens**

**5. Memory OneShot 调用在主对话之后（不阻塞用户响应）**

日志显示 OneShot 调用发生在 `agent prompt completed` **之后**，属于 `afterSessionRun` 的记忆摄取阶段。它不影响用户的感知响应速度，但：
- 每次消耗 43+ 秒的 API 时间
- 超时 180s 时会报错
- 使用与主对话相同的昂贵模型做简单的摘要/提取

### 核心根因

**回复慢 = 每次用户消息触发的多轮 Agent 循环中，每次 API 调用都发送了 ~6,400 tokens 的固定开销（其中 AGENTS.md 占 36% 且完全无关） + DeepSeek-V4-Flash 单次推理需要 5-35 秒 + 工具调用增加了循环次数**

---

### 修复计划（不牺牲质量）

#### 修改 1：AGENTS.md 条件化注入（最大收益）

**问题**：AGENTS.md 是今点通自身的开发文档（Docker 构建、GLIBC 兼容性、IPC 处理等），但被注入到**每个用户项目**的对话中，浪费 2,307 tokens/API 调用。

**方案**：只在当前工作目录是今点通项目本身时注入 AGENTS.md，其他项目不注入。

**文件**：`src/main/claude/agent-runner.ts`

**实现方式**：在 `DefaultResourceLoader` 构造时，通过 `agentsFilesOverride` 参数控制 AGENTS.md 注入。或者在 `coworkAppendPrompt` 中替代 SDK 的自动发现机制。

**预期效果**：
- 每次 API 调用减少 ~2,307 tokens
- Turn 3（10 次 API 调用）减少 ~23,000 input tokens
- 用户对话的 API 响应更快

**改动量**：~20 行

#### 修改 2：添加 per-API-call 计时日志（诊断能力）

**问题**：当前只有整体 `prompt()` 计时（从发送到完成），无法看到每轮 LLM API 调用的单独耗时。

**方案**：在 `message_start` 和 `message_end` 事件中记录每次 API 调用的耗时，输出到日志。

**文件**：`src/main/claude/agent-runner.ts`

**实现方式**：在 subscribe 回调中添加计时变量，`message_start` 记录开始时间，`message_end` 计算并 log 耗时。

**预期效果**：后续可精确定位哪轮 API 调用慢（是模型推理慢还是工具调用多）

**改动量**：~10 行

#### 修改 3：SDK 基础 prompt 中的 pi 文档引用清理（次要优化）

**问题**：SDK 基础 prompt 包含 pi 文档路径引用（~200 字符），对今点通用户完全无用。

**方案**：使用 `systemPromptOverride` 替代 `appendSystemPrompt`，完全控制 system prompt 内容，去掉 pi 文档引用。

**文件**：`src/main/claude/agent-runner.ts`

**改动量**：~30 行（需要重写 prompt 组装逻辑）

**注意**：这个改动较大，建议在修改 1-2 验证效果后再做。

### 实施顺序

```
Phase 1: 快速见效（修改 1 + 2）
  1. AGENTS.md 条件化注入
  2. 添加 per-API-call 计时日志
  3. npm run typecheck + lint
  4. Docker 构建 .deb
  5. 部署测试，对比修改前后的 API 调用耗时

Phase 2: 深度优化（修改 3，可选）
  6. systemPromptOverride 完全控制
```

### 预期效果汇总

| 修改 | 每次 API 调用节省 | Turn 3 (10 次调用) 节省 | 风险 |
|------|------------------|----------------------|------|
| AGENTS.md 条件化 | ~2,307 tokens | ~23,070 tokens | 极低 |
| per-API-call 计时 | 0（纯诊断） | 0 | 极低 |
| systemPromptOverride | ~200 tokens | ~2,000 tokens | 中 |

---

## 附录：pi-coding-agent SDK 完整迁移分析（0.60.0 → 0.85.1）

### 背景

SDK 已从 `@mariozechner/*` 迁移到 `@earendil-works/*`：

| | 旧包（已冻结） | 新包（活跃维护） |
|--|--------------|----------------|
| Scope | `@mariozechner/*` | `@earendil-works/*` |
| 最终版本 | 0.73.1（2026-05-07） | **0.85.1**（2026-09-05） |
| Node 要求 | `>=20.6.0` | `>=22.19.0` |
| 子包 | pi-ai / pi-agent-core / pi-tui | 同步迁移到 `@earendil-works/*` |

项目当前锁定 `@mariozechner@0.60.0`，需要跨越 **0.60.0 → 0.73.1 → 0.85.1** 共 25 个版本的 breaking changes。

---

### A. `@mariozechner` 引用完整清单

#### 源码中的静态导入（9 处）

| # | 文件 | 导入内容 |
|---|------|---------|
| 1 | `src/main/claude/agent-runner.ts:15-23` | `createAgentSession`, `SessionManager`, `SettingsManager`, `createCodingTools`, `type BashToolOptions`, `type AgentSession`, `type ToolDefinition` |
| 2 | `src/main/claude/shared-auth.ts:1` | `AuthStorage`, `ModelRegistry` |
| 3 | `src/main/claude/windows-bash-operations.ts:4-7` | `SettingsManager`, `type BashOperations` |
| 4 | `src/main/extensions/agent-runtime-extension.ts:1` | `type ToolDefinition` |
| 5 | `src/main/memory/memory-types.ts:1` | `type ToolDefinition` |
| 6 | `src/main/claude/claude-sdk-one-shot.ts:1` | `completeSimple`, `type UserMessage` (from `pi-ai`) |
| 7 | `src/main/claude/pi-model-resolution.ts:1` | `getModel`, `type Api`, `type Model` (from `pi-ai`) |
| 8 | `src/main/claude/agent-runner-message-end.ts:1-7` | `type AssistantMessage`, `AssistantMessageEvent`, `TextContent`, `ThinkingContent`, `ToolCall` (from `pi-ai`) |

#### 源码中的动态导入（2 处）

| # | 文件 | 导入内容 |
|---|------|---------|
| 9 | `src/main/claude/agent-runner.ts:2282` | `DefaultResourceLoader` (lazy import from `pi-coding-agent`) |
| 10 | `src/main/config/config-store.ts:296` | `getModels` (lazy import from `pi-ai`) |

#### 测试文件（5 处）

| # | 文件 | 内容 |
|---|------|------|
| 11 | `src/tests/claude/claude-sdk-one-shot.test.ts:5` | `vi.mock('@mariozechner/pi-ai', ...)` |
| 12 | `src/tests/claude/pi-model-resolution.test.ts:2` | `import type { Api, Model } from '@mariozechner/pi-ai'` |
| 13 | `src/tests/claude/agent-runner-history-rebuild.test.ts:22` | `vi.mock('@mariozechner/pi-ai', ...)` |
| 14 | `tests/deepseek-thinking-serialization.test.ts:7,13` | 文件路径引用 `node_modules/@mariozechner/pi-ai/...` |

#### Patch 文件（3 个）

| 文件 | 修改目标 |
|------|---------|
| `patches/@mariozechner+pi-coding-agent+0.60.0.patch` | `core/sdk.js` — 注入 `baseToolsOverride` |
| `patches/@mariozechner+pi-ai+0.60.0.patch` | `openai-completions.js` — DeepSeek V4 `requiresThinkingInContent` |
| `patches/@mariozechner+pi-tui+0.60.0.patch` | `utils.js` — `/v` regex → `/u`（Node 16 兼容） |

#### package.json（3 处）

| 位置 | 声明 |
|------|------|
| `dependencies` | `"@mariozechner/pi-ai": "^0.60.0"`, `"@mariozechner/pi-coding-agent": "^0.60.0"` |
| `optionalDependencies` | `"@mariozechner/clipboard-win32-x64-msvc": "0.3.2"` |

#### 其他引用

- `vite.config.ts:40` — 注释中提及 ESM-only 包
- `scripts/build-win7.mjs:80-81` — patch 文件列表
- `scripts/build-macos.mjs:79-80` — patch 文件列表

---

### B. Breaking Changes 逐项分析（按风险排序）

#### [CRITICAL-1] `authStorage` + `modelRegistry` → `modelRuntime`（v0.80.8）

`createAgentSession` 不再接受 `authStorage` 和 `modelRegistry` 参数，改为异步的 `modelRuntime`。

**当前代码**（`agent-runner.ts:2290-2336`）：
```typescript
const authStorage = getSharedAuthStorage();
const modelRegistry = new ModelRegistry(authStorage);
const { session } = await createAgentSession({
  model: piModel, thinkingLevel,
  authStorage,           // ← 移除
  modelRegistry,         // ← 移除
  tools: wrappedTools,   // ← 类型不匹配
  ...
});
```

**新代码**：
```typescript
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
const modelRuntime = await ModelRuntime.create({
  credentials: authStorage,
  allowModelNetwork: false,
});
const { session } = await createAgentSession({
  model: piModel, thinkingLevel,
  modelRuntime,                        // ← 新参数
  tools: ["read", "bash", "edit", "write"],  // ← string[]
  ...
});
```

**影响范围**：`agent-runner.ts`（~30 行）、`shared-auth.ts`（~25 行）、`claude-sdk-one-shot.ts`（~15 行）

#### [CRITICAL-2] `tools` 参数从 `Tool[]` 改为 `string[]`（v0.68.0+）

内置工具通过名称选择，自定义工具走 `customTools`。`createCodingTools()` 不再导出。

**当前代码**（`agent-runner.ts:2216-2230`）：
```typescript
const codingTools = createCodingTools(effectiveCwd, bashOptions);
const withTimeout = wrapBashToolWithDefaultTimeout(codingTools);
const wrappedTools = wrapBashToolForSudo(withTimeout, ...);
// ...传入 createAgentSession({ tools: wrappedTools })
```

**新方案**：bash 的 timeout 和 sudo 包装需要重构为 `customTools` 覆盖内置 bash 工具，或使用 extension 的 `tool_call` 事件拦截。

**影响范围**：`agent-runner.ts`（~40 行重构）

#### [CRITICAL-3] `AuthStorage` 不再从根导出 + `setRuntimeApiKey` 移除（v0.80.8）

**当前代码**（`shared-auth.ts`）：
```typescript
import { AuthStorage, ModelRegistry } from '@mariozechner/pi-coding-agent';
```

**当前用法**（`claude-sdk-one-shot.ts:230-236`）：
```typescript
authStorage.setRuntimeApiKey(provider, apiKey);
```

**新方案**：`AuthStorage` 变为内部类，`setRuntimeApiKey` 迁移到 `ModelRuntime`。需要确认 `AuthStorage` 是否可通过子路径导入（如 `@earendil-works/pi-coding-agent/auth`），或完全使用 `ModelRuntime` 替代。

**影响范围**：`shared-auth.ts`（重写）、`claude-sdk-one-shot.ts`（~10 行）

#### [CRITICAL-4] pi-ai 根 API 迁移到 `/compat` 子路径（v0.80.0）

`getModel`、`completeSimple`、`getModels` 等函数和类型从根导出迁移到 `@earendil-works/pi-ai/compat`。

**需要修改的导入**：

| 文件 | 旧导入 | 新导入 |
|------|-------|-------|
| `pi-model-resolution.ts:1` | `from '@mariozechner/pi-ai'` | `from '@earendil-works/pi-ai/compat'` |
| `claude-sdk-one-shot.ts:1` | `from '@mariozechner/pi-ai'` | `from '@earendil-works/pi-ai/compat'` |
| `agent-runner-message-end.ts:1-7` | `from '@mariozechner/pi-ai'` | `from '@earendil-works/pi-ai/compat'` |
| `config-store.ts:296` | `import('@mariozechner/pi-ai')` | `import('@earendil-works/pi-ai/compat')` |
| 3 个测试文件 | mock path | 同步更新 |

**注意**：`/compat` 是过渡层，未来版本会移除，最终需迁移到 `createModels()`/provider-factory API。

#### [HIGH-1] `message_update` 事件移除 `partial` 字段（v0.84.0）

`toolcall_start` 事件中 `event.assistantMessageEvent.partial` 被移除，不再提供累积消息。

**当前代码**（`agent-runner.ts:2668-2686`）：
```typescript
} else if (ame.type === 'toolcall_start') {
  const partial = ame.partial;                          // ← 移除
  const toolContent = partial?.content?.[ame.contentIndex];
  const toolName = toolContent?.type === 'toolCall' ? toolContent.name : 'unknown';
  const toolCallId = toolContent?.type === 'toolCall' ? toolContent.id : uuidv4();
  // ...创建 trace step
}
```

**新方案**：`toolcall_start` 事件本身应包含 tool name 和 id（需验证新 SDK 的事件结构）。或者从 `message_end` 的完整消息中提取 tool call 信息。

**影响范围**：`agent-runner.ts` message_update handler（~30 行）

#### [HIGH-2] `auto_compaction_start/end` 重命名为 `compaction_start/end`（v0.84.0）

**当前代码**（`agent-runner.ts:2921-2970`）：
```typescript
case 'auto_compaction_start': { ... }
case 'auto_compaction_end': { ... }
```

**新代码**：
```typescript
case 'compaction_start': {
  // event.reason: "manual" | "threshold" | "overflow"
}
case 'compaction_end': {
  // event: { reason, result, aborted, willRetry, errorMessage? }
}
```

**影响范围**：`agent-runner.ts`（~15 行 case 重命名 + 字段适配）

#### [HIGH-3] `DefaultResourceLoader` 需要 `agentDir` 参数（v0.79.0）

**当前代码**（`agent-runner.ts:2283-2287`）：
```typescript
const resourceLoader = new DefaultResourceLoader({
  cwd: effectiveCwd,
  additionalSkillPaths: skillPaths,
  appendSystemPrompt: coworkAppendPrompt,
});
```

**新代码**：
```typescript
import { getAgentDir } from '@earendil-works/pi-coding-agent';
const resourceLoader = new DefaultResourceLoader({
  cwd: effectiveCwd,
  agentDir: getAgentDir(),           // ← 新增必填参数
  additionalSkillPaths: skillPaths,
  appendSystemPrompt: coworkAppendPrompt,
});
```

#### [HIGH-4] `compat.reasoningEffortMap` → `thinkingLevelMap`（v0.72.0）

**当前代码**（`pi-model-resolution.ts:314-328`）：
```typescript
nextModel = {
  ...nextModel,
  compat: {
    ...currentCompat,
    supportsReasoningEffort: true,
    reasoningEffortMap: { ...currentReasoningEffortMap, off: 'none' },
  },
};
```

**新代码**：
```typescript
nextModel = {
  ...nextModel,
  thinkingLevelMap: { off: 'none', ... },  // ← 移到模型顶层
  compat: { ...currentCompat, supportsReasoningEffort: true },
};
```

#### [MEDIUM-1] `@sinclair/typebox` → `typebox` 1.x（v0.69.0）

**当前导入**（4 个文件）：
```typescript
import { Type, type TSchema } from '@sinclair/typebox';
```

**新导入**：
```typescript
import { Type, type TSchema } from 'typebox';
```

需要将 `typebox` 添加到项目 `package.json` 的 `dependencies`。

#### [MEDIUM-2] `_onPayload` 猴子补丁（Ollama num_ctx 注入）

已用 `'_onPayload' in agent` 防御性检查保护。如果新 SDK 移除了该私有 API，Ollama 将使用默认上下文窗口。需要确认新 SDK 是否提供了替代注入点（如 `ModelRuntime` 的 request hook 或 model `compat` 设置）。

#### [MEDIUM-3] `setBeforeToolCall` / `_beforeToolCall`（权限系统）

已用 `typeof agent.setBeforeToolCall !== 'function'` 防御性检查保护。如果新 SDK 移除了这些私有 API，权限弹窗将不弹出（所有工具自动执行）。需要确认新 SDK 是否提供了 extension-based `tool_call` 事件作为替代。

#### [LOW-1] `sendUserMessage` steer 机制

`sendUserMessage(text, { deliverAs: 'steer' })` 在 v0.84.2 中仍有效。可考虑迁移到标准 `session.steer()` API。

#### [LOW-2] Node.js 版本要求 `>=22.19.0`

项目 Docker 构建用 Node 22.22.0（满足），但 Electron 22 运行时内置 Node 16。SDK 作为库嵌入 Electron 时，关键是语言特性兼容性而非 `engines` 字段。需要验证新 SDK 代码是否使用了 Node 22-only 的运行时 API（如 `structuredClone` 原生支持——项目已有 polyfill、`Array.at()` 等）。

#### [LOW-3] pi-tui patch 可能不再需要

pi-tui 的 `/v` regex flag patch 是因为 Electron 22 的 Node 16 不支持。如果新 SDK 的 pi-tui 已经解决了 Node 16 兼容性（或放弃了 Node 16 支持），该 patch 需要重新评估。

---

### C. 迁移改动量评估

| 类别 | 文件数 | 预估行数 | 风险 |
|------|-------|---------|------|
| 包名重命名（`@mariozechner` → `@earendil-works`） | ~14 | ~30（机械替换） | 低 |
| pi-ai `/compat` 导入路径 | ~8 | ~10 | 低 |
| AuthStorage → ModelRuntime | 3 | ~70 | **高** |
| tools `Tool[]` → `string[]` | 1 | ~40 | **高** |
| message_update partial 移除 | 1 | ~30 | 高 |
| compaction 事件重命名 | 1 | ~15 | 中 |
| DefaultResourceLoader agentDir | 1 | ~5 | 低 |
| reasoningEffortMap → thinkingLevelMap | 1 | ~10 | 中 |
| typebox 迁移 | 4 | ~8 | 低 |
| Patch 文件重新适配 | 3 | 需手动对比 | **高** |
| 测试文件 mock 路径 | 4 | ~10 | 低 |
| **总计** | **~14 源码 + 3 patch + 4 测试** | **~230 行** | |

---

### D. 推荐迁移步骤

```
Phase 1: 准备工作
  1. git checkout -b feat/sdk-migration-earendil
  2. 更新 package.json:
     - 移除 @mariozechner/* 依赖
     - 添加 @earendil-works/* 依赖 (v0.85.1)
     - 添加 typebox 依赖
  3. npm install（观察 patch-package 报错）

Phase 2: 机械替换（低风险）
  4. 全局替换 import 路径: @mariozechner → @earendil-works
  5. pi-ai 导入路径加 /compat 后缀
  6. typebox 导入迁移
  7. package.json / vite.config / build scripts 中的引用更新
  8. 测试文件 mock 路径更新

Phase 3: API 适配（高风险）
  9. 重写 shared-auth.ts: AuthStorage → ModelRuntime
  10. 重写 agent-runner.ts session 创建: authStorage/modelRegistry → modelRuntime
  11. 重构 tools 参数: Tool[] → string[] + customTools
  12. 添加 DefaultResourceLoader agentDir 参数
  13. 重命名 compaction 事件 case
  14. 修复 message_update toolcall_start 处理（移除 partial 依赖）
  15. 迁移 reasoningEffortMap → thinkingLevelMap

Phase 4: Patch 重新适配
  16. 逐一验证 3 个 patch 是否仍需要
  17. 重新生成 patch diff（npx patch-package @earendil-works/*）

Phase 5: 验证
  18. npm run typecheck
  19. npm run lint
  20. npm test
  21. 功能回归测试:
      - 基本对话（Claude / GPT / DeepSeek / Ollama 各一个）
      - 工具执行 + 权限弹窗
      - MCP 工具调用
      - 文档生成（DOCX/PPTX/XLSX）
      - Loop guard（高频工具调用）
      - 长对话 compaction
  22. Docker 构建 .deb 验证
```

---

### E. 关键风险与缓解措施

| 风险 | 缓解 |
|------|------|
| `AuthStorage` 完全不可导入 | 检查新 SDK 的 `auth-storage.js` 是否仍可通过子路径导入；或 fork AuthStorage 逻辑到项目内 |
| `_onPayload` 被移除 | 改用 model `compat` 设置或 `ModelRuntime` 的 request interceptor；最坏情况在 `streamFn` 层注入 |
| `setBeforeToolCall` 被移除 | 改用 SDK 的 extension `tool_call` 事件实现权限拦截 |
| pi-tui `/v` regex 在新版仍存在 | 重新生成 patch 适配新文件路径 |
| Electron 22 Node 16 不兼容 | 如不兼容，需同步升级 Electron（影响 Windows 7/8 支持） |

### F. 升级收益（0.60.0 → 0.85.1）

| 收益 | 说明 |
|------|------|
| GPT-6 Astra 支持 | 最新 OpenAI 模型 |
| Bash 输出实时流式传输 | 命令执行时即可看到输出，不必等完成 |
| DeepSeek V4 replay 修复 | 消除对话断裂 |
| SettingsManager bug fix | Ollama compaction 设置不再丢失 |
| `session_compact_failed` 事件 | 可监控 compaction 失败原因 |
| PowerShell 原生工具 | Windows 更好的命令执行 |
| 工具 `ctx.cwd` 修复 | 工具正确使用工作目录 |
| 分支摘要改进 | 对话导航更准确 |
| 25 个版本的 bug fix | 整体稳定性大幅提升 |
