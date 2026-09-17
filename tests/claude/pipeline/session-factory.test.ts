import { describe } from 'vitest';

/**
 * Phase 0 骨架（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.1）。
 * 目标模块 src/main/claude/pipeline/session-factory.ts 在 Phase 5 创建，
 * 届时启用以下行为契约（describe.todo → describe）。
 */
describe.todo('session-factory (Phase 5 启用)', () => {
  // 契约清单（Phase 5 落地时实现，对应文档 §5.5.1-§5.5.4）：
  // - buildSignature 维持现状字段：configProvider/customProtocol/modelProvider/
  //   modelApi/modelBaseUrl/effectiveCwd/apiKeyFingerprint（R1：不订阅 AuthStorage）
  // - 同 sessionId 并发 resolveOrCreate 被 AsyncChain 串行化（护栏，HIGH-1 降级定位）
  // - apiKey 轮换 → 签名变化 → dispose + 重建（"Runtime changed, recreating"日志）
  // - HIGH-4 分流：仅复用路径调用 applyRuntimeStrategies；
  //   复用路径只走 appendSystemPromptOverride 闭包更新 → reload() → setThinkingLevel()，
  //   不调用 setActiveToolsByName（全仓反向 grep = 0）
  // - MEDIUM-1：Ollama _onPayload 补丁只在 create() 内应用一次
  // - skillsSignature / MCP 指纹变化 → 各自触发重建
});

export {};
