/**
 * @module main/claude/pipeline/tool-strategy
 *
 * Stage 2 工具策略（AGENT-RUNNER-REFACTOR-PLAN.md §3.3 / Phase 4）。
 *
 * 【锁定决策 §3.3】工具集恒定全量：assemble() 对任何 TaskContext 返回同一份
 * 内置工具 + 同一条包装链（timeout → sudo）。**本模块源码不得出现按任务类型
 * 过滤工具的分支**（tool-strategy.test.ts 有源码级反向断言）。
 *
 * 理由：文本分类做不到 100% 正确，而工具裁剪会把误判变成能力硬缺失
 * （SDK 在 prompt() 时快照工具列表，本轮内无法自愈）。不裁剪 = 工具维度
 * 零行为变化 = 零回归风险；行为约束由 prompt 的 CHAT FIRST 规则与
 * setBeforeToolCall 权限钩子（§3.8）承担。
 *
 * 不调用 setActiveToolsByName。custom 工具（MCP / extension）经
 * mergeCustomTools 合并去重（by name，先到先得）后走 customTools 参数注册。
 */
import {
  createCodingTools,
  type BashToolOptions,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { wrapBashToolForSudo, wrapBashToolWithDefaultTimeout } from '../tools/bash-tool-wrappers';
import type { RequestSudoPasswordFn } from '../tools/bash-tool-wrappers';
import type { AssembledTools, TaskContext } from './context-types';

export interface ToolStrategyDeps {
  /** win32 下传入 { operations: createWindowsBashOperations() }；其余平台 undefined。 */
  bashOptions?: BashToolOptions;
  /** sudo 密码请求回调（包装链第 2 步；缺省时跳过 sudo 拦截）。 */
  requestSudoPassword?: RequestSudoPasswordFn;
}

export class ToolStrategy {
  assemble(ctx: TaskContext, deps: ToolStrategyDeps = {}): AssembledTools {
    // 全量内置工具：read / bash / edit / write。任何任务类型都拿到同一份工具集，
    // 模型"看不看得到"不再是分类正确性问题（§3.3）。
    let codingTools = createCodingTools(
      ctx.effectiveCwd,
      deps.bashOptions ? { bash: deps.bashOptions } : undefined
    ) as ToolDefinition[];

    // 包装链：timeout → sudo（permission 走 setBeforeToolCall 钩子，见 §3.8）
    codingTools = wrapBashToolWithDefaultTimeout(codingTools);

    // Note: wrapBashToolForSudo returns ToolDefinition[] (5-param execute) but
    // createAgentSession.tools expects Tool[] (4-param execute). The extra ctx
    // parameter is simply not passed by the session runner — safe to cast.
    codingTools = wrapBashToolForSudo(
      codingTools,
      ctx.sessionId,
      ctx.effectiveCwd,
      deps.requestSudoPassword
    );

    return { codingTools };
  }

  /**
   * 合并 MCP 与 extension 桥接的 custom 工具，按 name 去重（先到先得，
   * MCP 桥接在前与现状 `[...mcpCustomTools, ...extensionCustomTools]` 一致）。
   */
  mergeCustomTools(...groups: ToolDefinition[][]): ToolDefinition[] {
    const merged: ToolDefinition[] = [];
    const seen = new Set<string>();
    for (const group of groups) {
      for (const tool of group ?? []) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        merged.push(tool);
      }
    }
    return merged;
  }
}
