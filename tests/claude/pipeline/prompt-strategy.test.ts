import { describe } from 'vitest';

/**
 * Phase 0 骨架（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.1）。
 * 目标模块 src/main/claude/pipeline/prompt-strategy.ts 在 Phase 4 创建，
 * 届时启用以下行为契约（describe.todo → describe）。
 */
describe.todo('prompt-strategy (Phase 4 启用)', () => {
  // 契约清单（Phase 4 落地时实现）：
  // - assemble({ taskType: 'chat' }) 必须包含 toolBehavior 参数名教学（防幻觉参数名）
  // - assemble({ taskType: 'chat' }) 包含 CHAT FIRST 规则、不主动写文件规则
  // - assemble({ taskType: 'code' }) 包含 START DOING IT / reasonable assumptions 规则
  // - hasMCPTools=true 时输出包含 markdown 引用规则（[Title](URL)）
  // - 任何 taskType 输出均不含 AskUserQuestion / TodoWrite / pendingQuestions
  // - 四档 prompt 子集 token 预算大致 ~350/800/700/450（允许浮动，只做量级断言）
});

export {};
