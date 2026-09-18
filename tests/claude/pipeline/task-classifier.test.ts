import { describe, expect, it } from 'vitest';

import { classifyTask } from '../../../src/main/claude/pipeline/task-classifier';

/**
 * Phase 4 行为契约（AGENT-RUNNER-REFACTOR-PLAN.md §3.1 / §5.0.1）。
 * 纯正则分类器：优先级 document > code > research > chat（兜底），绝不抛错。
 */

// 每类 10+ 条真实用户消息样本（中英混合），用于逐类精确率 ≥ 80% 断言。
const DOCUMENT_SAMPLES: Array<[string, string]> = [
  ['生成一份本周的工作周报', 'document'],
  ['帮我做一个产品介绍 PPT', 'document'],
  ['写一份项目计划书', 'document'],
  ['导出一份销售数据的 Excel 表格', 'document'],
  ['整理成会议纪要文档', 'document'],
  ['制作一张活动海报', 'document'],
  ['generate a quarterly report', 'document'],
  ['create a slide deck for the demo', 'document'],
  ['write me a resume in docx', 'document'],
  ['export the invoice as pdf', 'document'],
];

const CODE_SAMPLES: Array<[string, string]> = [
  ['修复 agent-runner.ts 里的空指针问题', 'code'],
  ['把这个函数重构一下，太长了', 'code'],
  ['src/main/config/store.ts 编译报错', 'code'],
  ['写一个防抖函数', 'code'],
  ['实现用户登录接口', 'code'],
  ['这段代码跑不通，帮我调试一下', 'code'],
  ['fix the bug in the parser', 'code'],
  ['refactor this component to use hooks', 'code'],
  ['implement the API endpoint for uploads', 'code'],
  ['unit tests are failing after the merge conflict', 'code'],
];

const RESEARCH_SAMPLES: Array<[string, string]> = [
  ['搜一下最近的 AI 行业新闻', 'research'],
  ['查一下明天北京的天气', 'research'],
  ['帮我调研几款开源向量数据库', 'research'],
  ['最新的大模型行情怎么样', 'research'],
  ['search for the latest rust release notes', 'research'],
  ['look up recent news about electric vehicles', 'research'],
  ['research trending topics in quantum computing', 'research'],
  ['find recent papers on diffusion models', 'research'],
];

const CHAT_SAMPLES: Array<[string, string]> = [
  ['你好', 'chat'],
  ['谢谢，明白了', 'chat'],
  ['解释一下什么是量子纠缠', 'chat'],
  ['把刚才那段话翻译成英文', 'chat'],
  ['今天心情不错', 'chat'],
  ['你是谁', 'chat'],
  ['1 + 1 等于几', 'chat'],
  ['hello, how are you', 'chat'],
];

const ALL_SAMPLES = [...DOCUMENT_SAMPLES, ...CODE_SAMPLES, ...RESEARCH_SAMPLES, ...CHAT_SAMPLES];

function precision(samples: Array<[string, string]>): number {
  const hits = samples.filter(([msg, expected]) => classifyTask(msg) === expected).length;
  return hits / samples.length;
}

describe('classifyTask (Phase 4, pipeline/task-classifier.ts)', () => {
  it('returns one of the four valid task types for every sample', () => {
    const valid = new Set(['chat', 'code', 'document', 'research']);
    for (const [msg] of ALL_SAMPLES) {
      expect(valid.has(classifyTask(msg))).toBe(true);
    }
  });

  it('achieves >= 80% precision on document samples', () => {
    expect(precision(DOCUMENT_SAMPLES)).toBeGreaterThanOrEqual(0.8);
  });

  it('achieves >= 80% precision on code samples', () => {
    expect(precision(CODE_SAMPLES)).toBeGreaterThanOrEqual(0.8);
  });

  it('achieves >= 80% precision on research samples', () => {
    expect(precision(RESEARCH_SAMPLES)).toBeGreaterThanOrEqual(0.8);
  });

  it('achieves >= 80% precision on chat samples', () => {
    expect(precision(CHAT_SAMPLES)).toBeGreaterThanOrEqual(0.8);
  });

  it('falls back to chat for empty / whitespace-only input', () => {
    expect(classifyTask('')).toBe('chat');
    expect(classifyTask('   \n\t ')).toBe('chat');
  });

  it('never throws even on malformed input', () => {
    // @ts-expect-error 故意传入 undefined，验证兜底契约
    expect(() => classifyTask(undefined)).not.toThrow();
    // @ts-expect-error 故意传入 null，验证兜底契约
    expect(classifyTask(null)).toBe('chat');
    // @ts-expect-error 故意传入会抛错的 toString，验证 try/catch 兜底
    expect(
      classifyTask({
        toString: () => {
          throw new Error('boom');
        },
      })
    ).toBe('chat');
  });

  it('respects priority document > code when both intents appear', () => {
    // 「写一个脚本生成报告」同时命中文档与编码模式，文档优先
    expect(classifyTask('生成一份代码审查报告文档')).toBe('document');
  });
});
