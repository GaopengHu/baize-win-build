import { describe, expect, it } from 'vitest';

import { ThinkingStrategy } from '../../../src/main/claude/pipeline/thinking-strategy';
import type { TaskContext, TaskType } from '../../../src/main/claude/pipeline/context-types';

const strategy = new ThinkingStrategy();

function makeCtx(taskType: TaskType, provider = 'anthropic'): TaskContext {
  return {
    taskType,
    sessionId: 'sess-1',
    userMessage: 'x',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelCtx: { provider } as any,
    platform: 'linux',
    hasMCPTools: false,
    effectiveCwd: '/tmp/cwd',
  };
}

describe('ThinkingStrategy.resolve (Phase 4, pipeline/thinking-strategy.ts)', () => {
  it('§3.4 矩阵：enableThinking=true 时按任务类型分档', () => {
    expect(strategy.resolve(makeCtx('chat'), true)).toBe('off');
    expect(strategy.resolve(makeCtx('research'), true)).toBe('low');
    expect(strategy.resolve(makeCtx('code'), true)).toBe('medium');
    expect(strategy.resolve(makeCtx('document'), true)).toBe('low');
  });

  it('enableThinking=false 时任何 taskType 都返回 off（用户全局开关优先）', () => {
    for (const taskType of ['chat', 'code', 'document', 'research'] as TaskType[]) {
      expect(strategy.resolve(makeCtx(taskType), false), taskType).toBe('off');
    }
  });

  it('provider=ollama 强制 off（小模型 thinking 质量差），即使 enableThinking=true', () => {
    for (const taskType of ['chat', 'code', 'document', 'research'] as TaskType[]) {
      expect(strategy.resolve(makeCtx(taskType, 'ollama'), true), taskType).toBe('off');
    }
  });

  it('未知 provider 不受影响（仅 ollama 特判）', () => {
    expect(strategy.resolve(makeCtx('code', 'some-new-provider'), true)).toBe('medium');
  });

  it('畸形 ctx 安全兜底：不抛错，走 default 档', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const malformed = {} as any;
    expect(() => strategy.resolve(malformed, true)).not.toThrow();
    expect(strategy.resolve(malformed, true)).toBe('medium');
    expect(strategy.resolve(malformed, false)).toBe('off');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy.resolve({ modelCtx: { provider: 'ollama' } } as any, true)).toBe('off');
  });
});
