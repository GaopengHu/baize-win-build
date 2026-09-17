import { describe } from 'vitest';

/**
 * Phase 0 骨架（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.1）。
 * 目标模块 src/main/claude/pipeline/tool-strategy.ts 在 Phase 4 创建，
 * 届时启用以下行为契约（describe.todo → describe）。
 */
describe.todo('tool-strategy (Phase 4 启用)', () => {
  // 契约清单（Phase 4 落地时实现）：
  // - 【锁定决策 §3.3】工具集恒定全量：assemble() 对 chat/code/document/research
  //   四类 taskType 返回完全相同的工具名单（逐一相等断言）
  // - 源码反向断言：tool-strategy.ts 内不得出现按 taskType 过滤的分支
  //   （readFileSync + not.toMatch(/taskType\s*===/)）
  // - bash 工具经过 timeout 包装链（wrapBashToolWithDefaultTimeout → wrapBashToolForSudo）
  // - MCP custom tools 与 extension custom tools 合并去重（by name）
});

export {};
