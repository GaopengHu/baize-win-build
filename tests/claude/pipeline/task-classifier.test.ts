import { describe } from 'vitest';

/**
 * Phase 0 骨架（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.1）。
 * 目标模块 src/main/claude/pipeline/task-classifier.ts 在 Phase 4 创建，
 * 届时启用以下行为契约（describe.todo → describe）。
 */
describe.todo('task-classifier (Phase 4 启用)', () => {
  // 契约清单（Phase 4 落地时实现）：
  // - classifyTask 返回 'chat' | 'code' | 'document' | 'research' 四类之一
  // - 30+ 条真实用户消息样本，每类精确率 ≥ 80%
  // - 空消息 / 纯图片消息 → 'chat' 兜底
  // - 中英混合关键词均可命中（"写个函数" / "fix the bug"）
  // - 分类失败绝不抛错：任何输入都返回合法类别
});

export {};
