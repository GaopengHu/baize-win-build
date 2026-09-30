/**
 * @module main/claude/pipeline/thinking-strategy
 *
 * Stage 2 Thinking 策略（AGENT-RUNNER-REFACTOR-PLAN.md §3.4 / Phase 4）。
 *
 * 任务类型 × enableThinking × provider → PiThinkingLevel 矩阵：
 *   !enableThinking        → 'off'（用户全局开关优先）
 *   provider === 'ollama'  → 'off'（小模型 thinking 质量差）
 *   chat                   → 'off'（聊天不需要深度推理，首 token 延迟降低 2-3x）
 *   research               → 'low'
 *   code                   → 'medium'
 *   document               → 'low'
 *   default                → 'medium'
 *
 * 契约：resolve 绝不抛错，未知 taskType / provider 走安全兜底。
 */
import type { PiThinkingLevel, TaskContext } from './context-types';

export class ThinkingStrategy {
  resolve(ctx: TaskContext, enableThinking: boolean): PiThinkingLevel {
    if (!enableThinking) return 'off';
    // 可选链兜底：畸形 ctx（缺 modelCtx/taskType）走 default 'medium'，绝不抛错
    if (ctx?.modelCtx?.provider === 'ollama') return 'off'; // 小模型 thinking 质量差

    switch (ctx?.taskType) {
      case 'chat':
        return 'off'; // 聊天不需要深度推理
      case 'research':
        return 'low'; // 搜索/总结需要轻度推理
      case 'code':
        return 'medium'; // 编码需要中等推理
      case 'document':
        return 'low'; // 文档生成需要轻度推理
      default:
        return 'medium';
    }
  }
}
