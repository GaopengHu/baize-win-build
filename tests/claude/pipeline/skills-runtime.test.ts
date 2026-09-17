import { describe } from 'vitest';

/**
 * Phase 0 骨架（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.1）。
 * 目标模块 src/main/claude/skills-runtime.ts 在 Phase 2 创建，
 * 届时启用以下行为契约（describe.todo → describe）。
 */
describe.todo('skills-runtime (Phase 2 启用)', () => {
  // 契约清单（Phase 2 落地时实现）：
  // - SkillsRuntime 承载原 agent-runner 的 8 个 skills 目录管理方法
  // - getSkillPaths() 复用 skills-adapter 现有实现（不重复造轮子）
  // - symlink 创建 / 用户 skills 同步 / plugin skills 解析行为与迁移前一致
  // - 单文件 skills-runtime.ts，不建 claude/skills/ 目录（避免与
  //   skills-manager.ts 1208 行体系撞名，见文档 §3.7）
});

export {};
