import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logCtx: vi.fn(),
  logCtxWarn: vi.fn(),
  logCtxError: vi.fn(),
  logTiming: vi.fn(),
}));

// SDK 全量 mock：createAgentSession 返回受控 fake session；DefaultResourceLoader
// 记录构造参数（appendSystemPromptOverride 闭包在 reload 时求值，用于验证
// 「先更新闭包、再 reload」的顺序契约）。
const mocks = vi.hoisted(() => {
  const state = {
    events: [] as string[],
    loaderInstances: [] as Array<{ options: Record<string, unknown> }>,
    sessions: [] as Array<Record<string, unknown> & { agent: Record<string, unknown> }>,
    /** 'with' = agent 暴露 _onPayload（默认）；'without' = 不暴露（MEDIUM-1 守卫路径） */
    agentMode: 'with' as 'with' | 'without',
    settingsInMemoryCalls: [] as unknown[],
  };
  const makeSession = () => {
    const idx = state.sessions.length + 1;
    const id = `pi-${idx}`;
    const agent: Record<string, unknown> = {};
    if (state.agentMode === 'with') {
      agent._onPayload = async (payload: Record<string, unknown>) => payload;
    }
    const session = {
      id,
      agent,
      reload: async () => {
        // reload 时刻对闭包求值：证明复用路径「先写 appendPrompt.current 再 reload」
        const loader = state.loaderInstances[state.loaderInstances.length - 1];
        const override = loader?.options.appendSystemPromptOverride as () => string[];
        state.events.push(`${id}:reload:${override ? override().join('|') : ''}`);
      },
      setModel: async (m: { id: string }) => {
        state.events.push(`${id}:setModel:${m.id}`);
      },
      setThinkingLevel: (level: string) => {
        state.events.push(`${id}:setThinkingLevel:${level}`);
      },
      dispose: () => {
        state.events.push(`${id}:dispose`);
      },
    };
    state.sessions.push(session);
    return session;
  };
  const createAgentSession = vi.fn(async (_opts: unknown) => ({ session: makeSession() }));
  class DefaultResourceLoader {
    options: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.options = opts;
      state.loaderInstances.push(this);
    }
    async reload() {
      state.events.push('loader:reload');
    }
  }
  const SessionManager = { inMemory: vi.fn(() => ({ kind: 'session-manager' })) };
  const SettingsManager = {
    inMemory: vi.fn((opts: unknown) => {
      state.settingsInMemoryCalls.push(opts);
      return { kind: 'settings-manager' };
    }),
  };
  const createCodingTools = vi.fn(() => []);
  const installPermissionHook = vi.fn();
  class ModelRegistry {
    kind = 'model-registry';
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_authStorage?: unknown) {}
  }
  return {
    state,
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    createCodingTools,
    installPermissionHook,
    ModelRegistry,
    reset() {
      state.events = [];
      state.loaderInstances = [];
      state.sessions = [];
      state.agentMode = 'with';
      state.settingsInMemoryCalls = [];
      createAgentSession.mockClear();
      SessionManager.inMemory.mockClear();
      SettingsManager.inMemory.mockClear();
      installPermissionHook.mockClear();
    },
  };
});

vi.mock('@mariozechner/pi-coding-agent', () => ({
  createAgentSession: mocks.createAgentSession,
  DefaultResourceLoader: mocks.DefaultResourceLoader,
  SessionManager: mocks.SessionManager,
  SettingsManager: mocks.SettingsManager,
  createCodingTools: mocks.createCodingTools,
}));

vi.mock('../../../src/main/claude/shared-auth', () => ({
  ModelRegistry: mocks.ModelRegistry,
  getSharedAuthStorage: vi.fn(),
}));

vi.mock('../../../src/main/claude/tools/permission-hook', () => ({
  installPermissionHook: mocks.installPermissionHook,
}));

import { logCtx, logWarn } from '../../../src/main/utils/logger';
import {
  PiSessionFactory,
  resolveCompactionSettings,
} from '../../../src/main/claude/pipeline/session-factory';
import type {
  PiThinkingLevel,
  SessionInput,
} from '../../../src/main/claude/pipeline/context-types';

/**
 * Phase 5 行为契约（AGENT-RUNNER-REFACTOR-PLAN.md §5.5.1-§5.5.4）。
 * 覆盖：buildSignature 字段、HIGH-1 并发串行、apiKey 轮换重建、HIGH-4 分流
 * （仅复用路径 applyRuntimeStrategies）、MEDIUM-1 Ollama 补丁、skills/MCP
 * 指纹重建、闭包更新→reload 顺序、setActiveToolsByName 反向断言。
 */

function makeInput(
  o: {
    sessionId?: string;
    systemPrompt?: string;
    apiKey?: string;
    modelId?: string;
    provider?: string;
    contextWindow?: number;
    thinkingLevel?: PiThinkingLevel;
    skillsSignature?: string;
    mcpFingerprint?: string;
  } = {}
): SessionInput {
  const sessionId = o.sessionId ?? 'sess-1';
  const provider = o.provider ?? 'anthropic';
  const contextWindow = o.contextWindow ?? 128000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const piModel = {
    id: o.modelId ?? 'model-a',
    provider,
    api: 'openai-completions',
    baseUrl: 'https://api.example.com',
    contextWindow,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const modelCtx = {
    piModel,
    provider,
    configProtocol: 'openai-completions',
    contextWindow,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authStorage: {} as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtimeConfig: {} as any,
  };
  const taskCtx = {
    taskType: 'code' as const,
    sessionId,
    userMessage: 'hi',
    modelCtx,
    platform: 'linux' as NodeJS.Platform,
    hasMCPTools: false,
    effectiveCwd: '/tmp/cwd',
  };
  return {
    sessionId,
    modelCtx,
    taskCtx,
    prompt: { systemPrompt: o.systemPrompt ?? 'SYS-PROMPT-V1', tokenEstimate: 100 },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: { codingTools: [] as any },
    thinkingLevel: o.thinkingLevel ?? 'medium',
    skillPaths: ['/skills/a'],
    customTools: [],
    signature: {
      configProvider: 'custom',
      customProtocol: 'openai-completions',
      modelProvider: provider,
      modelApi: 'openai-completions',
      modelBaseUrl: 'https://api.example.com',
      effectiveCwd: '/tmp/cwd',
      apiKey: o.apiKey ?? 'sk-test-key',
      skillsSignature: o.skillsSignature ?? '["/skills/a"]',
      mcpFingerprint: o.mcpFingerprint ?? 'mcp-fp-1',
    },
    sessionCwd: '/tmp/session-cwd',
    permissionDeps: { getToolDisplayName: (n: string) => n },
  };
}

describe('PiSessionFactory (Phase 5, pipeline/session-factory.ts)', () => {
  beforeEach(() => {
    mocks.reset();
    vi.mocked(logCtx).mockClear();
    vi.mocked(logWarn).mockClear();
  });

  describe('buildSignature（§5.5.4 迁移：原 recreates cached pi sessions 断言组）', () => {
    it('相同原料 → 相同签名；任一字段变化 → 签名变化', () => {
      const factory = new PiSessionFactory();
      const base = makeInput().signature;
      const sig = factory.buildSignature(base);
      expect(factory.buildSignature({ ...base })).toBe(sig);
      expect(factory.buildSignature({ ...base, apiKey: 'rotated' })).not.toBe(sig);
      expect(factory.buildSignature({ ...base, modelBaseUrl: 'https://other' })).not.toBe(sig);
      expect(factory.buildSignature({ ...base, effectiveCwd: '/other/cwd' })).not.toBe(sig);
      expect(factory.buildSignature({ ...base, skillsSignature: '["/skills/b"]' })).not.toBe(sig);
      expect(factory.buildSignature({ ...base, mcpFingerprint: 'mcp-fp-2' })).not.toBe(sig);
    });

    it('apiKey 只以 sha256 指纹参与签名，不落明文（R1）', () => {
      const factory = new PiSessionFactory();
      const sig = factory.buildSignature(makeInput({ apiKey: 'sk-super-secret' }).signature);
      expect(sig).not.toContain('sk-super-secret');
      expect(sig).toContain('apiKeyFingerprint');
    });
  });

  describe('新建路径（HIGH-4）', () => {
    it('createAgentSession 恰好一次；不调用 reload/setThinkingLevel（构造参数直接生效）', async () => {
      const factory = new PiSessionFactory();
      const result = await factory.resolveOrCreate(makeInput());
      expect(result.isReused).toBe(false);
      expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
      // 新建路径不得触发运行时策略应用（session 级事件为空）
      expect(mocks.state.events.filter((e) => e.startsWith('pi-'))).toEqual([]);
      // loader 构造：additionalSkillPaths + appendSystemPromptOverride mutable 闭包
      const loader = mocks.state.loaderInstances[0];
      expect(loader.options.additionalSkillPaths).toEqual(['/skills/a']);
      const override = loader.options.appendSystemPromptOverride as () => string[];
      expect(override()).toEqual(['SYS-PROMPT-V1']);
      // 权限钩子安装一次（携带 sessionCwd 与 deps）
      expect(mocks.installPermissionHook).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mocks.installPermissionHook).mock.calls[0][1]).toBe('sess-1');
      expect(vi.mocked(mocks.installPermissionHook).mock.calls[0][2]).toBe('/tmp/session-cwd');
      // compaction/retry 设置传入 SettingsManager.inMemory
      expect(mocks.state.settingsInMemoryCalls[0]).toMatchObject({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
      });
    });
  });

  describe('复用路径（HIGH-4 / §3.2）', () => {
    it('第二次 resolveOrCreate：不再 create，reload + setThinkingLevel 各一次', async () => {
      const factory = new PiSessionFactory();
      const first = await factory.resolveOrCreate(makeInput());
      const second = await factory.resolveOrCreate(makeInput());
      expect(second.isReused).toBe(true);
      expect(second.piSession).toBe(first.piSession);
      expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
      expect(mocks.installPermissionHook).toHaveBeenCalledTimes(1);
      expect(mocks.state.events).toContain('pi-1:reload:SYS-PROMPT-V1');
      expect(mocks.state.events).toContain('pi-1:setThinkingLevel:medium');
      // 模型未变 → 不触发 setModel
      expect(mocks.state.events.some((e) => e.includes('setModel'))).toBe(false);
    });

    it('顺序契约：先更新 appendPrompt 闭包，再 reload（reload 时求值已是新 prompt）', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput({ systemPrompt: 'P1' }));
      await factory.resolveOrCreate(makeInput({ systemPrompt: 'P2' }));
      // reload mock 在调用时刻对闭包求值：若闭包未先更新，这里会是 P1
      expect(mocks.state.events).toContain('pi-1:reload:P2');
    });

    it('model 变化 → setModel 热替换；thinking 变化 → setThinkingLevel 生效', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput({ modelId: 'model-a', thinkingLevel: 'medium' }));
      await factory.resolveOrCreate(makeInput({ modelId: 'model-b', thinkingLevel: 'high' }));
      expect(mocks.state.events).toContain('pi-1:setModel:model-b');
      expect(mocks.state.events).toContain('pi-1:setThinkingLevel:high');
      expect(logCtx).toHaveBeenCalledWith(
        '[ClaudeAgentRunner] Model changed, hot-swapping:',
        'model-a',
        '→',
        'model-b'
      );
    });
  });

  describe('HIGH-1：同 sessionId 并发串行化（护栏）', () => {
    it('5 个并发 resolveOrCreate 只 create 一次，返回同一 session', async () => {
      const factory = new PiSessionFactory();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => factory.resolveOrCreate(makeInput()))
      );
      expect(mocks.createAgentSession).toHaveBeenCalledTimes(1);
      const first = results[0].piSession;
      for (const r of results) {
        expect(r.piSession).toBe(first);
      }
      expect(results.filter((r) => !r.isReused)).toHaveLength(1);
      expect(results.filter((r) => r.isReused)).toHaveLength(4);
    });
  });

  describe('签名分量变化 → dispose + 重建', () => {
    it('apiKey 轮换：invalidateIfStale 输出 Runtime changed 日志并 dispose', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput({ apiKey: 'sk-old' }));
      expect(factory.hasValidSession('sess-1')).toBe(true);

      const rotated = makeInput({ apiKey: 'sk-new' });
      factory.invalidateIfStale('sess-1', rotated.signature);
      expect(mocks.state.events).toContain('pi-1:dispose');
      expect(factory.hasValidSession('sess-1')).toBe(false);
      expect(logCtx).toHaveBeenCalledWith(
        '[ClaudeAgentRunner] Runtime changed, recreating cached pi session:',
        'sess-1'
      );

      const rebuilt = await factory.resolveOrCreate(rotated);
      expect(rebuilt.isReused).toBe(false);
      expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    });

    it('skillsSignature 变化 → Skills changed 日志 + 重建', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput({ skillsSignature: '["/skills/a"]' }));
      factory.invalidateIfStale(
        'sess-1',
        makeInput({ skillsSignature: '["/skills/a","/skills/b"]' }).signature
      );
      expect(mocks.state.events).toContain('pi-1:dispose');
      expect(logCtx).toHaveBeenCalledWith(
        '[ClaudeAgentRunner] Skills changed, recreating cached pi session:',
        'sess-1'
      );
      expect(factory.hasValidSession('sess-1')).toBe(false);
    });

    it('MCP 指纹变化 → MCP config changed 日志 + 重建（§5.5.3 有意行为变更）', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput({ mcpFingerprint: 'fp-1' }));
      factory.invalidateIfStale('sess-1', makeInput({ mcpFingerprint: 'fp-2' }).signature);
      expect(mocks.state.events).toContain('pi-1:dispose');
      expect(logCtx).toHaveBeenCalledWith(
        '[ClaudeAgentRunner] MCP config changed, recreating cached pi session:',
        'sess-1'
      );
      expect(factory.hasValidSession('sess-1')).toBe(false);
    });

    it('resolveOrCreate 兜底：未经 invalidateIfStale 的签名失配也触发重建', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput({ apiKey: 'sk-old' }));
      const rebuilt = await factory.resolveOrCreate(makeInput({ apiKey: 'sk-new' }));
      expect(rebuilt.isReused).toBe(false);
      expect(mocks.state.events).toContain('pi-1:dispose');
      expect(mocks.createAgentSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('MEDIUM-1：Ollama _onPayload num_ctx 补丁', () => {
    it('provider === ollama：包装 _onPayload，注入 num_ctx = contextWindow', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(
        makeInput({ provider: 'ollama', modelId: 'qwen', contextWindow: 8192 })
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = mocks.state.sessions[0].agent as any;
      const result = await agent._onPayload({ foo: 1 }, {});
      expect(result).toMatchObject({ foo: 1, num_ctx: 8192 });
    });

    it('model 热替换时同步更新 num_ctx 引用', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(
        makeInput({ provider: 'ollama', modelId: 'qwen-8k', contextWindow: 8192 })
      );
      await factory.resolveOrCreate(
        makeInput({ provider: 'ollama', modelId: 'qwen-32k', contextWindow: 32768 })
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = mocks.state.sessions[0].agent as any;
      const result = await agent._onPayload({}, {});
      expect(result.num_ctx).toBe(32768);
    });

    it('非 ollama provider：不打补丁', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput({ provider: 'anthropic' }));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent = mocks.state.sessions[0].agent as any;
      const result = await agent._onPayload({ foo: 1 }, {});
      expect(result).toEqual({ foo: 1 });
      expect(result).not.toHaveProperty('num_ctx');
    });

    it('SDK 不暴露 _onPayload 时守卫跳过并告警', async () => {
      mocks.state.agentMode = 'without';
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput({ provider: 'ollama' }));
      expect(logWarn).toHaveBeenCalledWith(
        '[ClaudeAgentRunner] SDK agent does not expose _onPayload — skipping Ollama num_ctx patch'
      );
    });
  });

  describe('resolveCompactionSettings（Ollama 分档）', () => {
    it('ollama < 16384 → 禁用 compaction', () => {
      expect(resolveCompactionSettings('ollama', 8192)).toEqual({ enabled: false });
    });
    it('ollama < 65536 → 比例缩放 reserve/keepRecent', () => {
      expect(resolveCompactionSettings('ollama', 32768)).toEqual({
        enabled: true,
        reserveTokens: Math.floor(32768 * 0.15),
        keepRecentTokens: Math.floor(32768 * 0.25),
      });
    });
    it('ollama 大窗口 / 其他 provider → 默认启用', () => {
      expect(resolveCompactionSettings('ollama', 131072)).toEqual({ enabled: true });
      expect(resolveCompactionSettings('anthropic', 8192)).toEqual({ enabled: true });
    });
  });

  describe('缓存生命周期', () => {
    it('clearSession：dispose + 移出缓存', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput());
      factory.clearSession('sess-1');
      expect(mocks.state.events).toContain('pi-1:dispose');
      expect(factory.hasValidSession('sess-1')).toBe(false);
      expect(logCtx).not.toHaveBeenCalled(); // clearSession 用 log 不用 logCtx
    });

    it('超过 MAX_CACHED_SESSIONS 时驱逐最旧会话', async () => {
      const factory = new PiSessionFactory();
      const total = PiSessionFactory.MAX_CACHED_SESSIONS + 1;
      for (let i = 0; i < total; i++) {
        await factory.resolveOrCreate(makeInput({ sessionId: `sess-${i}` }));
      }
      expect(mocks.state.events).toContain('pi-1:dispose');
      expect(factory.hasValidSession('sess-0')).toBe(false);
      expect(factory.hasValidSession(`sess-${total - 1}`)).toBe(true);
    });

    it('clearAll：全部 dispose', async () => {
      const factory = new PiSessionFactory();
      await factory.resolveOrCreate(makeInput({ sessionId: 'a' }));
      await factory.resolveOrCreate(makeInput({ sessionId: 'b' }));
      factory.clearAll();
      expect(mocks.state.events).toContain('pi-1:dispose');
      expect(mocks.state.events).toContain('pi-2:dispose');
      expect(factory.hasValidSession('a')).toBe(false);
      expect(factory.hasValidSession('b')).toBe(false);
    });
  });

  describe('源码反向断言（锁定决策）', () => {
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/main/claude/pipeline/session-factory.ts'),
      'utf8'
    );

    it('从不调用 setActiveToolsByName（工具集恒定全量，§3.3）', () => {
      expect(source).not.toMatch(/\.\s*setActiveToolsByName\s*\(/);
    });

    it('不订阅 AuthStorage 变更（R1：密钥轮换靠签名比对触发重建）', () => {
      expect(source).not.toMatch(/authStorage\.on|AuthStorage\.on|\.onChange\s*\(/);
    });

    it('使用 appendSystemPromptOverride mutable 闭包而非整体覆盖 system prompt', () => {
      expect(source).toContain('appendSystemPromptOverride');
      expect(source).toContain('appendPrompt.current = input.prompt.systemPrompt');
      expect(source).toContain('await cached.session.reload()');
    });
  });
});
