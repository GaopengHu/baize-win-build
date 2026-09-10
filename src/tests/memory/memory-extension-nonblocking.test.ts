import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfigState = vi.hoisted(() => ({
  config: {
    memoryEnabled: true,
    memoryRuntime: {
      retrievalMode: 'background',
      retrievalTimeoutMs: 8000,
    },
  } as Record<string, unknown>,
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    getAppPath: () => '/tmp/open-cowork-test-app',
  },
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    getAll: () => ({ ...mockConfigState.config }),
    get: (key: string) => mockConfigState.config[key],
    update: (updates: Record<string, unknown>) => {
      mockConfigState.config = { ...mockConfigState.config, ...updates };
    },
    set: (key: string, value: unknown) => {
      mockConfigState.config = { ...mockConfigState.config, [key]: value };
    },
  },
  PROVIDER_PRESETS: {},
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import type { MemoryService } from '../../main/memory/memory-service';
import { MemoryExtension } from '../../main/memory/memory-extension';
import { AgentRuntimeExtensionManager } from '../../main/extensions/agent-runtime-extension-manager';
import type { AgentRuntimeExtension } from '../../main/extensions/agent-runtime-extension';

function makeFakeService(overrides?: Partial<Record<string, unknown>>) {
  return {
    isEnabled: () => true,
    buildCorePromptPrefix: () =>
      '<memory_context>\n<core_memory>name=Jack</core_memory>\n</memory_context>',
    buildPromptPrefix: vi.fn(async () => 'FULL_BLOCKING_PREFIX'),
    acquireExperience: vi.fn(() => Promise.resolve('EXPERIENCE_BLOCK')),
    enqueueIngestion: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    ...overrides,
  } as unknown as MemoryService & Record<string, ReturnType<typeof vi.fn>>;
}

function makeSession(memoryEnabled = true) {
  return {
    id: 'session-a',
    title: 'test',
    status: 'idle' as const,
    cwd: '/repo/a',
    mountedPaths: [],
    allowedTools: [],
    memoryEnabled,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

const baseContext = {
  prompt: 'hello memory',
  existingMessages: [],
  isColdStart: false,
};

describe('MemoryExtension non-blocking retrieval', () => {
  beforeEach(() => {
    mockConfigState.config = {
      memoryEnabled: true,
      memoryRuntime: { retrievalMode: 'background', retrievalTimeoutMs: 8000 },
    };
  });

  it('background mode: beforeSessionRun resolves immediately with core prefix while experience retrieval is still pending', async () => {
    let resolveExperience!: (value: string) => void;
    const hanging = new Promise<string>((res) => {
      resolveExperience = res;
    });
    const service = makeFakeService({ acquireExperience: vi.fn(() => hanging) });
    const extension = new MemoryExtension(service);

    const started = Date.now();
    const result = await extension.beforeSessionRun({
      session: makeSession(),
      ...baseContext,
    } as never);
    expect(Date.now() - started).toBeLessThan(50);

    expect(result?.promptPrefix).toContain('<core_memory>');
    expect(result?.promptPrefix).not.toContain('EXPERIENCE_BLOCK');
    expect(result?.deferredExperience).toBeInstanceOf(Promise);

    resolveExperience('LATE_EXPERIENCE');
    await expect(result?.deferredExperience).resolves.toBe('LATE_EXPERIENCE');
  });

  it('background mode: deferredExperience swallows retrieval failures and resolves empty', async () => {
    const service = makeFakeService({
      acquireExperience: vi.fn(() => Promise.reject(new Error('llm down'))),
    });
    const extension = new MemoryExtension(service);

    const result = await extension.beforeSessionRun({
      session: makeSession(),
      ...baseContext,
    } as never);
    await expect(result?.deferredExperience).resolves.toBe('');
  });

  it('blocking mode: awaits the full prefix and returns no deferredExperience', async () => {
    mockConfigState.config.memoryRuntime = { retrievalMode: 'blocking', retrievalTimeoutMs: 8000 };
    const service = makeFakeService();
    const extension = new MemoryExtension(service);

    const result = await extension.beforeSessionRun({
      session: makeSession(),
      ...baseContext,
    } as never);
    expect(result?.promptPrefix).toBe('FULL_BLOCKING_PREFIX');
    expect(result?.deferredExperience).toBeUndefined();
    expect(service.buildPromptPrefix).toHaveBeenCalledTimes(1);
  });

  it('returns undefined when session memory is disabled', async () => {
    const service = makeFakeService();
    const extension = new MemoryExtension(service);
    const result = await extension.beforeSessionRun({
      session: makeSession(false),
      ...baseContext,
    } as never);
    expect(result).toBeUndefined();
  });
});

describe('AgentRuntimeExtensionManager deferredExperience merging', () => {
  it('does not await deferredExperience and merges parts from multiple extensions', async () => {
    let resolveA!: (value: string) => void;
    const hangingA = new Promise<string>((res) => {
      resolveA = res;
    });
    const extensionA: AgentRuntimeExtension = {
      name: 'a',
      beforeSessionRun: async () => ({
        promptPrefix: 'PREFIX_A',
        deferredExperience: hangingA,
      }),
    };
    const extensionB: AgentRuntimeExtension = {
      name: 'b',
      beforeSessionRun: async () => ({
        promptPrefix: 'PREFIX_B',
        deferredExperience: Promise.resolve('EXPERIENCE_B'),
      }),
    };
    const manager = new AgentRuntimeExtensionManager([extensionA, extensionB]);

    const started = Date.now();
    const result = await manager.beforeSessionRun({
      session: makeSession(),
      ...baseContext,
    } as never);
    expect(Date.now() - started).toBeLessThan(50);

    expect(result.promptPrefix).toBe('PREFIX_A\n\nPREFIX_B');
    expect(result.deferredExperience).toBeInstanceOf(Promise);

    resolveA('EXPERIENCE_A');
    await expect(result.deferredExperience).resolves.toBe('EXPERIENCE_A\n\nEXPERIENCE_B');
  });

  it('filters empty deferred parts and returns undefined when no extension defers', async () => {
    const manager = new AgentRuntimeExtensionManager([
      {
        name: 'plain',
        beforeSessionRun: async () => ({ promptPrefix: 'ONLY' }),
      },
    ]);
    const result = await manager.beforeSessionRun({
      session: makeSession(),
      ...baseContext,
    } as never);
    expect(result.promptPrefix).toBe('ONLY');
    expect(result.deferredExperience).toBeUndefined();

    const managerWithEmpty = new AgentRuntimeExtensionManager([
      {
        name: 'empty-defer',
        beforeSessionRun: async () => ({ deferredExperience: Promise.resolve('   ') }),
      },
    ]);
    const result2 = await managerWithEmpty.beforeSessionRun({
      session: makeSession(),
      ...baseContext,
    } as never);
    await expect(result2.deferredExperience).resolves.toBe('');
  });
});
