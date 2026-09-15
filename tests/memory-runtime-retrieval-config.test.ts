import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  seed: {} as Record<string, unknown>,
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-config-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = {
        ...(options?.defaults || {}),
        ...mocks.seed,
      };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = {
        ...this.store,
        ...key,
      };
    }

    clear(): void {
      this.store = {};
    }
  }

  return {
    default: MockStore,
  };
});

import { ConfigStore } from '../src/main/config/config-store';

describe('ConfigStore memory retrieval settings', () => {
  beforeEach(() => {
    mocks.seed = {};
  });

  it('defaults to background retrieval mode with an 8s injection timeout', () => {
    const store = new ConfigStore();
    const runtime = store.get('memoryRuntime');
    expect(runtime.retrievalMode).toBe('background');
    expect(runtime.retrievalTimeoutMs).toBe(8000);
  });

  it('normalizes seeded memoryRuntime with missing retrieval fields to defaults', () => {
    mocks.seed = {
      memoryRuntime: {
        useEmbedding: false,
        maxNavSteps: 2,
        ingestionConcurrency: 2,
      },
    };
    const store = new ConfigStore();
    const runtime = store.get('memoryRuntime');
    expect(runtime.retrievalMode).toBe('background');
    expect(runtime.retrievalTimeoutMs).toBe(8000);
  });

  it('keeps a valid blocking mode set through update()', () => {
    const store = new ConfigStore();
    store.update({
      memoryRuntime: {
        ...store.get('memoryRuntime'),
        retrievalMode: 'blocking',
        retrievalTimeoutMs: 15000,
      },
    });
    const runtime = store.get('memoryRuntime');
    expect(runtime.retrievalMode).toBe('blocking');
    expect(runtime.retrievalTimeoutMs).toBe(15000);
  });

  it('falls back to background for invalid retrievalMode values', () => {
    const store = new ConfigStore();
    store.update({
      memoryRuntime: {
        ...store.get('memoryRuntime'),
        retrievalMode: 'turbo' as never,
      },
    });
    expect(store.get('memoryRuntime').retrievalMode).toBe('background');
  });

  it('clamps retrievalTimeoutMs into the supported range', () => {
    const store = new ConfigStore();
    store.update({
      memoryRuntime: { ...store.get('memoryRuntime'), retrievalTimeoutMs: 10 },
    });
    expect(store.get('memoryRuntime').retrievalTimeoutMs).toBe(1000);

    store.update({
      memoryRuntime: { ...store.get('memoryRuntime'), retrievalTimeoutMs: 999999 },
    });
    expect(store.get('memoryRuntime').retrievalTimeoutMs).toBe(60000);

    store.update({
      memoryRuntime: { ...store.get('memoryRuntime'), retrievalTimeoutMs: 'fast' as never },
    });
    expect(store.get('memoryRuntime').retrievalTimeoutMs).toBe(8000);
  });
});
