/**
 * @module main/claude/subagent/subagent-tool
 *
 * `dispatch_agent` ToolDefinition（主 agent 唯一的模型侧委派入口）+ 双闸门。
 *
 * 闸门（与 §3.4 并发闸门互补）：
 * - 并发闸门：同父会话同时在跑的 child ≤ MAX_CONCURRENT_CHILDREN（3），
 *   超限返回工具错误（对标 Claude Code：报错、不排队、不重试）。
 * - 轮次预算：同父会话单轮 dispatch ≤ MAX_DISPATCHES_PER_TURN（含串行），
 *   防弱模型串行滥用委派烧 token。计数在 afterSessionRun 清零
 *   （runner 调 afterSessionRun 时机调用 `resetTurnBudget`）。
 *
 * 取消级联（§3.6 主路径）：SDK 不会自动联动父子 controller，
 * `parentSignal.addEventListener('abort', () => void childSession.abort())`
 * 是触发 child 取消的唯一通道；finally 中 removeEventListener + dispose。
 *
 * 错误文本规范（给模型看的指令，不是日志）：每种拒绝/失败都告诉模型
 * "接下来该干什么"（自己接着做 / 降级），不只抛状态。
 */
import { Type, type TSchema } from '@sinclair/typebox';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import { log, logError, logWarn } from '../../utils/logger';
import {
  runSubagent,
  type SubagentProfileName,
  type SubagentRunnerDeps,
  type SubagentRunResult,
} from './subagent-runner';

/** 同父会话并发 child 上限（超限报错，不排队不重试）。 */
export const MAX_CONCURRENT_CHILDREN = 3;

/** 同父会话单轮 dispatch 预算（含串行；防滥用委派）。 */
export const MAX_DISPATCHES_PER_TURN = 3;

export const DISPATCH_AGENT_TOOL_NAME = 'dispatch_agent';

const runningChildren = new Map<string, number>();
const turnDispatches = new Map<string, number>();

function runningCount(parentSessionId: string): number {
  return runningChildren.get(parentSessionId) ?? 0;
}

function turnCount(parentSessionId: string): number {
  return turnDispatches.get(parentSessionId) ?? 0;
}

/** afterSessionRun 调用：本轮结束，清零该会话的轮次预算。 */
export function resetTurnBudget(parentSessionId: string): void {
  turnDispatches.delete(parentSessionId);
}

/** 单测/兜底：清理某会话的全部闸门计数。 */
export function resetSubagentGates(parentSessionId: string): void {
  runningChildren.delete(parentSessionId);
  turnDispatches.delete(parentSessionId);
}

export function getGateCounts(parentSessionId: string): { running: number; turnUsed: number } {
  return { running: runningCount(parentSessionId), turnUsed: turnCount(parentSessionId) };
}

export interface DispatchAgentDeps {
  parentSessionId: string;
  runnerDeps: SubagentRunnerDeps;
  /** 用量/耗时透出（runner 经父事件桥发 trace.update，渲染层可见每个 child 开销）。 */
  onChildDone?: (result: SubagentRunResult, description: string) => void;
}

/** dispatch_agent 的 details（用量透出 + 进度阶段，渲染层可读）。 */
export interface DispatchAgentDetails {
  stage: 'started' | 'tool' | 'done';
  description: string;
  toolCallCount: number;
  toolName?: string;
  durationMs?: number;
  truncated?: boolean;
  aborted?: boolean;
}

export const SUBAGENT_TYPES: SubagentProfileName[] = ['research', 'document', 'general'];

const DISPATCH_AGENT_DESCRIPTION = [
  '把一个可并行分解的子任务委派给子 agent（独立上下文，结果以聚焦报告返回）。',
  'research（只读调研）：读本地文件与长文档提炼；联网检索默认关闭（用户需在设置里显式开启），离线时只能靠本地文件与已有知识。简单一问一答不要委派。',
  'document（文档生成）：做 PPT/写 Word/出表格等办公产物，子任务需自带完整内容要求；写文件/跑命令会弹权限确认。',
  'general（通用执行）：可独立执行的其他子任务兜底，有完整工具集；写操作同样会弹权限确认。',
  'prompt 必须自带子任务所需的全部上下文（子 agent 看不到主会话）。',
  '一次最多同时跑 3 个子任务；同一轮对话最多委派 3 次，超限请自己接着做，不要拆分重试。',
].join('\n');

export function buildDispatchAgentTool(
  deps: DispatchAgentDeps
): ToolDefinition<TSchema, unknown> {
  const parameters = Type.Object({
    description: Type.String({ description: '子任务短标签（也用于进度展示）' }),
    prompt: Type.String({ description: '自带全部上下文的委派书' }),
    subagent_type: Type.String({ description: "子 agent 类型：'research'（默认）/ 'document' / 'general'" }),
  });

  // 进度透出走 SDK 的 onUpdate（形态必须是完整 AgentToolResult）：
  // 节流/摘要——只推 started/工具计数/done，不逐 token 转发。
  return {
    name: DISPATCH_AGENT_TOOL_NAME,
    label: 'Dispatch Subagent',
    description: DISPATCH_AGENT_DESCRIPTION,
    parameters,
    async execute(toolCallId, params, signal, onUpdate, _ctx) {
      const raw = (params ?? {}) as {
        description?: unknown;
        prompt?: unknown;
        subagent_type?: unknown;
      };
      const description = typeof raw.description === 'string' ? raw.description.trim() : '';
      const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
      // 缺省即 research；传了枚举外的值才拒绝（入口收窄）。
      const requestedType =
        typeof raw.subagent_type === 'string' && raw.subagent_type.trim()
          ? raw.subagent_type.trim()
          : 'research';
      const subagentType = (
        SUBAGENT_TYPES as string[]
      ).includes(requestedType)
        ? (requestedType as SubagentProfileName)
        : null;
      const parentSessionId = deps.parentSessionId;
      const fail = (text: string) => ({
        content: [{ type: 'text' as const, text }],
        details: {
          stage: 'done' as const,
          description,
          toolCallCount: 0,
        },
      });

      if (!description || !prompt) {
        return fail(
          'dispatch_agent 参数缺失：description 与 prompt 必填。请补充后重试，或自己直接完成该子任务。'
        );
      }
      if (subagentType === null) {
        return fail(
          `dispatch_agent 暂不支持 subagent_type='${requestedType}'（仅 research/document/general）。请自己直接完成该子任务。`
        );
      }
      if (runningCount(parentSessionId) >= MAX_CONCURRENT_CHILDREN) {
        logWarn(`[SubagentTool] concurrent limit reached for ${parentSessionId}`);
        return fail(
          '子任务并发已满（3 个在跑）。不要等待、不要重试：请自己直接完成这个子任务。'
        );
      }
      if (turnCount(parentSessionId) >= MAX_DISPATCHES_PER_TURN) {
        logWarn(`[SubagentTool] turn budget exhausted for ${parentSessionId}`);
        return fail('本轮委派次数已用完（3 次）。不要再拆分子任务：请自己接着完成剩余工作。');
      }

      runningChildren.set(parentSessionId, runningCount(parentSessionId) + 1);
      turnDispatches.set(parentSessionId, turnCount(parentSessionId) + 1);
      onUpdate?.({
        content: [{ type: 'text' as const, text: `子任务「${description}」已开始` }],
        details: { stage: 'started', description, toolCallCount: 0 },
      });

      // 结构化日志：每次委派记一行，给 7.1.3 调优留数据
      // （description / prompt 长度 / child 耗时-token-工具数 / 成功失败）。
      const dispatchAt = Date.now();
      log(
        `[SubagentTool] dispatch parent=${parentSessionId} profile=${subagentType} ` +
          `desc=${description.slice(0, 80)} promptChars=${prompt.length} ` +
          `call=${toolCallId}`
      );

      // Child 会话句柄：parentSignal 监听器需要它（§3.6 唯一级联通道）。
      // runSubagent 内部创建 child；此处用回调拿句柄以装配 abort 联动。
      let childAbort: (() => void) | null = null;
      const onAbort = () => {
        try {
          childAbort?.();
        } catch (error) {
          logWarn('[SubagentTool] child abort threw:', error);
        }
      };
      if (signal) {
        if (signal.aborted) {
          runningChildren.set(parentSessionId, runningCount(parentSessionId) - 1);
          return fail('委派已取消（父任务已停止）。');
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        const result = await runSubagent(
          {
            profile: subagentType,
            description,
            prompt,
            registerAbort: (abort) => {
              childAbort = abort;
            },
            onProgress: (progress) => {
              // 节流/摘要：只推 started/工具计数/done，不逐 token 转发
              if (progress.phase === 'tool') {
                onUpdate?.({
                  content: [
                    {
                      type: 'text' as const,
                      text: `子任务「${description}」进行中（工具调用 ${progress.toolCallCount} 次）`,
                    },
                  ],
                  details: {
                    stage: 'tool',
                    description,
                    toolCallCount: progress.toolCallCount,
                    toolName: progress.toolName,
                  },
                });
              }
            },
          },
          deps.runnerDeps
        );

        deps.onChildDone?.(result, description);
        log(
          `[SubagentTool] done parent=${parentSessionId} toolCalls=${result.toolCallCount} ` +
            `durationMs=${result.durationMs} truncated=${result.truncated} ` +
            `aborted=${result.aborted} call=${toolCallId} elapsedMs=${Date.now() - dispatchAt}`
        );

        const suffix = result.aborted
          ? '\n\n[注：子任务被中断或超出工具预算，结果可能不完整，请核对后自己补足。]'
          : '';
        return {
          content: [{ type: 'text' as const, text: `${result.report}${suffix}` }],
          details: {
            stage: 'done' as const,
            description,
            toolCallCount: result.toolCallCount,
            durationMs: result.durationMs,
            truncated: result.truncated,
            aborted: result.aborted,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('[SubagentTool] child failed:', error);
        log(
          `[SubagentTool] failed parent=${parentSessionId} call=${toolCallId} ` +
            `elapsedMs=${Date.now() - dispatchAt} error=${message.slice(0, 200)}`
        );
        return fail(
          `子任务执行失败（${message.slice(0, 200)}）。` +
            '不要重试委派：请降级处理——改用你自己的知识直接回答，或用主会话工具自己检索。'
        );
      } finally {
        runningChildren.set(parentSessionId, Math.max(0, runningCount(parentSessionId) - 1));
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
