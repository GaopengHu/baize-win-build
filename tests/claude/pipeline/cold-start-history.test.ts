import { describe } from 'vitest';

/**
 * Phase 0 骨架（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.1）。
 * 目标模块 src/main/claude/pipeline/cold-start-history.ts：纯函数部分
 * （escapeXmlAttr/Text、serializeMessageContentForHistory）在 Phase 1 迁入，
 * 历史组装逻辑在 Phase 5 迁入；届时启用以下行为契约（describe.todo → describe）。
 */
describe.todo('cold-start-history (Phase 1/5 启用)', () => {
  // 契约清单：
  // Phase 1（纯函数）：
  // - escapeXmlAttr/escapeXmlText 转义 & < > " ' 五字符
  // - serializeMessageContentForHistory 处理 string / 数组内容 / 图片过滤
  // Phase 5（历史组装，原 agent-runner run() 内联逻辑）：
  // - 不重复注入当前用户 prompt（textOnlyMessages.slice(0, -1) 语义）
  // - 含图片消息被单独过滤，而不是丢弃整段历史
  // - 最后一条为 user 角色时的去重行为与原实现一致
});

export {};
