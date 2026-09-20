/**
 * @module main/claude/pipeline/session-factory
 *
 * Stage 3：PiSessionFactory（AGENT-RUNNER-REFACTOR-PLAN.md §5.5.1 修订版）。
 *
 * 职责：管理 pi-coding-agent Session 的创建、缓存、复用、热替换，并承载
 * **复用路径的运行时策略应用**（applyRuntimeStrategies）——这是「prompt/thinking
 * 按 run 动态生效」的落点。新建路径由 createAgentSession 构造参数直接生效，
 * 无需再调（HIGH-4）。
 *
 * 关键设计：
 * - 签名（buildSignature）= runtimeSignature（含 apiKeyFingerprint，R1：不订阅
 *   AuthStorage，密钥轮换靠签名变化触发重建）+ skillsSignature + MCP 配置指纹。
 *   任一变化 → dispose + 重建。MCP 指纹入签是 §5.5.3 的**有意行为变更**：
 *   SDK 的 _customTools 在 createAgentSession 时冻结、reload() 不刷新，
 *   因此 MCP 服务器配置变更只能通过重建会话送达。
 * - appendSystemPromptOverride 使用 mutable 闭包（appendPrompt.current）：
 *   复用路径先更新闭包、再 reload()，DefaultResourceLoader 在 reload 周期内
 *   重新求值闭包 → system prompt 完成切换（SDK 0.60 已验证）。
 * - **绝不按任务类型裁剪工具**（§3.3 锁定），也从不调用 setActiveToolsByName。
 * - HIGH-1（降级定位，§零 R2）：resolveOrCreate 入口 chain.enqueue(sessionId)
 *   串行化——上游 session-manager 的 promptQueues 已按 session 串行，此处为
 *   第二道防线，防未来调用方绕过队列直接并发调用。
 * - MEDIUM-1：Ollama _onPayload num_ctx 补丁封装在 create() 内，仅新建路径
 *   执行一次；复用路径通过缓存条目里的 ollamaNumCtx 引用热更新数值。
 *
 * 拆分 API 的调用顺序约束（runner 侧）：
 *   1. invalidateIfStale()  —— 在 extensionManager.beforeSessionRun 之前调用，
 *      保证 isColdStart 判定（冷启动历史注入）反映真实的缓存状态；
 *   2. hasValidSession()    —— peek，供 isColdStart 取值；
 *   3. resolveOrCreate()    —— prompt/工具组装完成后调用（AsyncChain 护栏内）。
 */
import {
  createAgentSession,
  SessionManager as PiSessionManager,
  SettingsManager as PiSettingsManager,
  createCodingTools,
  type AgentSession as PiAgentSession,
} from '@mariozechner/pi-coding-agent';
import { ModelRegistry } from '../shared-auth';
import { installPermissionHook } from '../tools/permission-hook';
import { buildPiSessionRuntimeSignature } from '../pi-session-runtime';
import { log, logWarn, logCtx } from '../../utils/logger';
import { AsyncChain } from '../../utils/async-chain';
import type { SessionInput, SessionOutput, SessionSignatureInput } from './context-types';

interface CachedPiSession {
  session: PiAgentSession;
  modelId: string;
  thinkingLevel: string;
  /** buildSignature() 的组合签名（runtime + skills + mcp）。 */
  signature: string;
  /** 分量缓存：失配时用于定位变化来源并输出与原实现一致的日志。 */
  runtimeSignature: string;
  skillsSignature: string;
  mcpFingerprint: string;
  /**
   * appendSystemPromptOverride 的 mutable 闭包引用。
   * 复用路径先写 current 再 reload()，loader 重新求值闭包完成 prompt 切换。
   */
  appendPrompt: { current: string };
  /** Ollama num_ctx 热更新引用（MEDIUM-1）；仅 provider === 'ollama' 时存在。 */
  ollamaNumCtx?: { value: number };
}

/**
 * Ollama 专用 compaction 调优（按实际上下文窗口分档）。
 * 导出为纯函数以便单测（原 agent-runner.ts create 路径内联逻辑）。
 */
export function resolveCompactionSettings(
  provider: string,
  contextWindow: number
): { enabled: boolean; reserveTokens?: number; keepRecentTokens?: number } {
  if (provider === 'ollama' && contextWindow < 16384) {
    // Very small context: disable compaction (weak models produce unreliable summaries)
    log(
      '[ClaudeAgentRunner] Ollama small context model, disabling auto-compaction (contextWindow:',
      contextWindow,
      ')'
    );
    return { enabled: false };
  }
  if (provider === 'ollama' && contextWindow < 65536) {
    // Medium context: scale reserves proportionally
    const settings = {
      enabled: true,
      reserveTokens: Math.floor(contextWindow * 0.15),
      keepRecentTokens: Math.floor(contextWindow * 0.25),
    };
    log('[ClaudeAgentRunner] Ollama medium context, scaled compaction:', JSON.stringify(settings));
    return settings;
  }
  return { enabled: true };
}

export class PiSessionFactory {
  static readonly MAX_CACHED_SESSIONS = 50;

  private readonly cache = new Map<string, CachedPiSession>();
  // HIGH-1（护栏定位，见 §零 R2）：同 sessionId 串行，不同 sessionId 互不阻塞。
  private readonly chain = new AsyncChain<string>();

  /**
   * 组合签名：runtimeSignature（含 apiKeyFingerprint，R1）+ skills + MCP 指纹。
   * 纯函数——session-factory.test.ts 对它做行为断言（§5.5.4 迁移目标）。
   */
  buildSignature(sig: SessionSignatureInput): string {
    return JSON.stringify({
      runtimeSignature: buildPiSessionRuntimeSignature(sig),
      skillsSignature: sig.skillsSignature ?? '',
      mcpFingerprint: sig.mcpFingerprint ?? '',
    });
  }

  /**
   * 早期失效检查（runner 在 beforeSessionRun / 历史组装**之前**调用）。
   * 三个分量按 runtime → skills → mcp 顺序检查，日志文案与原 agent-runner
   * 内联实现一致（'Runtime changed...' / 'Skills changed...' 为测试断言目标）。
   * MCP 指纹由 runner 提前计算传入（读取 mcpConfigStore.getEnabledServers，
   * 与下方 MCP 配置构建块共享同一次读取结果）。
   */
  invalidateIfStale(sessionId: string, sig: SessionSignatureInput): void {
    const cached = this.cache.get(sessionId);
    if (!cached) return;

    const runtimeSignature = buildPiSessionRuntimeSignature(sig);
    const skillsSignature = sig.skillsSignature ?? '';
    const mcpFingerprint = sig.mcpFingerprint ?? '';

    if (cached.runtimeSignature !== runtimeSignature) {
      logCtx('[ClaudeAgentRunner] Runtime changed, recreating cached pi session:', sessionId);
      this.disposeEntry(sessionId, 'dispose error while recreating pi session:');
    } else if (cached.skillsSignature !== skillsSignature) {
      logCtx('[ClaudeAgentRunner] Skills changed, recreating cached pi session:', sessionId);
      this.disposeEntry(sessionId, 'dispose error while recreating pi session for skills:');
    } else if (cached.mcpFingerprint !== mcpFingerprint) {
      // §5.5.3 有意行为变更：SDK 的 customTools 在 createAgentSession 时冻结、
      // reload() 不刷新，MCP 配置变化只能通过重建会话送达。
      logCtx('[ClaudeAgentRunner] MCP config changed, recreating cached pi session:', sessionId);
      this.disposeEntry(sessionId, 'dispose error while recreating pi session for mcp:');
    }
  }

  /** peek：当前是否存在可用缓存会话（供 runner 计算 isColdStart）。 */
  hasValidSession(sessionId: string): boolean {
    return this.cache.has(sessionId);
  }

  /**
   * 解析或创建会话。HIGH-4：仅复用路径调用 applyRuntimeStrategies
   * （闭包更新 → reload → model/thinking 热替换）；新建路径由
   * createAgentSession 构造参数直接生效。**从不调用 setActiveToolsByName**——
   * 工具集恒定全量（§3.3 锁定）。
   */
  async resolveOrCreate(input: SessionInput): Promise<SessionOutput> {
    // HIGH-1: 同 sessionId 串行化执行
    return this.chain.enqueue(input.sessionId, async () => {
      const signature = this.buildSignature(input.signature);
      const cached = this.cache.get(input.sessionId);

      if (cached && cached.signature === signature) {
        await this.applyRuntimeStrategies(cached, input);
        return { piSession: cached.session, isReused: true };
      }

      // 签名失配（正常流程下 invalidateIfStale 已提前处理；这里是
      // 早期检查与 resolveOrCreate 之间状态又变化时的兜底）→ dispose + 重建
      if (cached) {
        logCtx(
          '[ClaudeAgentRunner] Signature changed, recreating cached pi session:',
          input.sessionId
        );
        this.disposeEntry(input.sessionId, 'dispose error while recreating pi session:');
      }

      return this.create(input, signature);
    });
  }

  /** 清理单个会话（session-manager 在 cwd 变化时调用）。 */
  clearSession(sessionId: string): void {
    const cached = this.cache.get(sessionId);
    if (cached) {
      this.disposeEntry(sessionId, 'dispose error:');
      log('[ClaudeAgentRunner] Disposed pi session for:', sessionId);
    }
  }

  /** 清理全部会话。 */
  clearAll(): void {
    for (const sessionId of Array.from(this.cache.keys())) {
      this.clearSession(sessionId);
    }
  }

  /** 释放工厂（应用退出路径）；等价于 clearAll。 */
  dispose(): void {
    this.clearAll();
  }

  // ── 内部实现 ──

  /**
   * 复用路径的运行时策略应用（HIGH-4 / §3.2）。顺序不可调换：
   * 1. 更新 appendPrompt 闭包（reload 时 loader 重新求值）
   * 2. await reload() → system prompt 切换（_customTools/_baseToolsOverride/
   *    权限钩子均随 Agent 实例存活，SDK 0.60 已验证）
   * 3. model 热替换（setModel + Ollama num_ctx 引用更新）
   * 4. thinking 热替换（setThinkingLevel，SDK 侧幂等：仅在变化时持久化）
   */
  private async applyRuntimeStrategies(
    cached: CachedPiSession,
    input: SessionInput
  ): Promise<void> {
    const { piModel } = input.modelCtx;

    // 1+2. prompt 切换：先写闭包，再 reload
    cached.appendPrompt.current = input.prompt.systemPrompt;
    await cached.session.reload();

    // 3. model 热替换
    if (cached.modelId !== piModel.id) {
      logCtx('[ClaudeAgentRunner] Model changed, hot-swapping:', cached.modelId, '→', piModel.id);
      await cached.session.setModel(piModel);
      cached.modelId = piModel.id;
      if (cached.ollamaNumCtx) {
        cached.ollamaNumCtx.value = piModel.contextWindow || 128000;
        log('[ClaudeAgentRunner] Updated Ollama num_ctx on hot-swap:', cached.ollamaNumCtx.value);
      }
    }

    // 4. thinking 热替换（每次复用 run 都调用；SDK 仅在变化时持久化）
    if (cached.thinkingLevel !== input.thinkingLevel) {
      logCtx(
        '[ClaudeAgentRunner] Thinking level changed, hot-swapping:',
        cached.thinkingLevel,
        '→',
        input.thinkingLevel
      );
    }
    cached.session.setThinkingLevel(input.thinkingLevel);
    cached.thinkingLevel = input.thinkingLevel;

    logCtx('[ClaudeAgentRunner] Reusing cached pi session for:', input.sessionId);
  }

  /** 新建路径：loader/registry/compaction/createAgentSession/权限钩子/入缓存。 */
  private async create(input: SessionInput, signature: string): Promise<SessionOutput> {
    const { modelCtx, taskCtx } = input;
    const { piModel, authStorage } = modelCtx;
    const effectiveCwd = taskCtx.effectiveCwd;
    const skillPaths = input.skillPaths;

    // ResourceLoader + ModelRegistry only needed for session creation — skip on reuse.
    // appendSystemPromptOverride 用 mutable 闭包：复用路径更新 appendPrompt.current
    // 后调 reload()，loader 在 reload 周期内重新求值（SDK resource-loader.js:292-296）。
    const appendPrompt = { current: input.prompt.systemPrompt };
    const { DefaultResourceLoader } = await import('@mariozechner/pi-coding-agent');
    const resourceLoader = new DefaultResourceLoader({
      cwd: effectiveCwd,
      additionalSkillPaths: skillPaths,
      appendSystemPromptOverride: () => (appendPrompt.current ? [appendPrompt.current] : []),
      agentsFilesOverride: () => ({
        agentsFiles: [],
      }),
    });
    await resourceLoader.reload();

    const modelRegistry = new ModelRegistry(authStorage);

    const contextWindow = piModel.contextWindow || 128000;
    const compactionSettings = resolveCompactionSettings(modelCtx.provider, contextWindow);

    const { session: newPiSession } = await createAgentSession({
      model: piModel,
      thinkingLevel: input.thinkingLevel,
      authStorage,
      modelRegistry,
      tools: input.tools.codingTools as unknown as ReturnType<typeof createCodingTools>,
      customTools: input.customTools,
      sessionManager: PiSessionManager.inMemory(),
      settingsManager: PiSettingsManager.inMemory({
        compaction: compactionSettings,
        retry: { enabled: true, maxRetries: 2 },
      }),
      resourceLoader,
      cwd: effectiveCwd,
    });

    // Install permission-gating hook via the SDK's tool_call extension event.
    // This must happen once per new session — the hook persists across reuses
    // (SDK 的 _installAgentToolHooks 在执行时读取 _extensionRunner，reload 后仍生效)。
    installPermissionHook(newPiSession, input.sessionId, input.sessionCwd, input.permissionDeps);

    // Store session for reuse — evict oldest if cache is full
    if (this.cache.size >= PiSessionFactory.MAX_CACHED_SESSIONS) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.disposeEntry(oldestKey, 'dispose error on eviction:');
        log('[ClaudeAgentRunner] Evicted oldest cached session:', oldestKey);
      }
    }
    this.cache.set(input.sessionId, {
      session: newPiSession,
      modelId: piModel.id,
      thinkingLevel: input.thinkingLevel,
      signature,
      runtimeSignature: buildPiSessionRuntimeSignature(input.signature),
      skillsSignature: input.signature.skillsSignature ?? '',
      mcpFingerprint: input.signature.mcpFingerprint ?? '',
      appendPrompt,
    });

    // MEDIUM-1: Ollama _onPayload num_ctx 补丁只在 create() 内应用一次
    if (modelCtx.provider === 'ollama') {
      this.applyOllamaPayloadPatch(input.sessionId, newPiSession, contextWindow);
    }

    return { piSession: newPiSession, isReused: false };
  }

  /**
   * Ollama: wrap _onPayload to inject num_ctx into every request.
   * 数值通过缓存条目上的 ollamaNumCtx 引用热更新（model 切换时同步）。
   */
  private applyOllamaPayloadPatch(
    sessionId: string,
    piSession: PiAgentSession,
    contextWindow: number
  ): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agent = piSession.agent as any;
    // Guard: only patch if the SDK exposes _onPayload (private API)
    if (!agent || !('_onPayload' in agent)) {
      logWarn(
        '[ClaudeAgentRunner] SDK agent does not expose _onPayload — skipping Ollama num_ctx patch'
      );
      return;
    }
    const originalOnPayload = agent._onPayload as
      | ((payload: Record<string, unknown>, modelArg: unknown) => Promise<Record<string, unknown>>)
      | undefined;
    const ollamaNumCtx = { value: contextWindow };
    agent._onPayload = async (payload: Record<string, unknown>, modelArg: unknown) => {
      let result = originalOnPayload
        ? await originalOnPayload.call(agent, payload, modelArg)
        : payload;
      if (result === undefined) result = payload;
      return { ...result, num_ctx: ollamaNumCtx.value };
    };
    const cached = this.cache.get(sessionId);
    if (cached) cached.ollamaNumCtx = ollamaNumCtx;
    log('[ClaudeAgentRunner] Ollama _onPayload wrapper installed, num_ctx:', ollamaNumCtx.value);
  }

  private disposeEntry(sessionId: string, warnMessage: string): void {
    const cached = this.cache.get(sessionId);
    if (!cached) return;
    try {
      cached.session.dispose();
    } catch (disposeError) {
      logWarn(`[ClaudeAgentRunner] ${warnMessage}`, disposeError);
    }
    this.cache.delete(sessionId);
  }
}
