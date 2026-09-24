/**
 * @module main/claude/agent-runner
 *
 * AI 查询执行编排器（Phase 0-6 重构后；AGENT-RUNNER-REFACTOR-PLAN.md §2.1-§2.2）。
 *
 * 架构地图（原 3322 行 God Class 拆分后各阶段落点）：
 * - Stage 0 沙箱准备/回同步           → 本文件 run()（合法留在编排器）
 * - Stage 1 模型解析                  → pi-model-resolution.ts
 * - Stage 2 任务分类 + 三策略         → pipeline/task-classifier + prompt/tool/thinking-strategy
 * - Stage 3 会话装配                  → pipeline/session-factory（PiSessionFactory）
 *   + 冷启动历史                      → pipeline/cold-start-history
 *   + MCP servers 配置                → 本文件 buildMcpServersConfig()（Phase 6 提取）
 *   + MCP customTools 桥接            → tools/mcp-tool-bridge
 *   + 权限钩子                        → tools/permission-hook
 *   + skills 目录/路径管理            → skills-runtime.ts
 * - Stage 4 执行（事件流桥接/loop guard/prompt）→ 本文件 run()（合法留在编排器）
 * - Stage 5 收尾（abort 判定/trace/沙箱回同步） → 本文件 run()
 *
 * 行为不变量：工具集恒定全量、从不按任务裁剪（§3.3）；从不调用
 * setActiveToolsByName；session 缓存签名机制维持（含 apiKeyFingerprint，R1）。
 *
 * Responsibilities:
 * - Runs AI conversations via the 今点通 agent SDK (createAgentSession)
 * - Routes providers via pi-ai SDK for model resolution
 * - Bridges MCP tools into SDK ToolDefinition format
 * - Streams responses back as ServerEvents (stream.message, stream.partial, trace.step)
 * - Skills injection, system prompt assembly, permission handling
 *
 * Dependencies: session-manager, mcp-manager, config-store, skills-manager
 */
import { type BashToolOptions } from '@mariozechner/pi-coding-agent';
import { getSharedAuthStorage } from './shared-auth';
import type { Session, Message, TraceStep, ServerEvent, ContentBlock } from '../../renderer/types';
import { v4 as uuidv4 } from 'uuid';
import { PathResolver } from '../sandbox/path-resolver';
import { MCPManager } from '../mcp/mcp-manager';
import { mcpConfigStore } from '../mcp/mcp-config-store';
import {
  log,
  logWarn,
  logError,
  logCtx,
  logCtxWarn,
  logCtxError,
  logTiming,
} from '../utils/logger';
import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { setMaxListeners } from 'node:events';
import { getSandboxAdapter } from '../sandbox/sandbox-adapter';
import { pathConverter } from '../sandbox/wsl-bridge';
import { SandboxSync } from '../sandbox/sandbox-sync';
import {
  extractArtifactsFromText,
  buildArtifactTraceSteps,
  buildArtifactCompletionText,
} from '../utils/artifact-parser';
import { classifyTask } from './pipeline/task-classifier';
import { PromptStrategy, VIRTUAL_WORKSPACE_PATH } from './pipeline/prompt-strategy';
import { ToolStrategy } from './pipeline/tool-strategy';
import { ThinkingStrategy } from './pipeline/thinking-strategy';
import type { ModelContext, PiThinkingLevel, TaskContext } from './pipeline/context-types';
import { PluginRuntimeService } from '../skills/plugin-runtime-service';
import type { SkillsAdapter } from '../skills/skills-adapter';
import { SkillsRuntime } from './skills-runtime';
import { AgentRuntimeExtensionManager } from '../extensions/agent-runtime-extension-manager';
import { configStore } from '../config/config-store';
import { normalizeOpenAICompatibleBaseUrl } from '../config/auth-utils';
import {
  buildTerminalErrorEmissionDetails,
  buildTerminalErrorMessage,
  resolveAbortDisposition,
  resolveAssistantStreamErrorText,
  resolveMessageEndPayload,
  shouldPreserveExistingTrace,
  toUserFacingErrorText,
} from './agent-runner-message-end';
import {
  applyPiModelRuntimeOverrides,
  buildSyntheticPiModel,
  resolvePiRegistryModel,
  resolvePiRouteProtocol,
  resolveSyntheticPiModelFallback,
} from './pi-model-resolution';
import { ThinkTagStreamParser } from './think-tag-parser';
import {
  attachDeferredMemoryInjection,
  type DeferredMemoryInjectionHandle,
} from './deferred-memory-injector';
import {
  LoopGuard,
  buildAbortUserMessage,
  buildHaltSteerMessage,
  buildWarnSteerMessage,
  type LoopGuardDecision,
  type ToolCallDescriptor,
} from './agent-runner-loop-guard';
import { normalizeToolExecutionResultForUi } from './tool-result-utils';
import { fetchOllamaModelInfo } from '../config/ollama-api';
import { createWindowsBashOperations } from './windows-bash-operations';
import type { SessionSignatureInput } from './pipeline/context-types';
import { enrichProcessPathForBuild, getBundledNodePaths } from './pipeline/path-utils';
import {
  normalizeTokenUsage,
  safeStringify,
  summarizeMessageForLog,
  toErrorText,
} from './pipeline/utils';
import {
  buildColdStartContextualPrompt,
  serializeMessageContentForHistory,
} from './pipeline/cold-start-history';
import { expandSkillCommand } from './pipeline/skill-command';
import { PiSessionFactory } from './pipeline/session-factory';
import { buildMcpCustomTools } from './tools/mcp-tool-bridge';
// bash 工具包装链（timeout/sudo）已迁至 pipeline/tool-strategy.ts（Phase 4）。
// 冷启动历史序列化 + 组装已迁至 pipeline/cold-start-history.ts（Phase 1/5）；
// 此处 re-export 保持外部导入方（如 src/tests/claude/agent-runner-history-rebuild.test.ts）兼容。
export { serializeMessageContentForHistory };

// Virtual workspace path shown to the model (hides real sandbox path)
// （Phase 4 迁移至 pipeline/prompt-strategy.ts，此处改为 import 共享常量）

interface AgentRunnerOptions {
  sendToRenderer: (event: ServerEvent) => void;
  saveMessage?: (message: Message) => void;
  requestSudoPassword?: (
    sessionId: string,
    toolUseId: string,
    command: string
  ) => Promise<string | null>;
  requestPermission?: (
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    kind?: 'advanced' | 'delete' | 'outside' | 'normal'
  ) => Promise<'allow' | 'deny' | 'allow_always'>;
  sessionAllowAll?: (sessionId: string) => boolean;
}

// CachedPiSession 缓存已迁至 pipeline/session-factory.ts（Phase 5）。

/**
 * ClaudeAgentRunner - Uses @mariozechner/pi-coding-agent SDK
 *
 * Environment variables should be set before running:
 *   ANTHROPIC_BASE_URL=https://openrouter.ai/api
 *   ANTHROPIC_AUTH_TOKEN=your_openrouter_api_key
 *   ANTHROPIC_API_KEY="" (must be empty)
 */
export class ClaudeAgentRunner {
  private sendToRenderer: (event: ServerEvent) => void;
  private saveMessage?: (message: Message) => void;
  private requestSudoPassword?: (
    sessionId: string,
    toolUseId: string,
    command: string
  ) => Promise<string | null>;
  private requestPermission?: (
    sessionId: string,
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
    kind?: 'advanced' | 'delete' | 'outside' | 'normal'
  ) => Promise<'allow' | 'deny' | 'allow_always'>;
  private optionsAllowAll?: (sessionId: string) => boolean;
  private pathResolver: PathResolver;
  private mcpManager?: MCPManager;
  private readonly skillsRuntime: SkillsRuntime;
  private extensionManager?: AgentRuntimeExtensionManager;
  private activeControllers: Map<string, AbortController> = new Map();
  /**
   * Set when cancel() is invoked by a user stop. Consumed once by the turn
   * that was in flight, so a later natural completion can't mistake an old
   * flag for a fresh stop.
   */
  private userStopFlags: Set<string> = new Set();
  private toolDisplayNameCache: Map<string, string> = new Map();
  // Stage 3（Phase 5）：pi session 缓存/签名/热替换全部移入 PiSessionFactory。
  private readonly sessionFactory = new PiSessionFactory();

  // Stage 2 策略（Phase 4，pipeline/*）：无状态，实例级单例即可
  private readonly promptStrategy = new PromptStrategy();
  private readonly toolStrategy = new ToolStrategy();
  private readonly thinkingStrategy = new ThinkingStrategy();

  // Per-instance caches — invalidated when the underlying config changes.
  private _mcpServersCache: { fingerprint: string; servers: Record<string, unknown> } | null = null;

  /**
   * Clear SDK session cache for a session
   * Called when session's cwd changes - SDK sessions are bound to cwd
   */
  clearSdkSession(sessionId: string): void {
    this.sessionFactory.clearSession(sessionId);
  }

  clearAllSdkSessions(): void {
    this.sessionFactory.clearAll();
  }

  /** Call after the user installs / removes a skill so the next query re-links everything. */
  invalidateSkillsSetup(): void {
    this.skillsRuntime.invalidate();
  }

  /** Call after the user changes MCP server config so the next query rebuilds mcpServers. */
  invalidateMcpServersCache(): void {
    this._mcpServersCache = null;
    // Phase 5（§5.5.3 有意行为变更）：MCP 指纹已并入 session 签名——
    // 配置变化的会话在下一次 run() 被 dispose + 重建（SDK 的 customTools
    // 在 createAgentSession 时冻结，reload() 不刷新，重建是唯一送达途径）。
    log('[ClaudeAgentRunner] MCP servers cache invalidated — tools will rebuild on next query');
  }

  // TODO: Credentials should be served via a secure MCP tool or IPC channel,
  // not injected as plaintext into the system prompt. The getCredentialsPrompt()
  // method was removed to eliminate credential leakage risk.

  // getBundledPathHints()（Phase 4 迁移至 pipeline/prompt-strategy.ts 的自由函数，
  // 由 PromptStrategy.assemble 统一注入 <bundled_executables> 段。）

  constructor(
    options: AgentRunnerOptions,
    pathResolver: PathResolver,
    mcpManager?: MCPManager,
    pluginRuntimeService?: PluginRuntimeService,
    skillsAdapter?: SkillsAdapter,
    extensionManager?: AgentRuntimeExtensionManager
  ) {
    this.sendToRenderer = options.sendToRenderer;
    this.saveMessage = options.saveMessage;
    this.requestSudoPassword = options.requestSudoPassword;
    this.requestPermission = options.requestPermission;
    this.optionsAllowAll = options.sessionAllowAll;
    this.pathResolver = pathResolver;
    this.mcpManager = mcpManager;
    this.skillsRuntime = new SkillsRuntime({
      sendToRenderer: options.sendToRenderer,
      pluginRuntimeService,
      skillsAdapter,
    });
    this.extensionManager = extensionManager;

    log('[ClaudeAgentRunner] Initialized with 今点通 agent SDK');
    log('[ClaudeAgentRunner] Skills enabled: settingSources=[user, project], Skill tool enabled');
    if (mcpManager) {
      log('[ClaudeAgentRunner] MCP support enabled');
    }
  }

  /**
   * 工具显示名解析（MCP sanitized 名 → 原始名）。
   * 权限钩子已迁至 tools/permission-hook.ts（Phase 3），通过 deps 注入本方法复用缓存。
   */
  private getToolDisplayName(toolName: string): string {
    const cached = this.toolDisplayNameCache.get(toolName);
    if (cached) {
      return cached;
    }

    let displayName = toolName;
    if (!toolName.startsWith('mcp__')) {
      this.toolDisplayNameCache.set(toolName, displayName);
      return displayName;
    }

    const mcpTool = this.mcpManager?.getTool(toolName);
    if (mcpTool?.originalName) {
      displayName = mcpTool.originalName;
    } else {
      const match = toolName.match(/^mcp__(.+?)__(.+)$/);
      displayName = match?.[2] || toolName;
    }

    this.toolDisplayNameCache.set(toolName, displayName);
    return displayName;
  }

  /**
   * Resolve current model string from runtime config.
   */
  private getCurrentModelString(preferredModel?: string): string {
    const routeModel = preferredModel?.trim();
    const configuredModel = configStore.get('model')?.trim();
    const model = routeModel || configuredModel || 'anthropic/claude-sonnet-4-6';
    logCtx('[ClaudeAgentRunner] Current model:', model);
    logCtx(
      '[ClaudeAgentRunner] Model source:',
      routeModel ? 'runtimeRoute.model' : configuredModel ? 'configStore.model' : 'default'
    );
    return model;
  }

  /**
   * Stage 3a：构建 SDK mcpServers 配置（Phase 6 从 run() 内联块提取，行为不变）。
   *
   * - 指纹命中 `_mcpServersCache` 时直接复用（bundled node 路径进程内稳定，不入指纹）；
   * - stdio 服务器：npx/node 命令替换为内置路径 + PATH 注入；
   *   `{SOFTWARE_DEV_SERVER_PATH}` / `{GUI_OPERATE_SERVER_PATH}` 占位符经
   *   mcpConfigStore.createFromPreset 解析；
   * - 单服务器构建失败仅跳过该服务器（'Failed to prepare MCP server config'）；
   * - 结果写回缓存并输出 summary 日志（COWORK_LOG_SDK_MESSAGES_FULL=1 时输出全量）。
   *
   * 注意：返回值当前仅供日志/缓存——MCP 工具本体经 buildMcpCustomTools
   * 以 customTools 桥接进 SDK（tools/mcp-tool-bridge.ts），不走 mcpServers 字段。
   */
  private buildMcpServersConfig(input: {
    mcpFingerprint: string;
    allConfigs: ReturnType<typeof mcpConfigStore.getEnabledServers>;
    imageCapable: boolean;
  }): Record<string, unknown> {
    const { mcpFingerprint, allConfigs, imageCapable } = input;

    // Build MCP servers configuration for SDK
    // IMPORTANT: SDK uses tool names in format: mcp__<ServerKey>__<toolName>
    const mcpServers: Record<string, unknown> = {};
    if (!this.mcpManager) {
      return mcpServers;
    }

    const serverStatuses = this.mcpManager.getServerStatus();
    const connectedServers = serverStatuses.filter((s) => s.connected);
    log('[ClaudeAgentRunner] MCP server statuses:', safeStringify(serverStatuses));
    log('[ClaudeAgentRunner] Connected MCP servers:', connectedServers.length);

    if (this._mcpServersCache?.fingerprint === mcpFingerprint) {
      Object.assign(mcpServers, this._mcpServersCache.servers);
      log('[ClaudeAgentRunner] MCP servers config reused from cache');
    } else {
      // Use the module-level memoized helper — no more per-query fs.existsSync calls.
      const bundledNodePaths = getBundledNodePaths();
      const bundledNpx = bundledNodePaths?.npx ?? null;

      for (const config of allConfigs) {
        try {
          // Use a simpler key without spaces to avoid issues
          const serverKey = config.name;

          if (config.type === 'stdio') {
            // 当命令是 npx 或 node 时优先使用内置路径
            const command =
              config.command === 'npx' && bundledNpx
                ? bundledNpx
                : config.command === 'node' && bundledNodePaths
                  ? bundledNodePaths.node
                  : config.command;

            // 使用内置 npx/node 时，将内置 node bin 注入 PATH
            const serverEnv = { ...config.env };
            if (bundledNodePaths && (config.command === 'npx' || config.command === 'node')) {
              const nodeBinDir = path.dirname(bundledNodePaths.node);
              const currentPath = process.env.PATH || '';
              // Prepend bundled node bin to PATH so npx can find node
              serverEnv.PATH = `${nodeBinDir}${path.delimiter}${currentPath}`;
              log(`[ClaudeAgentRunner]   Added bundled node bin to PATH: ${nodeBinDir}`);
            }

            if (!imageCapable) {
              serverEnv.OPEN_COWORK_DISABLE_IMAGE_TOOL_OUTPUT = '1';
            }

            // Resolve path placeholders for presets
            let resolvedArgs = config.args || [];

            // Check if any args contain placeholders that need resolving
            const hasPlaceholders = resolvedArgs.some(
              (arg) =>
                arg.includes('{SOFTWARE_DEV_SERVER_PATH}') ||
                arg.includes('{GUI_OPERATE_SERVER_PATH}')
            );

            if (hasPlaceholders) {
              // Get the appropriate preset based on config name
              let presetKey: string | null = null;
              if (
                config.name === 'Software_Development' ||
                config.name === 'Software Development'
              ) {
                presetKey = 'software-development';
              } else if (config.name === 'GUI_Operate' || config.name === 'GUI Operate') {
                presetKey = 'gui-operate';
              }

              if (presetKey) {
                const preset = mcpConfigStore.createFromPreset(presetKey, true);
                if (preset && preset.args) {
                  resolvedArgs = preset.args;
                }
              }
            }

            mcpServers[serverKey] = {
              type: 'stdio',
              command,
              args: resolvedArgs,
              env: serverEnv,
            };
            log(`[ClaudeAgentRunner] Added STDIO MCP server: ${serverKey}`);
            log(`[ClaudeAgentRunner]   Command: ${command} ${resolvedArgs.join(' ')}`);
            log(`[ClaudeAgentRunner]   Tools will be named: mcp__${serverKey}__<toolName>`);
          } else if (config.type === 'sse') {
            mcpServers[serverKey] = {
              type: 'sse',
              url: config.url,
              headers: config.headers || {},
            };
            log(`[ClaudeAgentRunner] Added SSE MCP server: ${serverKey}`);
          }
        } catch (error) {
          logError('[ClaudeAgentRunner] Failed to prepare MCP server config, skipping server', {
            serverId: config.id,
            serverName: config.name,
            error: toErrorText(error),
          });
        }
      }

      // Store in cache for subsequent queries
      this._mcpServersCache = { fingerprint: mcpFingerprint, servers: { ...mcpServers } };
    }

    const mcpServersSummary = Object.entries(mcpServers).map(([name, serverConfig]) => {
      const typedServerConfig = serverConfig as {
        type?: string;
        command?: string;
        args?: unknown[];
        env?: Record<string, unknown>;
      };
      return {
        name,
        type: typedServerConfig.type ?? 'unknown',
        command: typedServerConfig.command ?? '',
        argsCount: Array.isArray(typedServerConfig.args) ? typedServerConfig.args.length : 0,
        envKeys: typedServerConfig.env ? Object.keys(typedServerConfig.env).length : 0,
      };
    });
    log('[ClaudeAgentRunner] Final mcpServers summary:', safeStringify(mcpServersSummary, 2));
    if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {
      log('[ClaudeAgentRunner] Final mcpServers config:', safeStringify(mcpServers, 2));
    }

    return mcpServers;
  }

  /**
   * 执行一次 AI 查询（编排器主入口）。
   *
   * Pipeline 分阶段（AGENT-RUNNER-REFACTOR-PLAN.md §2.1）：
   * - Stage 0：沙箱准备（WSL/Lima 同步、pathResolver 注册）
   * - Stage 1：模型解析（pi-model-resolution：路由协议/注册表/合成回退）
   * - Stage 2：任务分类 + 三策略（classifyTask → Prompt/Tool/ThinkingStrategy）
   * - Stage 3：会话装配（签名原料 → PiSessionFactory.invalidateIfStale →
   *   冷启动历史 → MCP servers 配置 → customTools → resolveOrCreate）
   * - Stage 4：执行（事件流桥接 + loop guard + prompt，留在本文件）
   * - Stage 5：收尾（abort 判定、trace 完成、沙箱回同步）
   */
  async run(session: Session, prompt: string, existingMessages: Message[]): Promise<void> {
    const runStartTime = Date.now();
    logCtx('[ClaudeAgentRunner] run() started');

    const controller = new AbortController();
    try {
      // SDK 会在同一 AbortSignal 上挂载较多监听器，放开上限避免无意义告警干扰排错。
      setMaxListeners(0, controller.signal);
    } catch {
      // 旧运行时不支持 EventTarget 调整监听上限时忽略即可。
    }
    this.activeControllers.set(session.id, controller);

    // Sandbox isolation state (defined outside try for finally access)
    let sandboxPath: string | null = null;
    let useSandboxIsolation = false;

    // Helper to convert real sandbox paths back to virtual workspace paths in output
    // Cache the compiled regex to avoid recompilation on every call
    let sandboxPathRegex: RegExp | null = null;
    const sanitizeOutputPaths = (content: string): string => {
      if (!sandboxPath || !useSandboxIsolation) return content;
      if (!sandboxPathRegex) {
        sandboxPathRegex = new RegExp(sandboxPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      }
      // Replace real sandbox path with virtual workspace path
      return content.replace(sandboxPathRegex, VIRTUAL_WORKSPACE_PATH);
    };

    const thinkingStepId = uuidv4();
    let abortedByTimeout = false;
    // Set to true when the loop-guard unilaterally aborts (hash_abort / freq_abort).
    // The catch block consults this flag to avoid overwriting the 'error' trace
    // status that handleLoopGuardDecision has already published.
    let abortedByLoopGuard = false;
    // Set to true when the provider emits a terminal stream error mid-turn.
    // The catch block consults this flag to avoid overwriting the published
    // 'Request failed' trace state with a generic 'Cancelled' update.
    let abortedByStreamError = false;
    // Pause-rescue buffer: the raw text streamed so far this turn, regardless
    // of which inner scope owns the event handler. The AbortError handler
    // below uses it to persist the half-written reply on user stop, so the
    // visible output is kept and "continue" can resume from it. The inner
    // event handler appends to it via the shared ref object.
    const pauseRescue: { text: string; persistedTextCount: number; apiCallCount: number } = {
      text: '',
      persistedTextCount: 0,
      apiCallCount: 0,
    };

    try {
      this.pathResolver.registerSession(session.id, session.mountedPaths);
      logTiming('pathResolver.registerSession', runStartTime);

      // Note: User message is now added by the frontend immediately for better UX
      // No need to send it again from backend

      // Send initial thinking trace
      this.sendTraceStep(session.id, {
        id: thinkingStepId,
        type: 'thinking',
        status: 'running',
        title: 'Processing request...',
        timestamp: Date.now(),
      });
      logTiming('sendTraceStep (thinking)', runStartTime);

      // Use session's cwd - each session has its own working directory
      const workingDir = session.cwd || undefined;
      logCtx('[ClaudeAgentRunner] Working directory:', workingDir || '(none)');

      // Initialize sandbox sync if WSL mode is active
      const sandbox = getSandboxAdapter();

      if (sandbox.isWSL && sandbox.wslStatus?.distro && workingDir) {
        log('[ClaudeAgentRunner] WSL mode active, initializing sandbox sync...');

        // Only show sync UI for new sessions (first message)
        const isNewSession = !SandboxSync.hasSession(session.id);

        if (isNewSession) {
          // Notify UI: syncing files (only for new sessions)
          this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_files',
              message: 'Syncing files to sandbox...',
              detail: 'Copying project files to isolated WSL environment',
            },
          });
        }

        const syncResult = await SandboxSync.initSync(
          workingDir,
          session.id,
          sandbox.wslStatus.distro
        );

        if (syncResult.success) {
          sandboxPath = syncResult.sandboxPath;
          useSandboxIsolation = true;
          log(`[ClaudeAgentRunner] Sandbox initialized: ${sandboxPath}`);
          log(
            `[ClaudeAgentRunner]   Files: ${syncResult.fileCount}, Size: ${syncResult.totalSize} bytes`
          );

          if (isNewSession) {
            // Update UI with file count (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'syncing_skills',
                message: 'Configuring skills...',
                detail: 'Copying built-in skills to sandbox',
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }

          // Copy skills to sandbox ~/.claude/skills/
          const builtinSkillsPath = this.skillsRuntime.getBuiltinSkillsPath();
          try {
            const distro = sandbox.wslStatus!.distro!;
            const sandboxSkillsPath = `${sandboxPath}/.claude/skills`;

            // Create .claude/skills directory in sandbox
            execFileSync('wsl', ['-d', distro, '-e', 'mkdir', '-p', sandboxSkillsPath], {
              encoding: 'utf-8',
              timeout: 10000,
            });

            if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
              // Use rsync via execFileSync with array args to avoid shell injection
              const wslSourcePath = pathConverter.toWSL(builtinSkillsPath);
              log(
                `[ClaudeAgentRunner] Copying skills with rsync: ${wslSourcePath}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'wsl',
                ['-d', distro, '-e', 'rsync', '-av', wslSourcePath + '/', sandboxSkillsPath + '/'],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            const appSkillsDir = this.skillsRuntime.getRuntimeSkillsDir();
            if (!fs.existsSync(appSkillsDir)) {
              fs.mkdirSync(appSkillsDir, { recursive: true });
            }
            this.skillsRuntime.syncUserSkillsToAppDir(appSkillsDir);
            this.skillsRuntime.syncConfiguredSkillsToRuntimeDir(appSkillsDir);

            if (fs.existsSync(appSkillsDir)) {
              const wslSourcePath = pathConverter.toWSL(appSkillsDir);
              log(
                `[ClaudeAgentRunner] Copying app skills with rsync: ${wslSourcePath}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'wsl',
                ['-d', distro, '-e', 'rsync', '-avL', wslSourcePath + '/', sandboxSkillsPath + '/'],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            // List copied skills for verification
            const copiedSkills = execFileSync(
              'wsl',
              ['-d', distro, '-e', 'ls', sandboxSkillsPath],
              {
                encoding: 'utf-8',
                timeout: 10000,
              }
            )
              .trim()
              .split(/\r?\n/)
              .filter(Boolean);

            log(`[ClaudeAgentRunner] Skills copied to sandbox: ${sandboxSkillsPath}`);
            log(`[ClaudeAgentRunner]   Skills: ${copiedSkills.join(', ')}`);
          } catch (error) {
            logError('[ClaudeAgentRunner] Failed to copy skills to sandbox:', error);
          }

          if (isNewSession) {
            // Notify UI: sync complete (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'ready',
                message: 'Sandbox ready',
                detail: `Synced ${syncResult.fileCount} files`,
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }
        } else {
          logError('[ClaudeAgentRunner] Sandbox sync failed:', syncResult.error);
          log('[ClaudeAgentRunner] Falling back to /mnt/ access (less secure)');

          if (isNewSession) {
            // Notify UI: error (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'error',
                message: 'Sandbox file sync failed, falling back to direct access mode',
                detail: 'Falling back to direct access mode (less secure)',
              },
            });
          }
        }
      }

      // Initialize sandbox sync if Lima mode is active
      if (sandbox.isLima && sandbox.limaStatus?.instanceRunning && workingDir) {
        log('[ClaudeAgentRunner] Lima mode active, initializing sandbox sync...');

        const { LimaSync } = await import('../sandbox/lima-sync');

        // Only show sync UI for new sessions (first message)
        const isNewLimaSession = !LimaSync.hasSession(session.id);

        if (isNewLimaSession) {
          // Notify UI: syncing files (only for new sessions)
          this.sendToRenderer({
            type: 'sandbox.sync',
            payload: {
              sessionId: session.id,
              phase: 'syncing_files',
              message: 'Syncing files to sandbox...',
              detail: 'Copying project files to isolated Lima environment',
            },
          });
        }

        const syncResult = await LimaSync.initSync(workingDir, session.id);

        if (syncResult.success) {
          sandboxPath = syncResult.sandboxPath;
          useSandboxIsolation = true;
          log(`[ClaudeAgentRunner] Sandbox initialized: ${sandboxPath}`);
          log(
            `[ClaudeAgentRunner]   Files: ${syncResult.fileCount}, Size: ${syncResult.totalSize} bytes`
          );

          if (isNewLimaSession) {
            // Update UI with file count (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'syncing_skills',
                message: 'Configuring skills...',
                detail: 'Copying built-in skills to sandbox',
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }

          // Copy skills to sandbox ~/.claude/skills/
          const builtinSkillsPath = this.skillsRuntime.getBuiltinSkillsPath();
          try {
            const sandboxSkillsPath = `${sandboxPath}/.claude/skills`;

            // Create .claude/skills directory in sandbox
            execFileSync(
              'limactl',
              ['shell', 'claude-sandbox', '--', 'mkdir', '-p', sandboxSkillsPath],
              {
                encoding: 'utf-8',
                timeout: 10000,
              }
            );

            if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
              // Use rsync via execFileSync with array args to avoid shell injection
              // Lima mounts /Users directly, so paths are the same
              log(
                `[ClaudeAgentRunner] Copying skills with rsync: ${builtinSkillsPath}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'limactl',
                [
                  'shell',
                  'claude-sandbox',
                  '--',
                  'rsync',
                  '-av',
                  builtinSkillsPath + '/',
                  sandboxSkillsPath + '/',
                ],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            const appSkillsDir = this.skillsRuntime.getRuntimeSkillsDir();
            if (!fs.existsSync(appSkillsDir)) {
              fs.mkdirSync(appSkillsDir, { recursive: true });
            }
            this.skillsRuntime.syncUserSkillsToAppDir(appSkillsDir);
            this.skillsRuntime.syncConfiguredSkillsToRuntimeDir(appSkillsDir);

            if (fs.existsSync(appSkillsDir)) {
              log(
                `[ClaudeAgentRunner] Copying app skills with rsync: ${appSkillsDir}/ -> ${sandboxSkillsPath}/`
              );

              execFileSync(
                'limactl',
                [
                  'shell',
                  'claude-sandbox',
                  '--',
                  'rsync',
                  '-avL',
                  appSkillsDir + '/',
                  sandboxSkillsPath + '/',
                ],
                {
                  encoding: 'utf-8',
                  timeout: 120000, // 2 min timeout for large skill directories
                }
              );
            }

            // List copied skills for verification
            const copiedSkills = execFileSync(
              'limactl',
              ['shell', 'claude-sandbox', '--', 'ls', sandboxSkillsPath],
              {
                encoding: 'utf-8',
                timeout: 10000,
              }
            )
              .trim()
              .split(/\r?\n/)
              .filter(Boolean);

            log(`[ClaudeAgentRunner] Skills copied to sandbox: ${sandboxSkillsPath}`);
            log(`[ClaudeAgentRunner]   Skills: ${copiedSkills.join(', ')}`);
          } catch (error) {
            logError('[ClaudeAgentRunner] Failed to copy skills to sandbox:', error);
          }

          if (isNewLimaSession) {
            // Notify UI: sync complete (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'ready',
                message: 'Sandbox ready',
                detail: `Synced ${syncResult.fileCount} files`,
                fileCount: syncResult.fileCount,
                totalSize: syncResult.totalSize,
              },
            });
          }
        } else {
          logError('[ClaudeAgentRunner] Sandbox sync failed:', syncResult.error);
          log('[ClaudeAgentRunner] Falling back to direct access (less secure)');

          if (isNewLimaSession) {
            // Notify UI: error (only for new sessions)
            this.sendToRenderer({
              type: 'sandbox.sync',
              payload: {
                sessionId: session.id,
                phase: 'error',
                message: 'Sandbox file sync failed, falling back to direct access mode',
                detail: 'Falling back to direct access mode (less secure)',
              },
            });
          }
        }
      }

      // Check if current user message includes images
      const lastUserMessage =
        existingMessages.length > 0 ? existingMessages[existingMessages.length - 1] : null;

      logCtx('[ClaudeAgentRunner] Total messages:', existingMessages.length);

      const hasImages =
        lastUserMessage?.content.some((c) => (c as { type?: string }).type === 'image') || false;
      if (hasImages) {
        log('[ClaudeAgentRunner] User message contains images');
      }

      logTiming('before pi-ai model resolution', runStartTime);

      // Resolve model via pi-ai
      const runtimeConfig = configStore.getAll();
      const modelString = this.getCurrentModelString(runtimeConfig.model);
      const configProtocol = resolvePiRouteProtocol(
        runtimeConfig.provider,
        runtimeConfig.customProtocol
      );

      // Normalize base URL for OpenAI-compatible providers (strips copy-pasted endpoint suffixes)
      const rawBaseUrl = runtimeConfig.baseUrl?.trim() || undefined;
      const effectiveBaseUrl =
        configProtocol === 'openai' && runtimeConfig.provider !== 'ollama'
          ? normalizeOpenAICompatibleBaseUrl(rawBaseUrl) || rawBaseUrl
          : rawBaseUrl;

      let usedSyntheticModel = false;
      let piModel = resolvePiRegistryModel(modelString, {
        configProvider: configProtocol,
        customBaseUrl: effectiveBaseUrl,
        rawProvider: runtimeConfig.provider,
        customProtocol: runtimeConfig.customProtocol,
      });

      if (!piModel) {
        usedSyntheticModel = true;
        // Synthetic fallback: construct a Model for unknown/custom models
        const synthetic = resolveSyntheticPiModelFallback({
          rawModel: runtimeConfig.model,
          resolvedModelString: modelString,
          rawProvider: runtimeConfig.provider,
          routeProtocol: configProtocol,
          baseUrl: effectiveBaseUrl,
        });
        piModel = buildSyntheticPiModel(
          synthetic.modelId,
          synthetic.provider,
          configProtocol,
          effectiveBaseUrl,
          undefined,
          undefined,
          runtimeConfig.contextWindow,
          runtimeConfig.maxTokens
        );
        // Apply the same runtime overrides (developer role compat, base URL, API downgrade)
        // that resolvePiRegistryModel applies to registry models
        piModel = applyPiModelRuntimeOverrides(piModel, {
          configProvider: configProtocol,
          customBaseUrl: effectiveBaseUrl,
          rawProvider: runtimeConfig.provider,
          customProtocol: runtimeConfig.customProtocol,
        });
        logCtxWarn(
          '[ClaudeAgentRunner] Model not in pi-ai registry, using synthetic model:',
          modelString,
          '→',
          piModel.api
        );
      }
      logCtx('[ClaudeAgentRunner] Resolved pi-ai model:', piModel.provider, piModel.id);

      // For Ollama: query actual context window from /api/show if user hasn't configured one
      const provider = runtimeConfig.provider || 'anthropic';
      if (provider === 'ollama' && !runtimeConfig.contextWindow) {
        const ollamaBaseUrl =
          piModel.baseUrl || runtimeConfig.baseUrl || 'http://localhost:11434/v1';
        const ollamaInfo = await fetchOllamaModelInfo({
          baseUrl: ollamaBaseUrl,
          model: piModel.id,
          apiKey: runtimeConfig.apiKey,
        });
        if (ollamaInfo.contextWindow) {
          log(
            '[ClaudeAgentRunner] Ollama /api/show reported contextWindow:',
            ollamaInfo.contextWindow,
            '(was:',
            piModel.contextWindow,
            ')'
          );
          piModel = { ...piModel, contextWindow: ollamaInfo.contextWindow };
        }
      }

      // Send context window info to renderer for UI display
      this.sendToRenderer({
        type: 'session.contextInfo',
        payload: {
          sessionId: session.id,
          contextWindow: piModel.contextWindow || 128000,
        },
      });

      // Set up API keys via AuthStorage
      const authStorage = getSharedAuthStorage();
      const apiKey = runtimeConfig.apiKey?.trim();
      if (apiKey) {
        // Map our config provider to pi-ai provider name
        const piProvider =
          provider === 'custom' ? runtimeConfig.customProtocol || 'anthropic' : provider;
        authStorage.setRuntimeApiKey(piProvider, apiKey);
        // Also set the key for the model's native provider (e.g., when using
        // google/gemini via openrouter, pi-ai looks up "google" not "openrouter")
        if (piModel.provider !== piProvider) {
          authStorage.setRuntimeApiKey(piModel.provider, apiKey);
          log('[ClaudeAgentRunner] Set runtime API key for model provider:', piModel.provider);
        }
        log('[ClaudeAgentRunner] Set runtime API key for config provider:', piProvider);
      } else {
        if (provider === 'ollama') {
          log(
            '[ClaudeAgentRunner] Ollama configured without explicit API key; relying on OpenAI-compatible placeholder/env auth path',
            safeStringify({
              provider,
              modelProvider: piModel.provider,
              modelId: piModel.id,
              baseUrl: piModel.baseUrl || runtimeConfig.baseUrl || '',
            })
          );
        } else {
          logWarn('[ClaudeAgentRunner] No API key configured for provider:', provider);
        }
      }

      // baseUrl is now embedded in the model object via resolvePiModel()
      logCtx('[ClaudeAgentRunner] Model baseUrl:', piModel.baseUrl, 'api:', piModel.api);

      logTiming('after pi-ai model resolution', runStartTime);

      // the agent SDK handles path sandboxing via its own tools
      const imageCapable = true; // pi-ai models generally support images; let the model handle unsupported cases
      const effectiveCwd =
        useSandboxIsolation && sandboxPath ? sandboxPath : workingDir || process.cwd();

      // Use app-specific Claude config directory to avoid conflicts with user settings
      // SDK uses CLAUDE_CONFIG_DIR to locate skills
      const userClaudeDir = this.skillsRuntime.getAppClaudeDir();

      // Skills directory setup（Phase 2 迁移至 skills-runtime.ts）：
      // 只在每个 runner 实例的首次查询时执行；skills 安装/删除后
      // 调用 invalidateSkillsSetup() 强制重跑。
      this.skillsRuntime.ensureSetup();

      // Build available skills section dynamically — now handled by the pi
      // resource loader inside PiSessionFactory (Phase 5) via additionalSkillPaths.
      // No custom prompt building needed.

      log('[ClaudeAgentRunner] App claude dir:', userClaudeDir);
      log('[ClaudeAgentRunner] User working directory:', workingDir);

      logTiming('before building conversation context', runStartTime);

      // pi-ai handles auth and model routing natively — no proxy, no env overrides needed.
      logCtx('[ClaudeAgentRunner] Using pi-ai native routing for:', piModel.provider, piModel.id);

      // Stage 2（Phase 4）：任务分类 + 三策略（pipeline/task-classifier + *-strategy）。
      // Thinking level must be resolved before the session reuse check below.
      const enableThinking = configStore.get('enableThinking') ?? false;
      logCtx('[ClaudeAgentRunner] Enable thinking mode:', enableThinking);
      const modelCtx: ModelContext = {
        piModel,
        provider,
        configProtocol,
        contextWindow: piModel.contextWindow || 128000,
        authStorage,
        runtimeConfig,
      };
      const taskCtx: TaskContext = {
        taskType: classifyTask(prompt),
        sessionId: session.id,
        userMessage: prompt,
        modelCtx,
        platform: process.platform,
        // hasMCPTools 在下方 MCP custom tools 构建后回填（citation 段依赖它）
        hasMCPTools: false,
        sandboxPath: useSandboxIsolation && sandboxPath ? sandboxPath : undefined,
        workingDir,
        effectiveCwd,
      };
      const thinkingLevel: PiThinkingLevel = this.thinkingStrategy.resolve(taskCtx, enableThinking);
      logCtx(
        '[ClaudeAgentRunner] Task classification:',
        taskCtx.taskType,
        '→ thinkingLevel:',
        thinkingLevel
      );
      const skillPaths = await this.skillsRuntime.resolveSkillPaths(session.id);
      const skillsSignature = JSON.stringify(skillPaths);
      log('[ClaudeAgentRunner] Skill paths for pi ResourceLoader:', skillPaths);
      // Stage 3 签名原料（Phase 5：签名计算/比较/缓存全部移入 PiSessionFactory）。
      // MCP 指纹需参与早期失效检查（§5.5.3 有意行为变更：SDK customTools 创建时
      // 冻结，配置变化只能靠重建送达），因此 enabled configs 在此提前读取一次，
      // 下方 MCP 配置构建块共享同一结果。
      let allConfigs: ReturnType<typeof mcpConfigStore.getEnabledServers> = [];
      try {
        allConfigs = mcpConfigStore.getEnabledServers();
        log(
          '[ClaudeAgentRunner] Enabled MCP configs:',
          allConfigs.map((c) => c.name)
        );
      } catch (error) {
        logWarn(
          '[ClaudeAgentRunner] Failed to read enabled MCP configs; MCP tools will be unavailable this query',
          error
        );
        allConfigs = [];
      }
      // Cache key: serialized config list + imageCapable flag.  The bundled node
      // paths are stable for the lifetime of the process so they don't need to be
      // part of the fingerprint.
      const mcpFingerprint = JSON.stringify(allConfigs) + String(imageCapable);
      const signatureInput: SessionSignatureInput = {
        configProvider: runtimeConfig.provider,
        customProtocol: runtimeConfig.customProtocol,
        modelProvider: piModel.provider,
        modelApi: piModel.api,
        modelBaseUrl: piModel.baseUrl,
        effectiveCwd,
        apiKey,
        skillsSignature,
        mcpFingerprint,
      };
      // 早期失效检查必须在 beforeSessionRun 之前，保证 isColdStart 反映真实缓存状态。
      this.sessionFactory.invalidateIfStale(session.id, signatureInput);

      const isColdStart = !this.sessionFactory.hasValidSession(session.id);
      const extensionResult = this.extensionManager
        ? await this.extensionManager.beforeSessionRun({
            session,
            prompt,
            existingMessages,
            isColdStart,
          })
        : { promptPrefix: undefined, customTools: [] };

      // contextualPrompt 组装已下移至 resolveOrCreate 之后（见下方 Stage 3b）——
      // /skill:<name> 展开需要 piSession.resourceLoader（SDK 公开 getter）的
      // 权威技能列表，且必须先展开、再拼接冷启动 preamble / promptPrefix。

      // Stage 3a（Phase 6）：MCP servers 配置构建提取为私有方法（行为不变），
      // 日志/缓存指纹语义与内联实现完全一致。返回值仅用于日志与缓存——
      // MCP 工具本体经 buildMcpCustomTools 以 customTools 桥接进 SDK。
      logTiming('before building MCP servers config', runStartTime);
      this.buildMcpServersConfig({ mcpFingerprint, allConfigs, imageCapable });
      logTiming('after building MCP servers config', runStartTime);

      logTiming('before agent session creation', runStartTime);

      // Create or reuse agent session
      // Bridge MCP tools as customTools for the agent SDK.
      // Re-read every query so newly added/removed MCP servers take effect immediately.
      const mcpCustomTools = this.mcpManager ? buildMcpCustomTools(this.mcpManager) : [];
      const extensionCustomTools = extensionResult.customTools || [];
      const customTools = this.toolStrategy.mergeCustomTools(mcpCustomTools, extensionCustomTools);
      if (mcpCustomTools.length > 0) {
        log(
          `[ClaudeAgentRunner] Registered ${mcpCustomTools.length} MCP tools as customTools:`,
          mcpCustomTools.map((t) => t.name).join(', ')
        );
      }
      if (extensionCustomTools.length > 0) {
        log(
          `[ClaudeAgentRunner] Registered ${extensionCustomTools.length} extension tools as customTools:`,
          extensionCustomTools.map((t) => t.name).join(', ')
        );
      }

      // Enrich process.env.PATH for build mode — ensures Skill commands (python3, node)
      // executed via Pi SDK's Bash tool can find bundled and user-installed executables.
      await enrichProcessPathForBuild();

      // Stage 2（Phase 4）：PromptStrategy.assemble() 取代原 coworkAppendPrompt 内联数组；
      // ToolStrategy.assemble() 取代原 createCodingTools + timeout/sudo 包装链。
      // 工具集恒定全量、不按任务裁剪（§3.3 锁定）。
      taskCtx.hasMCPTools = mcpCustomTools.length > 0;
      const assembledPrompt = this.promptStrategy.assemble(taskCtx);
      logCtx(
        '[ClaudeAgentRunner] Prompt subset assembled:',
        taskCtx.taskType,
        `~${assembledPrompt.tokenEstimate} tokens`
      );

      const bashOptions: BashToolOptions | undefined =
        process.platform === 'win32' ? { operations: createWindowsBashOperations() } : undefined;
      const wrappedTools = this.toolStrategy.assemble(taskCtx, {
        bashOptions,
        requestSudoPassword: this.requestSudoPassword,
      }).codingTools;

      // Diagnostic: log tools being passed to SDK (helps debug Ollama tool use)
      logCtx(`[ClaudeAgentRunner] Session reuse check: cached=${!isColdStart}`);
      logCtx(`[ClaudeAgentRunner] Model=${piModel.id}, thinkingLevel=${thinkingLevel}`);
      log(
        `[ClaudeAgentRunner] Built-in tools (${wrappedTools.length}): ${wrappedTools.map((t: { name?: string; type?: string }) => t.name || t.type).join(', ')}`
      );
      log(
        `[ClaudeAgentRunner] Custom tools (${customTools.length}): ${customTools.map((t) => t.name).join(', ')}`
      );

      // Stage 3（Phase 5）：创建/复用/热替换/Ollama 补丁全部在 PiSessionFactory 内完成。
      // 复用路径：更新 appendSystemPromptOverride 闭包 → reload() → model/thinking 热替换；
      // 新建路径：createAgentSession 构造参数直接生效（HIGH-4）。
      const { piSession, isReused } = await this.sessionFactory.resolveOrCreate({
        sessionId: session.id,
        modelCtx,
        taskCtx,
        prompt: assembledPrompt,
        tools: { codingTools: wrappedTools },
        thinkingLevel,
        skillPaths,
        customTools,
        signature: signatureInput,
        sessionCwd: session.cwd ?? null,
        permissionDeps: {
          requestPermission: this.requestPermission,
          sessionAllowAll: this.optionsAllowAll,
          getToolDisplayName: (name) => this.getToolDisplayName(name),
        },
      });
      logTiming(isReused ? 'agent session reused' : 'agent session created', runStartTime);

      // ── Stage 3b：contextualPrompt 组装（原 :1101 处逻辑下移至此）──
      // 下移原因：/skill:<name> 显式展开必须在拼接任何前缀之前完成，而权威的
      // 技能列表只有 piSession 就绪后才能拿到（SDK 公开 getter resourceLoader，
      // 与 _expandSkillCommand 内部同源）。SDK 自身只在文本以 "/skill:" **开头**
      // 时展开，而冷启动 <conversation_history> preamble / extension promptPrefix
      // 会破坏这个开头条件 → 必须由我们先展开。展开成功后文本以 "<skill" 开头，
      // SDK 的展开天然 no-op（不存在双重展开）。
      let expandedPrompt = prompt;
      if (prompt.startsWith('/skill:')) {
        expandedPrompt = expandSkillCommand(prompt, piSession.resourceLoader.getSkills().skills);
        if (expandedPrompt !== prompt) {
          logCtx(
            '[ClaudeAgentRunner] Expanded /skill: command before prompt assembly for:',
            session.id
          );
        }
      }
      let contextualPrompt = expandedPrompt;
      if (isColdStart) {
        // Cold start: inject recent history into prompt if available
        // （Phase 5：组装逻辑迁至 pipeline/cold-start-history.ts，行为不变）
        contextualPrompt = buildColdStartContextualPrompt(
          contextualPrompt,
          existingMessages,
          provider,
          piModel.contextWindow || 128000
        );
      } else {
        // Reusing session — SDK already has the full conversation context
        logCtx('[ClaudeAgentRunner] Reusing existing SDK session for:', session.id);
      }
      if (extensionResult.promptPrefix?.trim()) {
        contextualPrompt = `${extensionResult.promptPrefix.trim()}\n\n${contextualPrompt}`;
      }

      // ══════════════ Stage 4：执行（事件流桥接） ══════════════
      // ── 4.1 bridge state: SDK 事件 → ServerEvent 协议的桥接状态 ──
      // Set up event handler to bridge agent SDK events → our ServerEvent protocol

      // Accumulate streamed text deltas in case message_end.content is empty (pi SDK streaming behaviour)
      let streamedText = '';
      // 注意：此处不再声明内层 pauseRescue——它会遮蔽外层（run() 顶部 line ~503），
      // 导致事件处理器写 inner 而 AbortError catch 读 outer，两个对象不同，
      // 用户停止时 rescue 永远落空。统一通过作用域链引用 run() 顶部声明的同一个对象。
      let compactionStepId: string | undefined;
      let hasEmittedError = false;
      let terminalErrorText: string | undefined;
      const thinkParser = new ThinkTagStreamParser();
      const promptStartedAt = Date.now();
      const streamEventCounts = new Map<string, number>();
      // Per-API-call timing: track each LLM round-trip within the agent loop
      let messageStartTime: number | undefined;
      let apiCallCount = 0;

      // ── 4.2 loop guard: protect against runaway tool-call loops ──
      // (e.g. gemini-3.1-pro with thinking=off has been observed producing hundreds
      //  of empty-text + single-tool-call responses in a single turn)
      // Two layers: hash of whole tool-call group (window=20, warn=3/halt=5/abort=8)
      //             + per-tool frequency (warn=30/halt=50/abort=80).
      const loopGuard = new LoopGuard();
      const handleLoopGuardDecision = (decision: LoopGuardDecision, context: string): void => {
        if (decision.action === 'none' || controller.signal.aborted) return;
        logWarn(`[LoopGuard] ${context}: action=${decision.action} reason=${decision.reason}`);

        if (decision.action === 'hash_abort' || decision.action === 'freq_abort') {
          // Always surface the loop-guard explanation, even if an earlier
          // error already set hasEmittedError — the user must see why the
          // session stopped. Mark the flag afterward to suppress duplicate
          // generic-error chatter from later paths in this turn.
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: buildAbortUserMessage(decision) }],
            timestamp: Date.now(),
          });
          hasEmittedError = true;
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'error',
            title: 'Stopped: tool-call loop detected',
          });
          try {
            // Mark BEFORE calling abort() so the AbortError handler in the
            // outer catch can distinguish a loop-guard abort from a user
            // cancel and skip the "Cancelled" trace overwrite.
            abortedByLoopGuard = true;
            controller.abort();
          } catch (abortErr) {
            logWarn('[LoopGuard] abort error:', abortErr);
          }
          return;
        }

        const steerText =
          decision.action === 'hash_halt' || decision.action === 'freq_halt'
            ? buildHaltSteerMessage(decision)
            : buildWarnSteerMessage(decision);
        // fire-and-forget: SDK queues the steering message for the next turn
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sessionAny = piSession as any;
          if (typeof sessionAny.sendUserMessage === 'function') {
            Promise.resolve(sessionAny.sendUserMessage(steerText, { deliverAs: 'steer' })).catch(
              (err: unknown) => {
                logWarn('[LoopGuard] sendUserMessage(steer) failed:', err);
              }
            );
          } else {
            logWarn('[LoopGuard] piSession.sendUserMessage is not available; skipping steer');
          }
        } catch (steerErr) {
          logWarn('[LoopGuard] sendUserMessage(steer) threw:', steerErr);
        }
      };

      // ── 4.3 cold-start feedback: Ollama 模型加载提示（10s 无流事件时） ──
      // Ollama cold-start feedback: if provider is 'ollama' and no stream event arrives
      // within 10 seconds, show a "model loading" trace update so users know what's happening.
      let ollamaColdStartTimerId: ReturnType<typeof setTimeout> | undefined;
      let receivedFirstStreamEvent = false;
      let firstStreamEventAt: number | undefined;
      if (provider === 'ollama') {
        ollamaColdStartTimerId = setTimeout(() => {
          if (!receivedFirstStreamEvent && !controller.signal.aborted) {
            this.sendTraceUpdate(session.id, thinkingStepId, {
              title: 'Waiting for model to load into memory...',
            });
          }
        }, 10000);
      }

      const markFirstStreamEvent = (eventType: string) => {
        if (receivedFirstStreamEvent) {
          return;
        }
        receivedFirstStreamEvent = true;
        firstStreamEventAt = Date.now();
        if (ollamaColdStartTimerId) {
          clearTimeout(ollamaColdStartTimerId);
        }
        this.sendTraceUpdate(session.id, thinkingStepId, {
          title: 'Processing request...',
        });
        if (provider === 'ollama') {
          log(
            '[ClaudeAgentRunner] Ollama first stream event received',
            safeStringify({
              sessionId: session.id,
              eventType,
              modelId: piModel.id,
              modelProvider: piModel.provider,
              baseUrl: piModel.baseUrl || runtimeConfig.baseUrl || '',
              latencyMs: firstStreamEventAt - promptStartedAt,
            })
          );
        }
      };

      // ── 4.4 activity timeout: 5 分钟无 SDK 事件即中止（每个事件重置计时） ──
      // Activity-based timeout: reset the 5-min timer whenever the SDK sends events
      const PROMPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      let activityTimeoutId: ReturnType<typeof setTimeout> | undefined;
      const resetActivityTimeout = () => {
        if (activityTimeoutId) clearTimeout(activityTimeoutId);
        activityTimeoutId = setTimeout(() => {
          logWarn('[ClaudeAgentRunner] Prompt timed out (no activity for 5 min), aborting');
          abortedByTimeout = true;
          controller.abort();
        }, PROMPT_TIMEOUT_MS);
      };

      const recordStreamEvent = (eventType: string) => {
        streamEventCounts.set(eventType, (streamEventCounts.get(eventType) ?? 0) + 1);
      };

      const getStreamEventSummary = () =>
        Object.fromEntries(
          Array.from(streamEventCounts.entries()).sort(([left], [right]) =>
            left.localeCompare(right)
          )
        );

      // ── 4.5 terminal error: 统一的终态错误发布（消息 + trace + 可选 abort） ──
      const emitTerminalError = (
        errorText: string,
        options: { abort?: boolean; includePartialText?: boolean } = {}
      ): void => {
        terminalErrorText = errorText;

        let flushedThinking = '';
        let flushedText = '';

        if (options.includePartialText) {
          const flushed = thinkParser.flush();
          flushedThinking = flushed.thinking;
          flushedText = flushed.text;
        }

        const emission = buildTerminalErrorEmissionDetails({
          errorText,
          streamedText,
          flushedThinking,
          flushedText,
        });

        if (emission.thinkingDelta) {
          this.sendToRenderer({
            type: 'stream.thinking',
            payload: { sessionId: session.id, delta: emission.thinkingDelta },
          });
        }
        if (emission.textDelta) {
          this.sendPartial(session.id, emission.textDelta);
          pauseRescue.text += emission.textDelta;
        }

        const partialText = emission.partialText ? sanitizeOutputPaths(emission.partialText) : '';
        const messageText = buildTerminalErrorMessage(errorText, partialText);
        streamedText = '';
        this.sendToRenderer({
          type: 'stream.partial',
          payload: { sessionId: session.id, delta: '' },
        });

        if (!hasEmittedError) {
          hasEmittedError = true;
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: messageText }],
            timestamp: Date.now(),
          });
        }

        this.sendTraceUpdate(session.id, thinkingStepId, {
          status: 'error',
          title: 'Request failed',
        });

        if (options.abort && !controller.signal.aborted) {
          try {
            // Mark BEFORE calling abort() so AbortError handling preserves the
            // 'Request failed' state instead of treating this as a user cancel.
            abortedByStreamError = true;
            controller.abort();
          } catch (abortErr) {
            logWarn('[ClaudeAgentRunner] stream-error abort failed:', abortErr);
          }
        }
      };

      // ── 4.6 subscribe dispatch: SDK 事件订阅（message_update/end、tool_execution_*、auto_compaction_*） ──
      const unsubscribe = piSession.subscribe((event) => {
        try {
          if (controller.signal.aborted) return;

          // Reset activity timeout on meaningful events
          resetActivityTimeout();

          if (event.type === 'message_update') {
            const updateType = event.assistantMessageEvent.type;
            recordStreamEvent(updateType);
            if (updateType !== 'text_delta' && updateType !== 'thinking_delta') {
              log(`[ClaudeAgentRunner] Event: ${event.type} → ${updateType}`);
            }
          } else if (event.type === 'message_start') {
            messageStartTime = Date.now();
            apiCallCount++;
            pauseRescue.apiCallCount = apiCallCount;
            log(
              `[ClaudeAgentRunner] Event: message_start [api_call #${apiCallCount}]`,
              safeStringify(summarizeMessageForLog(event.message), 2)
            );
          } else if (event.type === 'message_end') {
            const apiCallDuration = messageStartTime ? Date.now() - messageStartTime : -1;
            log(
              `[ClaudeAgentRunner] Event: message_end [api_call #${apiCallCount}, ${apiCallDuration}ms]`,
              safeStringify(
                {
                  message: summarizeMessageForLog(event.message),
                  messageUpdateCounts: getStreamEventSummary(),
                },
                2
              )
            );
            messageStartTime = undefined;
          } else if (event.type === 'turn_end') {
            log(`[ClaudeAgentRunner] Event: ${event.type}`);
          } else {
            log(`[ClaudeAgentRunner] Event: ${event.type}`);
          }

          switch (event.type) {
            case 'message_update': {
              if (controller.signal.aborted) break;
              const ame = event.assistantMessageEvent;
              if (ame.type === 'text_delta') {
                markFirstStreamEvent(ame.type);
                const parsed = thinkParser.push(ame.delta);
                if (parsed.thinking) {
                  this.sendToRenderer({
                    type: 'stream.thinking',
                    payload: { sessionId: session.id, delta: parsed.thinking },
                  });
                }
                if (parsed.text) {
                  streamedText += parsed.text;
                  pauseRescue.text += parsed.text;
                  this.sendPartial(session.id, parsed.text);
                }
              } else if (ame.type === 'thinking_delta') {
                markFirstStreamEvent(ame.type);
                // Forward thinking delta to renderer for real-time display
                this.sendToRenderer({
                  type: 'stream.thinking',
                  payload: { sessionId: session.id, delta: ame.delta },
                });
              } else if (ame.type === 'toolcall_start') {
                markFirstStreamEvent(ame.type);
                const partial = ame.partial;
                const toolContent = partial?.content?.[ame.contentIndex];
                const toolName = toolContent?.type === 'toolCall' ? toolContent.name : 'unknown';
                const toolCallId = toolContent?.type === 'toolCall' ? toolContent.id : uuidv4();
                const toolDisplayName = this.getToolDisplayName(toolName);
                this.sendTraceStep(session.id, {
                  id: toolCallId,
                  type: 'tool_call',
                  status: 'running',
                  title: toolDisplayName,
                  toolName,
                  toolInput:
                    toolContent?.type === 'toolCall'
                      ? (toolContent.arguments as Record<string, unknown>) || {}
                      : undefined,
                  timestamp: Date.now(),
                });
              } else if (ame.type === 'done') {
                // Some providers emit 'done' via message_update — we handle it
                // in message_end below as a unified path for all providers.
                log('[ClaudeAgentRunner] message_update done event (handled in message_end)');
              } else if (ame.type === 'error') {
                markFirstStreamEvent(ame.type);
                const errorDetail = JSON.stringify(ame.error?.content || 'no content');
                logCtxError('[ClaudeAgentRunner] pi-ai stream error:', ame.reason, errorDetail);
                emitTerminalError(resolveAssistantStreamErrorText(ame), {
                  abort: true,
                  includePartialText: true,
                });
              }
              break;
            }

            case 'message_end': {
              // Unified handler: send the final assistant message to the renderer.
              // Works for all providers (some emit 'done' via message_update, others don't).
              if (controller.signal.aborted) break;

              // Flush any buffered content from the think-tag parser
              const flushed = thinkParser.flush();
              if (flushed.thinking) {
                this.sendToRenderer({
                  type: 'stream.thinking',
                  payload: { sessionId: session.id, delta: flushed.thinking },
                });
              }
              if (flushed.text) {
                streamedText += flushed.text;
                pauseRescue.text += flushed.text;
                this.sendPartial(session.id, flushed.text);
              }

              const msg = event.message;
              // Defensive: drop malformed toolCall blocks (empty/missing name) from the
              // LIVE SDK message. A model/gateway may return a tool call with an empty
              // function name; if left in the conversation it (a) can never be executed
              // ("Tool not found") and (b) is forwarded verbatim to the upstream gateway
              // on the follow-up request, which 500s ('str' object has no attribute
              // 'items'). Removing it here means the SDK's tool-execution filter
              // (agent-loop) never sees it, so the turn continues cleanly and history
              // stays free of the broken block. `event.message` is the same object
              // instance held in the SDK session state, so mutating it takes effect
              // before the agent-loop scans `message.content` for pending tool calls.
              if (msg && Array.isArray((msg as { content?: unknown }).content)) {
                const content = (msg as { content: Array<{ type?: string; name?: string }> })
                  .content;
                const filtered = content.filter(
                  (b) => !(b && b.type === 'toolCall' && (!b.name || String(b.name).trim() === ''))
                );
                if (filtered.length !== content.length) {
                  (msg as { content: unknown }).content = filtered;
                }
              }
              if (process.env.COWORK_LOG_SDK_MESSAGES_FULL === '1') {
                log('[ClaudeAgentRunner] message_end raw message:', safeStringify(msg, 2));
              }
              const resolvedPayload = resolveMessageEndPayload({
                message: msg as Parameters<typeof resolveMessageEndPayload>[0]['message'],
                streamedText,
              });
              streamedText = resolvedPayload.nextStreamedText;
              if (provider === 'ollama') {
                log(
                  '[ClaudeAgentRunner] Ollama message_end diagnostics',
                  safeStringify({
                    sessionId: session.id,
                    modelId: piModel.id,
                    modelProvider: piModel.provider,
                    usedSyntheticModel,
                    receivedFirstStreamEvent,
                    firstStreamLatencyMs: firstStreamEventAt
                      ? firstStreamEventAt - promptStartedAt
                      : null,
                    stopReason: (msg as { stopReason?: unknown })?.stopReason ?? null,
                    contentBlocks: Array.isArray((msg as { content?: unknown[] })?.content)
                      ? ((msg as { content?: unknown[] }).content?.length ?? 0)
                      : 0,
                    emittedError: Boolean(resolvedPayload.errorText),
                  })
                );
              }
              if (resolvedPayload.errorText) {
                emitTerminalError(resolvedPayload.errorText, { includePartialText: true });
                break;
              }
              if (resolvedPayload.shouldEmitMessage) {
                const contentBlocks: ContentBlock[] = [];
                for (const block of resolvedPayload.effectiveContent) {
                  if (block.type === 'text') {
                    const { cleanText, artifacts } = extractArtifactsFromText(block.text);
                    if (cleanText) {
                      contentBlocks.push({ type: 'text', text: sanitizeOutputPaths(cleanText) });
                    }
                    if (artifacts.length > 0) {
                      for (const step of buildArtifactTraceSteps(artifacts)) {
                        this.sendTraceStep(session.id, step);
                      }
                      const completionText = buildArtifactCompletionText(artifacts);
                      if (completionText) {
                        contentBlocks.push({ type: 'text', text: completionText });
                      }
                    }
                  } else if (block.type === 'toolCall') {
                    const displayName = this.getToolDisplayName(block.name);
                    contentBlocks.push({
                      type: 'tool_use',
                      id: block.id,
                      name: block.name,
                      displayName,
                      input: block.arguments,
                    });
                  } else if (block.type === 'thinking') {
                    // Include thinking blocks in the final message for UI display
                    contentBlocks.push({
                      type: 'thinking',
                      thinking: block.thinking,
                    });
                  } else {
                    // Unknown block type — pass through as text so content isn't silently lost
                    const unknownBlock = block as { type?: string; text?: string };
                    log(`[ClaudeAgentRunner] Unknown content block type: ${unknownBlock.type}`);
                    const text = unknownBlock.text || JSON.stringify(block);
                    if (text) contentBlocks.push({ type: 'text', text });
                  }
                }
                // Always clear partial text; send message even if only artifacts were extracted
                this.sendToRenderer({
                  type: 'stream.partial',
                  payload: { sessionId: session.id, delta: '' },
                });

                // ── Loop guard layer 1: hash of this message's tool-call group ──
                const toolUseDescriptors: ToolCallDescriptor[] = [];
                for (const block of resolvedPayload.effectiveContent) {
                  if (block.type === 'toolCall') {
                    toolUseDescriptors.push({
                      name: block.name || '',
                      input: (block.arguments as Record<string, unknown>) || undefined,
                    });
                  }
                }
                if (toolUseDescriptors.length > 0) {
                  handleLoopGuardDecision(
                    loopGuard.recordAssistantMessage(toolUseDescriptors),
                    'message_end'
                  );
                  if (controller.signal.aborted) break;
                }

                if (contentBlocks.length > 0) {
                  const hasTextBlock = contentBlocks.some(
                    (b) => b.type === 'text' && (b.text ?? '').trim()
                  );
                  if (hasTextBlock) {
                    pauseRescue.persistedTextCount += 1;
                  }
                  const msgWithUsage = msg as { usage?: unknown };
                  const tokenUsage = normalizeTokenUsage(msgWithUsage.usage);
                  if (msgWithUsage.usage) {
                    log(
                      '[ClaudeAgentRunner] normalized usage:',
                      safeStringify(
                        {
                          raw: msgWithUsage.usage,
                          normalized: tokenUsage,
                        },
                        2
                      )
                    );
                  }
                  const assistantMsg: Message = {
                    id: uuidv4(),
                    sessionId: session.id,
                    role: 'assistant',
                    content: contentBlocks,
                    timestamp: Date.now(),
                    api: piModel.api,
                    provider: piModel.provider,
                    model: piModel.id,
                    tokenUsage,
                  };
                  this.sendMessage(session.id, assistantMsg);
                }
              }
              break;
            }

            case 'tool_execution_start': {
              logCtx(`[ClaudeAgentRunner] Tool execution start: ${event.toolName}`);
              // ── Loop guard layer 2: per-tool cumulative frequency ──
              handleLoopGuardDecision(
                loopGuard.recordToolInvocation(event.toolName),
                'tool_execution_start'
              );
              break;
            }

            case 'tool_execution_end': {
              if (controller.signal.aborted) break;
              const toolCallId = event.toolCallId;
              const isError = event.isError;
              const normalizedToolResult = normalizeToolExecutionResultForUi(event.result);
              const outputText = normalizedToolResult.content;
              const toolDisplayName = this.getToolDisplayName(event.toolName);
              this.sendTraceUpdate(session.id, toolCallId, {
                status: isError ? 'error' : 'completed',
                title: toolDisplayName,
                toolName: event.toolName,
                toolOutput: sanitizeOutputPaths(outputText).slice(0, 800),
              });

              // Send tool result message
              const toolResultMsg: Message = {
                id: uuidv4(),
                sessionId: session.id,
                role: 'assistant',
                content: [
                  {
                    type: 'tool_result',
                    toolUseId: toolCallId,
                    content: sanitizeOutputPaths(outputText),
                    isError,
                    ...(normalizedToolResult.images.length > 0
                      ? { images: normalizedToolResult.images }
                      : {}),
                  },
                ],
                timestamp: Date.now(),
              };
              this.sendMessage(session.id, toolResultMsg);
              break;
            }

            case 'agent_end': {
              logCtx('[ClaudeAgentRunner] Agent finished');
              break;
            }

            case 'auto_compaction_start': {
              log('[ClaudeAgentRunner] Auto-compaction started, reason:', event.reason);
              compactionStepId = `compaction-${Date.now()}`;
              this.sendTraceStep(session.id, {
                id: compactionStepId,
                type: 'thinking',
                status: 'running',
                title: `Compacting context (${event.reason})...`,
                timestamp: Date.now(),
              });
              break;
            }

            case 'auto_compaction_end': {
              const status = event.aborted ? 'error' : event.errorMessage ? 'error' : 'completed';
              const title = event.aborted
                ? 'Context compaction aborted'
                : event.errorMessage
                  ? `Context compaction failed: ${event.errorMessage}`
                  : 'Context compaction completed';
              log(
                '[ClaudeAgentRunner] Auto-compaction ended:',
                title,
                'willRetry:',
                event.willRetry
              );
              if (compactionStepId) {
                this.sendTraceUpdate(session.id, compactionStepId, { status, title });
                compactionStepId = undefined;
              } else {
                // Fallback: no matching start event, send as new step
                this.sendTraceStep(session.id, {
                  id: `compaction-end-${Date.now()}`,
                  type: 'thinking',
                  status,
                  title,
                  timestamp: Date.now(),
                });
              }
              break;
            }
          }
        } catch (subscribeErr) {
          logError('[ClaudeAgentRunner] Error in subscribe callback:', subscribeErr);
          if (compactionStepId) {
            this.sendTraceUpdate(session.id, compactionStepId, {
              status: 'error',
              title: 'Error during context compaction',
            });
            compactionStepId = undefined;
          }
          if (!hasEmittedError) {
            hasEmittedError = true;
            const errorText = toUserFacingErrorText(toErrorText(subscribeErr));
            this.sendMessage(session.id, {
              id: uuidv4(),
              sessionId: session.id,
              role: 'assistant',
              content: [{ type: 'text', text: `**Error**: ${errorText}` }],
              timestamp: Date.now(),
            });
          }
        }
      });

      // ── 4.7 deferred memory injection ──
      // Background experience retrieval (see MemoryExtension) resolves in
      // parallel with the first LLM request; when it lands while the turn is
      // still running we inject it via pi's steering channel. This keeps the
      // first-token path free of memory LLM round-trips.
      let promptInProgress = false;
      let memoryInjectionHandle: DeferredMemoryInjectionHandle | undefined;
      if (extensionResult.deferredExperience) {
        const retrievalTimeoutMs = configStore.get('memoryRuntime')?.retrievalTimeoutMs ?? 8000;
        memoryInjectionHandle = attachDeferredMemoryInjection(extensionResult.deferredExperience, {
          timeoutMs: retrievalTimeoutMs,
          isTurnActive: () => promptInProgress && !controller.signal.aborted,
          sendSteer: (text) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sessionAny = piSession as any;
            if (typeof sessionAny.sendUserMessage !== 'function') {
              throw new Error('piSession.sendUserMessage is not available');
            }
            return Promise.resolve(sessionAny.sendUserMessage(text, { deliverAs: 'steer' }));
          },
          onInjected: () => {
            log('[ClaudeAgentRunner] Deferred memory context injected via steering');
            this.sendTraceStep(session.id, {
              id: uuidv4(),
              type: 'thinking',
              status: 'completed',
              title: 'Memory context injected',
              timestamp: Date.now(),
            });
          },
        });
      }

      // ── 4.8 prompt execution: 发起请求，finally 中退订 + 清理计时器 ──
      // Execute the prompt — unsubscribe in finally to prevent event listener leak
      try {
        resetActivityTimeout();
        if (provider === 'ollama') {
          log(
            '[ClaudeAgentRunner] Starting Ollama prompt',
            safeStringify({
              sessionId: session.id,
              modelId: piModel.id,
              modelProvider: piModel.provider,
              baseUrl: piModel.baseUrl || runtimeConfig.baseUrl || '',
              usedSyntheticModel,
              hasExplicitApiKey: Boolean(apiKey),
              thinkingLevel,
            })
          );
        }
        promptInProgress = true;
        const promptResult = await piSession.prompt(contextualPrompt);
        promptInProgress = false;
        log(
          '[ClaudeAgentRunner] prompt() returned:',
          JSON.stringify(promptResult ?? 'void').substring(0, 1000)
        );
      } finally {
        promptInProgress = false;
        memoryInjectionHandle?.cancel();
        try {
          unsubscribe();
        } catch (e) {
          logWarn('[ClaudeAgentRunner] unsubscribe error:', e);
        }
        if (activityTimeoutId) clearTimeout(activityTimeoutId);
        if (ollamaColdStartTimerId) clearTimeout(ollamaColdStartTimerId);
      }

      logTiming(`agent prompt completed (${apiCallCount} API calls)`, runStartTime);

      // If the SDK swallowed the AbortError and returned void, detect timeout here
      if (controller.signal.aborted && abortedByTimeout) {
        logCtx('[ClaudeAgentRunner] Aborted due to timeout (detected after prompt returned)');
        const errorMsg: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'assistant',
          content: [{ type: 'text', text: '**请求超时**：长时间未收到响应，操作已中止。' }],
          timestamp: Date.now(),
        };
        this.sendMessage(session.id, errorMsg);
        this.sendTraceUpdate(session.id, thinkingStepId, {
          status: 'error',
          title: 'Request timed out',
        });
        return;
      }
      // If the SDK swallowed the AbortError after a loop-guard abort, preserve
      // the 'error' trace status that handleLoopGuardDecision already published.
      // The user-facing message and trace step are already set; do not overwrite
      // them with the default "Task completed" below.
      const abortDisposition = resolveAbortDisposition({
        abortedByTimeout,
        abortedByLoopGuard,
        abortedByStreamError,
      });
      if (controller.signal.aborted && shouldPreserveExistingTrace(abortDisposition)) {
        logCtx(
          `[ClaudeAgentRunner] Aborted by ${abortDisposition === 'loop_guard' ? 'loop guard' : 'stream error'} (detected after prompt returned)`
        );
        return;
      }
      // prompt() returned WITHOUT throwing but the turn was aborted (either
      // our own controller during shutdown paths, or the SDK's internal abort
      // after piSession.abort() on user stop): run the same user-abort rescue
      // as the AbortError branch so the half-written reply is persisted.
      // NOTE: a user stop aborts BOTH the SDK session and our inner
      // controller, so plain `controller.signal.aborted` cannot tell them
      // apart. abortedByUserStop is set by cancel() and marks a user stop.
      if (this.consumeUserStopFlag(session.id)) {
        logCtx('[ClaudeAgentRunner] Stopped by user (prompt returned without error)');
        const userFlushed = thinkParser.flush();
        if (userFlushed.thinking) {
          this.sendToRenderer({
            type: 'stream.thinking',
            payload: { sessionId: session.id, delta: userFlushed.thinking },
          });
        }
        if (userFlushed.text) {
          pauseRescue.text += userFlushed.text;
          this.sendPartial(session.id, userFlushed.text);
        }
        const cleanPartial = sanitizeOutputPaths(pauseRescue.text).trim();
        pauseRescue.text = '';
        if (cleanPartial) {
          pauseRescue.persistedTextCount += 1;
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: cleanPartial }],
            timestamp: Date.now(),
          });
        } else if (pauseRescue.apiCallCount === 0 && pauseRescue.persistedTextCount === 0) {
          pauseRescue.persistedTextCount += 1;
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: '（已暂停，本轮未输出正文）' }],
            timestamp: Date.now(),
          });
        }
        this.sendTraceUpdate(session.id, thinkingStepId, {
          status: 'completed',
          title: 'Cancelled',
        });
        return;
      }
      // Complete - update the initial thinking step
      this.sendTraceUpdate(session.id, thinkingStepId, {
        status: terminalErrorText ? 'error' : 'completed',
        title: terminalErrorText ? 'Request failed' : 'Task completed',
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const abortDisposition = resolveAbortDisposition({
          abortedByTimeout,
          abortedByLoopGuard,
          abortedByStreamError,
        });
        if (abortDisposition === 'timeout') {
          logCtx('[ClaudeAgentRunner] Aborted due to timeout');
          const errorMsg: Message = {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [{ type: 'text', text: '**请求超时**：长时间未收到响应，操作已中止。' }],
            timestamp: Date.now(),
          };
          this.sendMessage(session.id, errorMsg);
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'error',
            title: 'Request timed out',
          });
        } else if (abortDisposition === 'loop_guard') {
          // Loop guard already published the user-facing assistant message and
          // an 'error' trace step with the loop-detected title. Do NOT overwrite
          // them here with a 'completed/Cancelled' state.
          logCtx('[ClaudeAgentRunner] Aborted by loop guard');
        } else if (abortDisposition === 'stream_error') {
          // Stream-error handling already published the user-facing assistant
          // message and the 'Request failed' trace state. Preserve them.
          logCtx('[ClaudeAgentRunner] Aborted by stream error');
        } else {
          logCtx('[ClaudeAgentRunner] Aborted by user');
          // Persist the partially-streamed reply BEFORE the renderer tears
          // down the live buffers: use pauseRescue (the turn-scoped rescue
          // buffer fed by every text path incl. think-tag flushes and error
          // emissions). sendMessage() persists to DB and pushes
          // stream.message, whose addMessage handler atomically swaps
          // partial → persisted, so the visible reply never blanks on pause.
          const cleanPartial = sanitizeOutputPaths(pauseRescue.text).trim();
          pauseRescue.text = '';
          if (cleanPartial) {
            pauseRescue.persistedTextCount += 1;
            this.sendMessage(session.id, {
              id: uuidv4(),
              sessionId: session.id,
              role: 'assistant',
              content: [{ type: 'text', text: cleanPartial }],
              timestamp: Date.now(),
            });
          } else if (pauseRescue.apiCallCount === 0 && pauseRescue.persistedTextCount === 0) {
            // Nothing streamed yet in this turn and no prior text this turn:
            // keep the turn visible with a placeholder so the user sees the
            // run existed and the continue affordance has an anchor.
            pauseRescue.persistedTextCount += 1;
            this.sendMessage(session.id, {
              id: uuidv4(),
              sessionId: session.id,
              role: 'assistant',
              content: [{ type: 'text', text: '（已暂停，本轮未输出正文）' }],
              timestamp: Date.now(),
            });
          }
          this.sendTraceUpdate(session.id, thinkingStepId, {
            status: 'completed',
            title: 'Cancelled',
          });
        }
      } else {
        logCtxError('[ClaudeAgentRunner] Error:', error);

        const errorText = toUserFacingErrorText(toErrorText(error));
        const errorMsg: Message = {
          id: uuidv4(),
          sessionId: session.id,
          role: 'assistant',
          content: [{ type: 'text', text: `**Error**: ${errorText}` }],
          timestamp: Date.now(),
        };
        this.sendMessage(session.id, errorMsg);

        this.sendTraceStep(session.id, {
          id: uuidv4(),
          type: 'thinking',
          status: 'error',
          title: 'Error occurred',
          timestamp: Date.now(),
        });

        // Mark so session-manager doesn't report again
        if (error instanceof Error) {
          (error as Error & { alreadyReportedToUser?: boolean }).alreadyReportedToUser = true;
        }
      }
    } finally {
      this.activeControllers.delete(session.id);
      this.pathResolver.unregisterSession(session.id);

      // Sync changes from sandbox back to host OS (but don't cleanup - sandbox persists)
      if (useSandboxIsolation && sandboxPath) {
        try {
          const sandbox = getSandboxAdapter();

          if (sandbox.isWSL) {
            log('[ClaudeAgentRunner] Syncing sandbox changes to Windows...');
            const syncResult = await SandboxSync.syncToWindows(session.id);
            if (syncResult.success) {
              log('[ClaudeAgentRunner] Sync completed successfully');
            } else {
              logError('[ClaudeAgentRunner] Sync failed:', syncResult.error);
            }
          } else if (sandbox.isLima) {
            log('[ClaudeAgentRunner] Syncing sandbox changes to macOS...');
            const { LimaSync } = await import('../sandbox/lima-sync');
            const syncResult = await LimaSync.syncToMac(session.id);
            if (syncResult.success) {
              log('[ClaudeAgentRunner] Sync completed successfully');
            } else {
              logError('[ClaudeAgentRunner] Sync failed:', syncResult.error);
            }
          }
        } catch (syncErr) {
          logError('[ClaudeAgentRunner] Sandbox sync error:', syncErr);
          this.sendMessage(session.id, {
            id: uuidv4(),
            sessionId: session.id,
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: `**Warning**: Sandbox sync failed: ${syncErr instanceof Error ? syncErr.message : String(syncErr)}`,
              },
            ],
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  cancel(sessionId: string): void {
    // User stop: abort the SDK session FIRST so the in-flight LLM request
    // actually stops and piSession.prompt() rejects/returns. Only then abort
    // the inner event-stream controller so our subscribe listener stops
    // consuming late events. Previously only the inner controller was
    // aborted, so prompt() kept running in the background while our UI
    // tore down the buffers — the reported "pause wipes the output" bug.
    // Mark the user-stop flag so the prompt-returned-without-error path can
    // run the same partial-rescue as the AbortError path.
    this.userStopFlags.add(sessionId);
    try {
      this.sessionFactory.abortCachedSession(sessionId);
    } catch (error) {
      logWarn('[ClaudeAgentRunner] pi session abort error:', error);
    }
    const controller = this.activeControllers.get(sessionId);
    if (controller) controller.abort();
  }

  /** Consume (read + clear) the user-stop flag for a session. */
  private consumeUserStopFlag(sessionId: string): boolean {
    if (!this.userStopFlags.has(sessionId)) {
      return false;
    }
    this.userStopFlags.delete(sessionId);
    return true;
  }

  private sendTraceStep(sessionId: string, step: TraceStep): void {
    log(`[Trace] ${step.type}: ${step.title}`);
    this.sendToRenderer({ type: 'trace.step', payload: { sessionId, step } });
  }

  private sendTraceUpdate(sessionId: string, stepId: string, updates: Partial<TraceStep>): void {
    log(`[Trace] Update step ${stepId}:`, updates);
    this.sendToRenderer({ type: 'trace.update', payload: { sessionId, stepId, updates } });
  }

  private sendMessage(sessionId: string, message: Message): void {
    // Save message to database for persistence
    if (this.saveMessage) {
      this.saveMessage(message);
    }
    // Send to renderer for UI update
    this.sendToRenderer({ type: 'stream.message', payload: { sessionId, message } });
  }

  private sendPartial(sessionId: string, delta: string): void {
    this.sendToRenderer({ type: 'stream.partial', payload: { sessionId, delta } });
  }
}
