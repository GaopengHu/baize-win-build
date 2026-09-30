/**
 * dispatch_agent 闸门回归（Phase 7.1）：
 * - 并发超限 → 工具错误文本（含"自己完成/不重试"指令），不进 runSubagent
 * - 轮次预算超限 → 同上（含"不再拆分"指令）
 * - 参数缺失 / 未知 subagent_type → 拒绝文本
 * - 成功路径 → 并发计数 finally 递减
 * - research profile：无写工具、无 dispatch_agent（源码级负向断言）
 * - 报告截断上限
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildDispatchAgentTool,
  resetSubagentGates,
  getGateCounts,
  MAX_CONCURRENT_CHILDREN,
  MAX_DISPATCHES_PER_TURN,
  DISPATCH_AGENT_TOOL_NAME,
  type DispatchAgentDeps,
} from '../../../src/main/claude/subagent/subagent-tool';
import {
  getResearchToolNames,
  getProfileToolNames,
  truncateReport,
  SUBAGENT_REPORT_CHAR_LIMIT,
  MAX_CHILD_TOOL_CALLS,
} from '../../../src/main/claude/subagent/subagent-runner';

vi.mock('../../../src/main/claude/subagent/subagent-runner', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../../src/main/claude/subagent/subagent-runner')>();
  return {
    ...original,
    runSubagent: vi.fn(async () => ({
      report: 'mocked report',
      truncated: false,
      toolCallCount: 2,
      durationMs: 10,
      aborted: false,
    })),
  };
});

import { runSubagent } from '../../../src/main/claude/subagent/subagent-runner';

const mockedRunSubagent = vi.mocked(runSubagent);

function makeDeps(parentSessionId = 'sess-1'): DispatchAgentDeps {
  return {
    parentSessionId,
    runnerDeps: {
      cwd: '/tmp',
      model: {} as never,
      authStorage: {} as never,
      thinkingLevel: 'medium',
      search: { engine: 'none', apiKey: '', timeoutMs: 10000 },
      chromeBrowsingTools: [],
      mergeCustomTools: (...groups) => groups.flat(),
      parentSessionId,
    },
  };
}

async function callExecute(
  parentSessionId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
) {
  const tool = buildDispatchAgentTool(makeDeps(parentSessionId));
  expect(tool.name).toBe(DISPATCH_AGENT_TOOL_NAME);
  const result = await tool.execute(
    'call-1',
    params as never,
    signal,
    undefined,
    undefined as never
  );
  const text = (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');
  return { text, result };
}

beforeEach(() => {
  resetSubagentGates('sess-1');
  resetSubagentGates('sess-2');
  mockedRunSubagent.mockClear();
});

describe('dispatch_agent gates', () => {
  it('rejects missing params without running a child', async () => {
    const { text } = await callExecute('sess-1', { description: '', prompt: '' });
    expect(text).toMatch(/description 与 prompt 必填/);
    expect(mockedRunSubagent).not.toHaveBeenCalled();
  });

  it('rejects unknown subagent_type (入口收窄）', async () => {
    const { text } = await callExecute('sess-1', {
      description: 'd',
      prompt: 'p',
      subagent_type: 'planner',
    });
    expect(text).toMatch(/仅 research\/document\/general/);
    expect(mockedRunSubagent).not.toHaveBeenCalled();
  });

  it('accepts document/general and forwards the profile to runSubagent', async () => {
    for (const profile of ['document', 'general'] as const) {
      resetSubagentGates('sess-doc');
      const { text } = await callExecute('sess-doc', {
        description: 'd',
        prompt: 'p',
        subagent_type: profile,
      });
      expect(text).toMatch(/mocked report/);
      expect(mockedRunSubagent).toHaveBeenCalledWith(
        expect.objectContaining({ profile }),
        expect.anything()
      );
    }
  });

  it('blocks the 4th concurrent dispatch with no-retry instruction', async () => {
    // 占满 3 个并发槽：直接调 execute 但不等待（mock runSubagent 立即 resolve，
    // 因此用 gate 计数器手工预占——通过连续调用验证第 4 次被拦）。
    // 更直接：跑满预算前先成功 3 次（串行 mock 下并发计数会回落），
    // 所以这里验证"超限文本"语义：手动把计数器顶满再调。
    const tool = buildDispatchAgentTool(makeDeps('sess-1'));
    // 通过 3 次成功调用消耗轮次预算的同时验证成功路径计数回落
    for (let i = 0; i < MAX_DISPATCHES_PER_TURN; i += 1) {
      const r = await tool.execute(
        `call-${i}`,
        { description: 'd', prompt: 'p', subagent_type: 'research' } as never,
        undefined,
        undefined,
        undefined as never
      );
      expect((r.content as Array<{ text?: string }>)[0].text).toMatch(/mocked report/);
    }
    expect(getGateCounts('sess-1')).toEqual({ running: 0, turnUsed: MAX_DISPATCHES_PER_TURN });
    // 第 4 次：轮次预算耗尽
    const { text } = await callExecute('sess-1', {
      description: 'd',
      prompt: 'p',
      subagent_type: 'research',
    });
    expect(text).toMatch(/委派次数已用完/);
    expect(text).toMatch(/不要再拆分/);
    expect(mockedRunSubagent).toHaveBeenCalledTimes(MAX_DISPATCHES_PER_TURN);
  });

  it('blocks the 4th concurrent dispatch with no-retry instruction', async () => {
    // 用可控 deferred 让 3 个 child 同时"在跑"，第 4 个必须被并发闸门拦下
    // （且携带"不要等待、不要重试"的模型指令）。
    resetSubagentGates('sess-2');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockedRunSubagent.mockImplementationOnce(() => gate.then(() => ({
      report: 'r1',
      truncated: false,
      toolCallCount: 1,
      durationMs: 1,
      aborted: false,
    })));
    mockedRunSubagent.mockImplementationOnce(() => gate.then(() => ({
      report: 'r2',
      truncated: false,
      toolCallCount: 1,
      durationMs: 1,
      aborted: false,
    })));
    mockedRunSubagent.mockImplementationOnce(() => gate.then(() => ({
      report: 'r3',
      truncated: false,
      toolCallCount: 1,
      durationMs: 1,
      aborted: false,
    })));

    const tool = buildDispatchAgentTool(makeDeps('sess-2'));
    const running = [0, 1, 2].map((i) =>
      tool.execute(
        `cc-${i}`,
        { description: 'd', prompt: 'p', subagent_type: 'research' } as never,
        undefined,
        undefined,
        undefined as never
      )
    );
    // 让出一个微任务，确保 3 个 execute 都已进入 runSubagent（计数器叠到 3）
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getGateCounts('sess-2').running).toBe(3);

    const blocked = await tool.execute(
      'cc-3',
      { description: 'd', prompt: 'p', subagent_type: 'research' } as never,
      undefined,
      undefined,
      undefined as never
    );
    const blockedText = ((blocked.content as Array<{ text?: string }>)[0].text ?? '');
    expect(blockedText).toMatch(/并发已满/);
    expect(blockedText).toMatch(/不要等待、不要重试/);
    expect(mockedRunSubagent).toHaveBeenCalledTimes(3);

    release();
    const done = await Promise.all(running);
    expect(done).toHaveLength(3);
    expect(getGateCounts('sess-2')).toEqual({ running: 0, turnUsed: 3 });
  });

  it('respects an already-aborted parent signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { text } = await callExecute(
      'sess-1',
      { description: 'd', prompt: 'p', subagent_type: 'research' },
      controller.signal
    );
    expect(text).toMatch(/已取消/);
    expect(mockedRunSubagent).not.toHaveBeenCalled();
    expect(getGateCounts('sess-1').running).toBe(0);
  });
});

describe('profile static guarantees', () => {
  it('research has no write/edit/bash tools and no dispatch_agent (no nesting)', () => {
    const names = getResearchToolNames();
    for (const banned of ['write', 'edit', 'bash', 'dispatch_agent', DISPATCH_AGENT_TOOL_NAME]) {
      expect(names).not.toContain(banned);
    }
    expect(names).toEqual(expect.arrayContaining(['read', 'grep', 'find', 'ls', 'web_search']));
  });

  it('document/general expose full tools (write path gated by permission hook)', () => {
    for (const profile of ['document', 'general'] as const) {
      const names = getProfileToolNames(profile);
      expect(names).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write']));
      expect(names).not.toContain('dispatch_agent');
    }
  });

  it('truncates over-long reports at the char limit', () => {
    const long = 'x'.repeat(SUBAGENT_REPORT_CHAR_LIMIT + 100);
    const { report, truncated } = truncateReport(long);
    expect(truncated).toBe(true);
    expect(report.length).toBeLessThan(long.length);
    expect(report).toMatch(/截断/);
    const short = truncateReport('ok');
    expect(short).toEqual({ report: 'ok', truncated: false });
  });

  it('child tool budget constant is sane', () => {
    expect(MAX_CHILD_TOOL_CALLS).toBeGreaterThan(0);
    expect(MAX_CONCURRENT_CHILDREN).toBe(3);
    expect(MAX_DISPATCHES_PER_TURN).toBe(3);
  });
});
