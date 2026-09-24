/**
 * @module main/claude/tools/permission-hook
 *
 * 权限门控钩子（AGENT-RUNNER-REFACTOR-PLAN.md §3.8 / Phase 3）：
 * 从 agent-runner.ts 的私有方法 installPermissionHook 提取为自由函数。
 *
 * 通过 SDK 的 `agent.setBeforeToolCall` 拦截工具调用——这是内置工具
 * （read/bash/edit/write）唯一的拦截点（SDK 会忽略 options.tools 上
 * 包装过的 execute）。钩子内部咨询主进程规则缓存 decidePermission：
 *  - 'allow' → 委托 SDK 原始钩子（正常放行）
 *  - 'deny'  → 返回 { block: true, reason }（SDK 视为工具错误）
 *  - 'ask'   → await requestPermission() IPC 往返到 PermissionDialog
 *
 * 已知限制：异步 requestPermission 等待（用户弹窗）期间 renderer 会错过
 * UI 更新事件。工具在后端正确执行，但渲染端 loading spinner 可能不清除。
 * 这是渲染端问题，作为后续跟进项跟踪。
 *
 * 注意：toUserFacingErrorText 逻辑按计划保留在 agent-runner.ts，不在本模块。
 */
import { v4 as uuidv4 } from 'uuid';
import { decidePermission, rememberAlwaysAllow } from '../../config/permission-rules-store';
import { classifyPermission, resolvePermissionGate } from '../../utils/permission-classifier';
import { log, logError, logWarn } from '../../utils/logger';
import type { AgentSession as PiAgentSession } from '@mariozechner/pi-coding-agent';

/** requestPermission 回调签名（与 AgentRunnerOptions.requestPermission 一致）。 */
export type RequestPermissionFn = (
  sessionId: string,
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  kind?: 'advanced' | 'delete' | 'outside' | 'normal',
  /** Phase 7.1.2：权限弹窗来源标注（child dispatch description），渲染端展示用。 */
  sourceLabel?: string
) => Promise<'allow' | 'deny' | 'allow_always'>;

/**
 * 内部编排工具白名单：宿主侧自建、无外部副作用的分发/编排入口，
 * 不经过权限审批（用户点 10 次「允许」也拦不住真正的副作用——
 * 副作用发生在工具内部，由各自的审批链覆盖）。
 *
 * 白名单 ≠ 免责：dispatch_agent 内部派生的 child 写操作，
 * 仍走各自安装的 installPermissionHook（父 sessionId 作用域）。
 */
const ORCHESTRATION_TOOLS_ALLOWLIST = new Set([
  'dispatch_agent',
]);

export interface PermissionHookDeps {
  /** 用户权限弹窗回调；缺省时跳过钩子安装（无 UI 场景）。 */
  requestPermission?: RequestPermissionFn;
  /** 会话级"全部允许"开关查询（AgentRunnerOptions.sessionAllowAll）。 */
  sessionAllowAll?: (sessionId: string) => boolean;
  /** 工具显示名解析（MCP sanitized 名 → 原始名），由 runner 注入以复用其缓存。 */
  getToolDisplayName: (toolName: string) => string;
  /**
   * Phase 7.1.2：来源标注。child 会话安装钩子时传入 dispatch description，
   * 经 requestPermission 送达 PermissionDialog「来自：…」行。主会话不传。
   */
  sourceLabel?: string;
}

/**
 * Install a permission-gating hook on the pi-coding-agent session via
 * `agent.setBeforeToolCall`. Must be called once per new session — the hook
 * persists across session reuses.
 */
export function installPermissionHook(
  piSession: PiAgentSession,
  sessionId: string,
  sessionCwd: string | null,
  deps: PermissionHookDeps
): void {
  const { requestPermission, sessionAllowAll, getToolDisplayName, sourceLabel } = deps;

  if (!requestPermission) {
    log('[ClaudeAgentRunner] No requestPermission callback — skipping permission hook');
    return;
  }

  // Access the Agent instance (public readonly property on AgentSession)
  // and wrap its beforeToolCall hook with our permission gate.
  //
  // We must chain to the SDK's original beforeToolCall hook because it
  // fires extension tool_call events and manages the _agentEventQueue.
  // Without chaining, the renderer misses completion events.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent = (piSession as any).agent;
  if (!agent || typeof agent.setBeforeToolCall !== 'function') {
    logWarn('[ClaudeAgentRunner] Cannot access agent.setBeforeToolCall — skipping permission hook');
    return;
  }

  // Capture the SDK's hook before we overwrite it
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdkBeforeToolCall: ((ctx: any, signal?: AbortSignal) => Promise<any>) | undefined =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (agent as any)._beforeToolCall;

  agent.setBeforeToolCall(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (ctx: any, signal?: AbortSignal): Promise<any> => {
      const toolName: string = ctx.toolCall?.name ?? '';
      const input: Record<string, unknown> = ctx.args ?? {};
      // Human-readable name for prompts/messages (e.g. MCP sanitized
      // 'mcp__chrome__chrome_screenshot__ab12' → 'chrome_screenshot').
      // Rule matching and rememberAlwaysAllow still use the canonical
      // `toolName` so allow-once decisions stay stable across calls.
      const displayName = getToolDisplayName(toolName);

      // 内部编排工具（dispatch_agent）：无外部副作用，直接放行，
      // 仍委托 SDK 原始钩子保事件链不断。
      if (ORCHESTRATION_TOOLS_ALLOWLIST.has(toolName.toLowerCase())) {
        log(`[ClaudeAgentRunner] Orchestration tool '${toolName}' allowed without approval`);
        return sdkBeforeToolCall ? sdkBeforeToolCall(ctx, signal) : undefined;
      }

      const allowAll = sessionAllowAll?.(sessionId) ?? false;
      const { kind, reason } = classifyPermission(sessionCwd, toolName, input);
      const decision = decidePermission(sessionId, toolName, input);
      const gate = resolvePermissionGate(kind, decision, allowAll);

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
          result = await requestPermission(sessionId, toolUseId, displayName, input, kind, sourceLabel);
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

      log(
        `[ClaudeAgentRunner] Permission gate allowed '${toolName}' (${kind}${
          reason ? `: ${reason}` : ''
        })`
      );
      // Allowed — delegate to SDK's original hook for event pipeline
      return sdkBeforeToolCall ? sdkBeforeToolCall(ctx, signal) : undefined;
    }
  );

  log(
    `[ClaudeAgentRunner] Permission hook installed on session ${sessionId} via agent.setBeforeToolCall`
  );
}
