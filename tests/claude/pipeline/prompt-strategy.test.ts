import { beforeEach, describe, expect, it, vi } from 'vitest';

// prompt-strategy 的平台/打包依赖全部 mock 掉：
// - electron：vitest.config.mts 已全局 alias 到 tests/mocks/electron.ts（isPackaged=false）
// - detect-command-tools / shell-resolver：避免测试中真实 execSync 探测
// - path-utils：bundled 路径可控
vi.mock('../../../src/main/utils/detect-command-tools', () => ({
  detectCommandTools: () => ({ shells: ['powershell.exe'], available: ['git.exe'] }),
  formatDetectedTools: () => 'detected: powershell.exe, git.exe',
}));
vi.mock('../../../src/main/utils/shell-resolver', () => ({
  getDefaultShell: () => 'powershell.exe',
}));
vi.mock('../../../src/main/claude/pipeline/path-utils', () => ({
  getBundledNodePaths: () => ({ node: '/bundled/node', npx: '/bundled/npx' }),
  resolveBundledPythonBinDir: () => '/bundled/python/bin',
}));

import { app } from 'electron';
import {
  PromptStrategy,
  VIRTUAL_WORKSPACE_PATH,
  getBundledPathHints,
} from '../../../src/main/claude/pipeline/prompt-strategy';
import type { TaskContext, TaskType } from '../../../src/main/claude/pipeline/context-types';

function makeCtx(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskType: 'chat',
    sessionId: 'sess-1',
    userMessage: 'hello',
    // 策略只读 provider，其余字段用 stub 填充
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelCtx: { provider: 'anthropic' } as any,
    platform: 'linux',
    hasMCPTools: false,
    effectiveCwd: '/tmp/cwd',
    ...overrides,
  };
}

const strategy = new PromptStrategy();

describe('PromptStrategy.assemble (Phase 4, pipeline/prompt-strategy.ts)', () => {
  beforeEach(() => {
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  });

  it('chat 档包含 base rules（CHAT FIRST、不主动写文件）', () => {
    const { systemPrompt } = strategy.assemble(makeCtx({ taskType: 'chat' }));
    expect(systemPrompt).toContain('CHAT FIRST');
    expect(systemPrompt).toContain(
      'Do NOT create, write, or edit files unless the user explicitly asks'
    );
    expect(systemPrompt).toContain('你是今点通智能助手');
  });

  it('所有任务类型都注入 toolBehavior 参数名教学（§3.2/§3.3：工具恒定全量）', () => {
    const taskTypes: TaskType[] = ['chat', 'code', 'document', 'research'];
    for (const taskType of taskTypes) {
      const { systemPrompt } = strategy.assemble(makeCtx({ taskType }));
      expect(systemPrompt, taskType).toContain('<tool_behavior>');
      expect(systemPrompt, taskType).toContain('oldText');
      expect(systemPrompt, taskType).toContain('read tool: use `path`');
    }
  });

  it('code 档包含 START DOING IT / reasonable assumptions，且注入 code_quality_rules', () => {
    const { systemPrompt } = strategy.assemble(makeCtx({ taskType: 'code' }));
    expect(systemPrompt).toContain('START DOING IT');
    expect(systemPrompt).toContain('proceed immediately with reasonable assumptions');
    expect(systemPrompt).toContain('<code_quality_rules>');
  });

  it('document 档注入 document_generation_rules，code 档不注入', () => {
    expect(strategy.assemble(makeCtx({ taskType: 'document' })).systemPrompt).toContain(
      '<document_generation_rules>'
    );
    expect(strategy.assemble(makeCtx({ taskType: 'code' })).systemPrompt).not.toContain(
      '<document_generation_rules>'
    );
    expect(strategy.assemble(makeCtx({ taskType: 'chat' })).systemPrompt).not.toContain(
      '<code_quality_rules>'
    );
  });

  it('citation_requirements 仅在 hasMCPTools=true 时注入，且为标准 Markdown 链接规则', () => {
    const withoutMcp = strategy.assemble(makeCtx({ hasMCPTools: false })).systemPrompt;
    expect(withoutMcp).not.toContain('<citation_requirements>');

    const withMcp = strategy.assemble(makeCtx({ hasMCPTools: true })).systemPrompt;
    expect(withMcp).toContain('<citation_requirements>');
    expect(withMcp).toContain(
      'otherwise use standard Markdown links: [Title](https://claude.ai/chat/URL)'
    );
  });

  it('任何 taskType 输出均不含 AskUserQuestion / TodoWrite / pendingQuestions', () => {
    for (const taskType of ['chat', 'code', 'document', 'research'] as TaskType[]) {
      const { systemPrompt } = strategy.assemble(makeCtx({ taskType }));
      expect(systemPrompt).not.toContain('AskUserQuestion');
      expect(systemPrompt).not.toContain('TodoWrite');
      expect(systemPrompt).not.toContain('pendingQuestions');
    }
  });

  it('workspace_info：有 sandboxPath 时展示虚拟路径，否则展示 workingDir', () => {
    const sandboxed = strategy.assemble(
      makeCtx({ sandboxPath: '/real/sandbox/path' })
    ).systemPrompt;
    expect(sandboxed).toContain(`located at: ${VIRTUAL_WORKSPACE_PATH}`);
    expect(sandboxed).not.toContain('/real/sandbox/path');

    const plain = strategy.assemble(makeCtx({ workingDir: '/home/user/proj' })).systemPrompt;
    expect(plain).toContain('Your current workspace is: /home/user/proj');

    const neither = strategy.assemble(makeCtx()).systemPrompt;
    expect(neither).not.toContain('<workspace_info>');
  });

  it('platform_info 仅 win32 注入（含 shell 选择与命令替换提示）', () => {
    const win = strategy.assemble(makeCtx({ platform: 'win32' })).systemPrompt;
    expect(win).toContain('<platform_info>');
    expect(win).toContain('powershell.exe');

    const linux = strategy.assemble(makeCtx({ platform: 'linux' })).systemPrompt;
    expect(linux).not.toContain('<platform_info>');
  });

  it('tokenEstimate 为正且与内容量级一致（CJK 内容按 ~1.5 chars/token）', () => {
    for (const taskType of ['chat', 'code', 'document', 'research'] as TaskType[]) {
      const { systemPrompt, tokenEstimate } = strategy.assemble(makeCtx({ taskType }));
      expect(tokenEstimate).toBeGreaterThan(0);
      // 量级断言：估算值应落在 [len/4, len] 区间内
      expect(tokenEstimate).toBeLessThanOrEqual(systemPrompt.length);
      expect(tokenEstimate).toBeGreaterThanOrEqual(Math.floor(systemPrompt.length / 4));
    }
    // code 档（多一个 section）应比 chat 档更大
    expect(strategy.assemble(makeCtx({ taskType: 'code' })).tokenEstimate).toBeGreaterThan(
      strategy.assemble(makeCtx({ taskType: 'chat' })).tokenEstimate
    );
  });

  it('getBundledPathHints：dev 模式为空，打包模式注入 <bundled_executables>', () => {
    expect(getBundledPathHints()).toBe('');

    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
    const hints = getBundledPathHints();
    expect(hints).toContain('<bundled_executables>');
    expect(hints).toContain('/bundled/node');
    expect(hints).toContain('/bundled/npx');
    expect(hints).toContain('/bundled/python/bin');
  });

  it('打包模式下 assemble 自动追加 bundled 路径提示', () => {
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
    const { systemPrompt } = strategy.assemble(makeCtx());
    expect(systemPrompt).toContain('<bundled_executables>');
  });
});
