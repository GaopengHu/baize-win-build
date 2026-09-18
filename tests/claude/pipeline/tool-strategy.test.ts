import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { ToolStrategy } from '../../../src/main/claude/pipeline/tool-strategy';
import type { TaskContext, TaskType } from '../../../src/main/claude/pipeline/context-types';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

const strategy = new ToolStrategy();

function makeCtx(taskType: TaskType): TaskContext {
  return {
    taskType,
    sessionId: 'sess-tool-1',
    userMessage: 'x',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelCtx: { provider: 'anthropic' } as any,
    platform: 'linux',
    hasMCPTools: false,
    effectiveCwd: '/tmp/cwd',
  };
}

function names(tools: ToolDefinition[]): string[] {
  return tools.map((t) => t.name).sort();
}

describe('ToolStrategy (Phase 4, pipeline/tool-strategy.ts)', () => {
  it('【锁定决策 §3.3】四类 taskType 返回完全相同的工具名单（恒定全量，不裁剪）', () => {
    const taskTypes: TaskType[] = ['chat', 'code', 'document', 'research'];
    const results = taskTypes.map((t) => names(strategy.assemble(makeCtx(t)).codingTools));
    const baseline = results[0];
    expect(baseline.length).toBeGreaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i], taskTypes[i]).toEqual(baseline);
    }
    // 全量内置工具应包含 read/write/edit/bash
    expect(baseline).toEqual(expect.arrayContaining(['read', 'write', 'edit', 'bash']));
  });

  it('源码反向断言：模块内不得出现按 taskType 过滤工具的分支', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/claude/pipeline/tool-strategy.ts'),
      'utf8'
    );
    expect(source).not.toMatch(/taskType\s*===/);
    // 不得出现真实调用（注释里的“不调用 setActiveToolsByName”说明文字除外）
    expect(source).not.toMatch(/\.\s*setActiveToolsByName\s*\(/);
  });

  it('bash 工具经过 timeout → sudo 包装链（execute 仍为函数）', () => {
    const { codingTools } = strategy.assemble(makeCtx('code'));
    const bash = codingTools.find((t) => t.name === 'bash');
    expect(bash).toBeDefined();
    expect(typeof bash?.execute).toBe('function');
    // 包装链保留了工具数量（只替换 bash 定义，不增删工具）
    expect(names(codingTools)).toEqual(names(strategy.assemble(makeCtx('code'), {}).codingTools));
  });

  it('deps.bashOptions 透传（win32 分支），缺省时不报错', () => {
    const withOpts = strategy.assemble(makeCtx('chat'), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      bashOptions: {} as any,
    });
    expect(withOpts.codingTools.length).toBeGreaterThan(0);
  });

  it('mergeCustomTools 按 name 去重，先到先得（MCP 组在前）', () => {
    const mk = (name: string, label: string): ToolDefinition =>
      ({ name, label, description: label }) as unknown as ToolDefinition;

    const merged = strategy.mergeCustomTools(
      [mk('dup', 'mcp-version'), mk('mcp_only', 'mcp')],
      [mk('dup', 'ext-version'), mk('ext_only', 'ext')]
    );
    expect(merged.map((t) => t.name)).toEqual(['dup', 'mcp_only', 'ext_only']);
    // 同名工具保留第一个（MCP 桥接优先，与旧 [...mcp, ...ext] 顺序一致）
    expect(merged[0].description).toBe('mcp-version');
  });

  it('mergeCustomTools 容忍空组 / undefined', () => {
    expect(strategy.mergeCustomTools()).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(strategy.mergeCustomTools(undefined as any, [])).toEqual([]);
  });
});
