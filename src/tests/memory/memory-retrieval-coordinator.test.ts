import { describe, expect, it, vi } from 'vitest';
import { MemoryRetrievalCoordinator } from '../../main/memory/memory-retrieval-coordinator';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createCoordinator(options?: {
  ttlMs?: number;
  maxEntries?: number;
  retrieveImpl?: (sessionId: string, prompt: string) => Promise<string>;
}) {
  let currentTime = 1_000;
  const calls: Array<{ sessionId: string; prompt: string }> = [];
  const pending = new Map<string, Deferred<string>>();
  const retrieve =
    options?.retrieveImpl ??
    vi.fn((sessionId: string, prompt: string) => {
      calls.push({ sessionId, prompt });
      const deferred = createDeferred<string>();
      pending.set(`${sessionId}\u0000${prompt}\u0000${calls.length - 1}`, deferred);
      return deferred.promise;
    });
  const coordinator = new MemoryRetrievalCoordinator({
    retrieve,
    ttlMs: options?.ttlMs ?? 60_000,
    maxEntries: options?.maxEntries ?? 20,
    now: () => currentTime,
  });
  return {
    coordinator,
    retrieve,
    calls,
    pending,
    advance(ms: number) {
      currentTime += ms;
    },
    resolveCall(index: number, value: string) {
      const key = Array.from(pending.keys())[index];
      pending.get(key)?.resolve(value);
    },
    rejectCall(index: number, error: unknown) {
      const key = Array.from(pending.keys())[index];
      pending.get(key)?.reject(error);
    },
  };
}

describe('MemoryRetrievalCoordinator', () => {
  it('acquire starts retrieval and resolves with its result', async () => {
    const ctx = createCoordinator({ retrieveImpl: async () => 'memory-context' });
    await expect(ctx.coordinator.acquire('s1', 'hello')).resolves.toBe('memory-context');
  });

  it('reuses cached result within TTL without re-retrieving', async () => {
    const retrieve = vi.fn(async () => 'cached');
    const ctx = createCoordinator({ retrieveImpl: retrieve });
    await ctx.coordinator.acquire('s1', 'hello');
    await expect(ctx.coordinator.acquire('s1', 'hello')).resolves.toBe('cached');
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('restarts retrieval after TTL expiry', async () => {
    let round = 0;
    const retrieve = vi.fn(async () => `result-${(round += 1)}`);
    const ctx = createCoordinator({ retrieveImpl: retrieve, ttlMs: 60_000 });
    await expect(ctx.coordinator.acquire('s1', 'hello')).resolves.toBe('result-1');
    ctx.advance(60_001);
    await expect(ctx.coordinator.acquire('s1', 'hello')).resolves.toBe('result-2');
    expect(retrieve).toHaveBeenCalledTimes(2);
  });

  it('prefetch populates cache so later acquire reuses the in-flight promise', async () => {
    const retrieve = vi.fn(async () => 'prefetched');
    const ctx = createCoordinator({ retrieveImpl: retrieve });
    ctx.coordinator.prefetch('s1', 'draft text');
    await expect(ctx.coordinator.acquire('s1', 'draft text')).resolves.toBe('prefetched');
    expect(retrieve).toHaveBeenCalledTimes(1);
  });

  it('prefetch dedupes repeated calls for the same in-flight prompt', () => {
    const ctx = createCoordinator();
    ctx.coordinator.prefetch('s1', 'draft');
    ctx.coordinator.prefetch('s1', 'draft');
    ctx.coordinator.prefetch('s1', 'draft');
    expect(ctx.calls).toHaveLength(1);
  });

  it('concurrent acquire calls share a single in-flight retrieval', async () => {
    const ctx = createCoordinator();
    const first = ctx.coordinator.acquire('s1', 'hello');
    const second = ctx.coordinator.acquire('s1', 'hello');
    expect(ctx.calls).toHaveLength(1);
    ctx.resolveCall(0, 'shared');
    await expect(first).resolves.toBe('shared');
    await expect(second).resolves.toBe('shared');
  });

  it('does not cache failed retrievals; next acquire retries', async () => {
    const ctx = createCoordinator();
    const failing = ctx.coordinator.acquire('s1', 'hello');
    ctx.rejectCall(0, new Error('llm down'));
    await expect(failing).rejects.toThrow('llm down');

    const retry = ctx.coordinator.acquire('s1', 'hello');
    expect(ctx.calls).toHaveLength(2);
    ctx.resolveCall(1, 'recovered');
    await expect(retry).resolves.toBe('recovered');
  });

  it('prefetch failures are swallowed and not cached', async () => {
    const ctx = createCoordinator();
    ctx.coordinator.prefetch('s1', 'hello');
    ctx.rejectCall(0, new Error('llm down'));
    await vi.waitFor(() => expect(ctx.calls).toHaveLength(1));

    const retry = ctx.coordinator.acquire('s1', 'hello');
    expect(ctx.calls).toHaveLength(2);
    ctx.resolveCall(1, 'ok');
    await expect(retry).resolves.toBe('ok');
  });

  it('evicts oldest entries beyond maxEntries', async () => {
    const retrieve = vi.fn(async (_sessionId: string, prompt: string) => `ctx:${prompt}`);
    const ctx = createCoordinator({ retrieveImpl: retrieve, maxEntries: 2 });
    await ctx.coordinator.acquire('s1', 'a');
    await ctx.coordinator.acquire('s1', 'b');
    await ctx.coordinator.acquire('s1', 'c');
    // 'a' was evicted -> retrieving it again calls retrieve
    await ctx.coordinator.acquire('s1', 'a');
    expect(retrieve).toHaveBeenCalledTimes(4);
    // 'c' still cached
    await ctx.coordinator.acquire('s1', 'c');
    expect(retrieve).toHaveBeenCalledTimes(4);
  });

  it('clearSession drops cached entries for that session only', async () => {
    const retrieve = vi.fn(async () => 'x');
    const ctx = createCoordinator({ retrieveImpl: retrieve });
    await ctx.coordinator.acquire('s1', 'hello');
    await ctx.coordinator.acquire('s2', 'hello');
    ctx.coordinator.clearSession('s1');
    await ctx.coordinator.acquire('s1', 'hello');
    await ctx.coordinator.acquire('s2', 'hello');
    // s1 re-retrieved (2 total for s1), s2 still cached (1 total)
    expect(retrieve).toHaveBeenCalledTimes(3);
  });

  it('treats blank prompts as no-op returning empty string', async () => {
    const retrieve = vi.fn(async () => 'x');
    const ctx = createCoordinator({ retrieveImpl: retrieve });
    await expect(ctx.coordinator.acquire('s1', '   ')).resolves.toBe('');
    ctx.coordinator.prefetch('s1', '');
    expect(retrieve).not.toHaveBeenCalled();
  });
});
