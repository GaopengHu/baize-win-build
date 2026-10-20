/**
 * @module main/claude/subagent/subagent-runner
 *
 * Phase 7.1/7.2 一次性 child 会话组装与运行（research/document/general）。
 *
 * 组装原则（与主会话 session-factory.create() 对齐，但刻意做减法）：
 * - 同款 `createAgentSession` + in-memory SessionManager/SettingsManager；
 * - research：ResourceLoader 全关技能（noSkills/noExtensions/noPromptTemplates/
 *   noThemes），只留极简 persona——冷启动最快、无 skills 开销；内置工具 =
 *   `createReadOnlyTools(cwd)`（注意：模块级 `readOnlyTools` 常量绑定的是
 *   process.cwd()，child 必须用 cwd 参数化版本）；不挂 permission hook
 *   （只读不触发审批路径）；
 * - document/general：`createCodingTools(cwd)` 全量 + bash 默认超时包装；
 *   ResourceLoader 加载父会话同款 skillPaths（PPTX/DOCX/XLSX/PDF skills）；
 *   挂 `installPermissionHook`，sessionId **传父 sessionId**（§1.10 第 1 点：
 *   alwaysAllow/sessionAllowAll 按父 id 键控，child 专用 id 会导致「始终允许」
 *   失效 + 键泄漏；child 身份走展示层 source.label）；
 * - customTools = ToolStrategy.mergeCustomTools(web_search, chromeBrowsingTools)，
 *   去重规则与主会话一致，不手写合并；
 * - **不跑任何 AgentRuntimeExtension**（beforeSessionRun 链不触发）：child 拿不到
 *   dispatch_agent，深度 1 结构性保证；memory 也不注入，child 上下文保持干净。
 * - 不进 PiSessionFactory 缓存：一次性 child，跑完 dispose。
 * - 不挂 LoopGuard：靠工具调用预算（MAX_CHILD_TOOL_CALLS）+ retry 上限兜底。
 *
 * 预算说明：SDK 0.60 无单会话 maxTokens/maxIterations 能力位（已核验
 * agent-session.d.ts），child 预算 = 工具调用计数（超限 abort）+ 报告截断。
 */
import {
  createAgentSession,
  createCodingTools,
  createReadOnlyTools,
  DefaultResourceLoader,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { PiThinkingLevel } from '../pipeline/context-types';
import { Type, type TSchema } from '@sinclair/typebox';
import type { AuthStorage } from '../shared-auth';
import { log, logError, logWarn } from '../../utils/logger';
import { installPermissionHook, type PermissionHookDeps } from '../tools/permission-hook';
import { wrapBashToolWithDefaultTimeout } from '../tools/bash-tool-wrappers';
import { performSearch, type ResolvedSearchEndpoint } from './search-endpoint';

export type SubagentProfileName = 'research' | 'document' | 'general';

/**
 * 子 agent profile 描述对象（Phase 7.2 用户自定义 agent 的演进钩子：
 * 新增 profile 只需加表项；document/general 在 7.1.2+ 增量放开）。
 */
export interface SubagentProfile {
  name: SubagentProfileName;
  /** 极简 persona + 输出格式约束（prompt 里的 schema，零代码成本）。 */
  systemPrompt: string;
  /** 覆盖默认 search endpoint；未设时用 appConfig.searchRuntime。 */
  searchEndpoint?: ResolvedSearchEndpoint['engine'];
}

function buildResearchSystemPrompt(cwd: string): string {
  return [
    '你是办公调研助手，为主 agent 并行完成一个只读调研子任务。',
    '工作方式：多来源检索（web_search 可多次调用换关键词）、交叉验证、输出带出处的聚焦摘要。',
    `工作目录：${cwd}。你可以用 read/grep/find/ls 通读本地文件与长文档。`,
    '硬约束：禁止修改任何文件；只需要只读工具，不要申请写权限；不要复述委派书，直接给结论。',
    '输出格式（严格遵守，主 agent 按此解析）：',
    '## 结论（不超过 5 条，每条一句话）',
    '## 分歧点（如各来源说法不一，列出差异；无分歧写"无"）',
    '## 出处（每条：标题 + URL + 日期，无 URL 注明来源文件名）',
  ].join('\n');
}

function buildDocumentSystemPrompt(cwd: string): string {
  // persona 与主会话 documentGenerationRules() 同源（prompt-strategy.ts:196），
  // 精简为 child 可执行版本：规则原文是唯一权威，此处只保留动作约束。
  return [
    '你是办公文档助手，为主 agent 并行完成一个文档生成子任务（Word/PPT/Excel/PDF 等）。',
    `工作目录：${cwd}。`,
    '硬约束：',
    '1. 先读相关 SKILL.md（PPTX/DOCX/XLSX/PDF），理解 API 后再写代码，不要跳过；',
    '2. 通读委派书，规划完整内容后写 ONE 个完整脚本一次生成全部内容；',
    '3. 运行脚本，失败则读错修复重跑，最多 3 次，不要从头重写；',
    '4. 预算 5–10 次工具调用；写文件/跑命令会弹权限确认，如被拒绝请在报告中注明、不要反复重试；',
    '5. 不要复述委派书，直接产出文件。',
    '输出格式（严格遵守，主 agent 按此解析）：',
    '## 产出（生成的文件路径列表）',
    '## 说明（每份文件一句话：内容与格式）',
    '## 未完成（如有权限被拒或失败，写明原因；无则写"无"）',
  ].join('\n');
}

function buildGeneralSystemPrompt(cwd: string): string {
  return [
    '你是通用执行助手，为主 agent 并行完成一个可独立执行的子任务。',
    `工作目录：${cwd}。你拥有完整工具集（读/写/改/跑命令/检索）。`,
    '硬约束：只做委派书指定的事，不扩大范围；写文件/跑命令会弹权限确认，被拒绝则注明、不要反复重试；不要复述委派书，直接给结果。',
    '输出格式（严格遵守，主 agent 按此解析）：',
    '## 结果（做了什么、产出在哪）',
    '## 未完成（如有权限被拒或失败，写明原因；无则写"无"）',
  ].join('\n');
}

export const SUBAGENT_PROFILES: Record<SubagentProfileName, SubagentProfile> = {
  research: {
    name: 'research',
    systemPrompt: '',
  },
  document: {
    name: 'document',
    systemPrompt: '',
  },
  general: {
    name: 'general',
    systemPrompt: '',
  },
};

/** 各 profile 的 systemPrompt 依赖 cwd，调用处组装（保持 PROFILES 表可静态断言）。 */
export function getSubagentProfile(name: SubagentProfileName, cwd: string): SubagentProfile {
  const base = SUBAGENT_PROFILES[name];
  if (!base) throw new Error(`Unknown subagent profile: ${name}`);
  if (name === 'research') {
    return { ...base, systemPrompt: buildResearchSystemPrompt(cwd) };
  }
  if (name === 'document') {
    return { ...base, systemPrompt: buildDocumentSystemPrompt(cwd) };
  }
  return { ...base, systemPrompt: buildGeneralSystemPrompt(cwd) };
}

/**
 * 各 profile 工具集的工具名快照（负向断言用）。
 * research：无写工具、无 dispatch_agent（深度 1 结构性保证）；
 * document/general：全量（含 write/edit/bash），写操作走权限审批。
 */
export function getProfileToolNames(profile: SubagentProfileName): string[] {
  if (profile === 'research') {
    return ['read', 'grep', 'find', 'ls', 'web_search'];
  }
  return ['read', 'bash', 'edit', 'write', 'web_search'];
}

/** research 工具集的工具名快照（负向断言用：无写工具、无 dispatch_agent）。 */
export function getResearchToolNames(): string[] {
  return getProfileToolNames('research');
}

/** 单个 child 报告截断上限（防父上下文膨胀连带父侧 compaction）。 */
export const SUBAGENT_REPORT_CHAR_LIMIT = 8000;

/** 单个 child 工具调用预算（超限 abort；child 无 LoopGuard 的 backstop）。 */
export const MAX_CHILD_TOOL_CALLS = 15;

export function truncateReport(text: string): { report: string; truncated: boolean } {
  if (text.length <= SUBAGENT_REPORT_CHAR_LIMIT) {
    return { report: text, truncated: false };
  }
  return {
    report: `${text.slice(0, SUBAGENT_REPORT_CHAR_LIMIT)}\n\n[子任务报告过长，已截断前 ${SUBAGENT_REPORT_CHAR_LIMIT} 字符]`,
    truncated: true,
  };
}

export interface SubagentRunnerDeps {
  cwd: string;
  /** 继承父模型（MVP 不降级，profile.model 预留暂不启用）。 */
  model: Model<Api>;
  authStorage: AuthStorage;
  thinkingLevel: PiThinkingLevel;
  search: ResolvedSearchEndpoint;
  /** 父会话已配置 Chrome MCP 时的只读浏览工具（未配置传空数组）。 */
  chromeBrowsingTools: ToolDefinition[];
  mergeCustomTools: (...groups: ToolDefinition[][]) => ToolDefinition[];
  /**
   * Phase 7.1.2：document/general child 的写权限审批三件套。
   * permission hook 安装时 sessionId 传 parentSessionId（§1.10 第 1 点），
   * sourceLabel 取本次 dispatch 的 description（弹窗「来自」行）。
   * research 不需要（只读不触发），缺省即不安装。
   */
  parentSessionId: string;
  /** 父会话同款 skillPaths（document/general 加载 PPTX/DOCX 等 skills；research 为空）。 */
  skillPaths?: string[];
  permissionDeps?: PermissionHookDeps;
}

export interface SubagentProgress {
  phase: 'started' | 'tool' | 'done';
  toolCallCount: number;
  toolName?: string;
}

export interface SubagentRunInput {
  profile: SubagentProfileName;
  description: string;
  prompt: string;
  /**
   * runner 创建 child 后回调用：注册 `() => childSession.abort()`。
   * tool 侧的 parentSignal 监听器经此闭包触发取消（§3.6 唯一级联通道）。
   */
  registerAbort?: (abort: () => void) => void;
  onProgress?: (progress: SubagentProgress) => void;
}

export interface SubagentRunResult {
  report: string;
  truncated: boolean;
  toolCallCount: number;
  durationMs: number;
  /** true = 被 parentSignal/预算 abort，非正常收敛。 */
  aborted: boolean;
}

function buildWebSearchTool(
  search: ResolvedSearchEndpoint
): ToolDefinition<TSchema, unknown> | null {
  if (search.engine === 'none' || search.engine === 'chrome-mcp') {
    return null;
  }
  const parameters = Type.Object({
    query: Type.String({ description: '检索关键词' }),
  });
  return {
    name: 'web_search',
    label: 'Web Search',
    description:
      '联网检索（只读）。多来源调研时可多次调用换关键词交叉验证。返回"标题+摘要+链接"文本。',
    parameters,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const query = (params as { query: string }).query;
      if (!query.trim()) {
        throw new Error('web_search: query is required');
      }
      const text = await performSearch(query, search);
      return { content: [{ type: 'text' as const, text }], details: null };
    },
  };
}

/**
 * 跑一个一次性 child（完整 agent loop），收敛为截断后的最终文本报告。
 * 调用方（subagent-tool）负责：并发闸门、轮次预算、parentSignal 级联、dispose 保底。
 */
export async function runSubagent(
  input: SubagentRunInput,
  deps: SubagentRunnerDeps
): Promise<SubagentRunResult> {
  const startedAt = Date.now();
  const profile = getSubagentProfile(input.profile, deps.cwd);
  const startedLogAt = new Date(startedAt).toISOString();
  log(
    `[SubagentRunner] start profile=${input.profile} desc=${input.description.slice(0, 80)} at=${startedLogAt}`
  );

  const readOnly = input.profile === 'research';
  const builtinTools = readOnly
    ? createReadOnlyTools(deps.cwd)
    : wrapBashToolWithDefaultTimeout(createCodingTools(deps.cwd));
  const webSearchTool = buildWebSearchTool(deps.search);
  // engine='none' = 彻底断网：连 Chrome MCP 浏览工具也不并入。
  // （'chrome-mcp' 引擎才用 Chrome 工具充当联网入口；'none' 必须是什么都不留。）
  const browsingTools = deps.search.engine === 'none' ? [] : (deps.chromeBrowsingTools ?? []);
  const customTools = deps.mergeCustomTools(webSearchTool ? [webSearchTool] : [], browsingTools);
  log(
    `[SubagentRunner] child tools: ${(builtinTools as { name?: string }[]).map((t) => t.name ?? '?').join(',')} + custom: ${customTools.map((t) => t.name).join(',') || '(none)'}`
  );

  const resourceLoader = new DefaultResourceLoader({
    cwd: deps.cwd,
    // research 跳过 skills 加载（冷启动最快）；document/general 加载父同款 skills
    ...(readOnly
      ? {
          noSkills: true,
          noExtensions: true,
          noPromptTemplates: true,
          noThemes: true,
        }
      : {
          // 全面安装制：关闭 SDK skills 自动发现，只加载父会话传入的
          // additionalSkillPaths（全局目录启用项）。
          noSkills: true,
          additionalSkillPaths: deps.skillPaths ?? [],
          noExtensions: true,
          noPromptTemplates: true,
          noThemes: true,
        }),
    appendSystemPromptOverride: () => [profile.systemPrompt],
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  });
  await resourceLoader.reload();

  const { session: childSession } = await createAgentSession({
    model: deps.model,
    thinkingLevel: deps.thinkingLevel,
    authStorage: deps.authStorage,
    // tools 形参要 SDK Tool[]（4 参 execute）；包装后的 ToolDefinition[] 多一个
    // ctx 参，session runner 实际不传——同 session-factory.ts 的已知安全 cast。
    tools: builtinTools as unknown as ReturnType<typeof createCodingTools>,
    customTools,
    sessionManager: PiSessionManager.inMemory(),
    settingsManager: PiSettingsManager.inMemory({
      retry: { enabled: true, maxRetries: 2 },
    }),
    resourceLoader,
    cwd: deps.cwd,
  });

  // document/general：安装权限钩子，sessionId 传父 sessionId（§1.10 第 1 点），
  // 来源标注取本次 dispatch description。research 只读不安装。
  if (!readOnly && deps.permissionDeps?.requestPermission) {
    installPermissionHook(childSession, deps.parentSessionId, deps.cwd, {
      ...deps.permissionDeps,
      sourceLabel: input.description,
    });
  }

  let toolCallCount = 0;
  let budgetExceeded = false;
  // §3.6 唯一级联通道的 child 侧：tool 侧 parentSignal 监听器经此闭包 abort child。
  input.registerAbort?.(() => {
    try {
      void childSession.abort();
    } catch (error) {
      logWarn('[SubagentRunner] child abort threw:', error);
    }
  });
  const unsubscribe = childSession.subscribe((event) => {
    const type = (event as { type?: string }).type;
    if (type === 'tool_execution_start') {
      toolCallCount += 1;
      const name = (event as { toolName?: string }).toolName;
      input.onProgress?.({ phase: 'tool', toolCallCount, toolName: name });
      if (toolCallCount > MAX_CHILD_TOOL_CALLS) {
        budgetExceeded = true;
        logWarn(
          `[SubagentRunner] tool budget exceeded (${toolCallCount}/${MAX_CHILD_TOOL_CALLS}), aborting child`
        );
        void childSession.abort();
      }
    }
  });

  let aborted = false;
  try {
    input.onProgress?.({ phase: 'started', toolCallCount: 0 });
    await childSession.prompt(input.prompt);
    const report = extractLastAssistantText(childSession);
    const { report: truncatedReport, truncated } = truncateReport(report);
    input.onProgress?.({ phase: 'done', toolCallCount });
    const durationMs = Date.now() - startedAt;
    // 用量透出（对标 Cline per-subagent 统计）：渲染层经父事件桥可见
    log(
      `[SubagentRunner] done profile=${input.profile} toolCalls=${toolCallCount} ` +
        `chars=${report.length} truncated=${truncated} durationMs=${durationMs} ` +
        `aborted=${aborted || budgetExceeded}`
    );
    return {
      report: truncatedReport,
      truncated,
      toolCallCount,
      durationMs,
      aborted: aborted || budgetExceeded,
    };
  } catch (error) {
    aborted = true;
    logError('[SubagentRunner] child run failed:', error);
    throw error;
  } finally {
    try {
      unsubscribe();
    } catch {
      // ignore
    }
  }
}

/**
 * 从 child 会话分支取最后一条 assistant 文本（聚焦报告）。
 * 经 SessionManager 分支消息 rather than prompt() 返回值（后者形态随版本变）。
 */
function extractLastAssistantText(childSession: {
  sessionManager: { getBranch?: () => Array<{ type?: string; message?: unknown }> };
}): string {
  try {
    const branch = childSession.sessionManager.getBranch?.() ?? [];
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i];
      const text = extractTextFromMessage(entry.message);
      if (text.trim()) return text.trim();
    }
  } catch (error) {
    logWarn('[SubagentRunner] extract report failed, fallback to empty:', error);
  }
  return '';
}

function extractTextFromMessage(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  // Anthropic/OpenAI 形态：content 为 block 数组
  const content = record.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
      } else if (typeof block === 'string') {
        parts.push(block);
      }
    }
    if (parts.length > 0) return parts.join('\n');
  }
  if (typeof content === 'string') return content;
  return '';
}
