import { describe } from 'vitest';

/**
 * Phase 0 骨架（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.1）。
 * 目标模块 src/main/claude/pipeline/thinking-strategy.ts 在 Phase 4 创建，
 * 届时启用以下行为契约（describe.todo → describe）。
 */
describe.todo('thinking-strategy (Phase 4 启用)', () => {
  // 契约清单（Phase 4 落地时实现）：
  // - resolve(taskType, enableThinking) 矩阵：
  //   chat × off → 'off'；code × on → 'medium'（以文档 §3.4 矩阵为准）
  // - enableThinking=false 时任何 taskType 都不得返回高于 'off' 的档位
  // - 未知 provider / 非法输入 → 安全兜底档位，不抛错
});

export {};
