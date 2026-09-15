import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachDeferredMemoryInjection } from '../../main/claude/deferred-memory-injector';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('attachDeferredMemoryInjection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('injects via steer when retrieval resolves while the turn is still active', async () => {
    const deferred = createDeferred<string>();
    const sendSteer = vi.fn();
    const onInjected = vi.fn();
    const handle = attachDeferredMemoryInjection(deferred.promise, {
      sendSteer,
      isTurnActive: () => true,
      timeoutMs: 8000,
      onInjected,
    });

    deferred.resolve('MEMORY_BLOCK');
    await vi.advanceTimersByTimeAsync(0);
    await handle.done;

    expect(sendSteer).toHaveBeenCalledTimes(1);
    expect(sendSteer.mock.calls[0][0]).toContain('MEMORY_BLOCK');
    expect(onInjected).toHaveBeenCalledTimes(1);
    expect(await handle.done).toBe('injected');
  });

  it('skips injection when the turn already ended', async () => {
    const deferred = createDeferred<string>();
    const sendSteer = vi.fn();
    const handle = attachDeferredMemoryInjection(deferred.promise, {
      sendSteer,
      isTurnActive: () => false,
      timeoutMs: 8000,
    });

    deferred.resolve('MEMORY_BLOCK');
    await expect(handle.done).resolves.toBe('skipped');
    expect(sendSteer).not.toHaveBeenCalled();
  });

  it('skips injection when retrieval exceeds the timeout budget', async () => {
    const deferred = createDeferred<string>();
    const sendSteer = vi.fn();
    const handle = attachDeferredMemoryInjection(deferred.promise, {
      sendSteer,
      isTurnActive: () => true,
      timeoutMs: 8000,
    });

    await vi.advanceTimersByTimeAsync(8001);
    await expect(handle.done).resolves.toBe('timeout');

    // Late resolution after timeout must not inject.
    deferred.resolve('TOO_LATE');
    await vi.advanceTimersByTimeAsync(0);
    expect(sendSteer).not.toHaveBeenCalled();
  });

  it('treats empty retrieval results as nothing to inject', async () => {
    const sendSteer = vi.fn();
    const handle = attachDeferredMemoryInjection(Promise.resolve('   '), {
      sendSteer,
      isTurnActive: () => true,
      timeoutMs: 8000,
    });
    await expect(handle.done).resolves.toBe('empty');
    expect(sendSteer).not.toHaveBeenCalled();
  });

  it('resolves skipped immediately when no deferred promise is provided', async () => {
    const sendSteer = vi.fn();
    const handle = attachDeferredMemoryInjection(undefined, {
      sendSteer,
      isTurnActive: () => true,
      timeoutMs: 8000,
    });
    await expect(handle.done).resolves.toBe('skipped');
    expect(sendSteer).not.toHaveBeenCalled();
  });

  it('survives a throwing sendSteer without crashing', async () => {
    const warn = vi.fn();
    const handle = attachDeferredMemoryInjection(Promise.resolve('MEMORY_BLOCK'), {
      sendSteer: () => {
        throw new Error('steer channel closed');
      },
      isTurnActive: () => true,
      timeoutMs: 8000,
      logWarn: warn,
    });
    await expect(handle.done).resolves.toBe('error');
    expect(warn).toHaveBeenCalled();
  });

  it('survives a rejecting deferred promise without unhandled rejection', async () => {
    const warn = vi.fn();
    const handle = attachDeferredMemoryInjection(Promise.reject(new Error('retrieval failed')), {
      sendSteer: vi.fn(),
      isTurnActive: () => true,
      timeoutMs: 8000,
      logWarn: warn,
    });
    await expect(handle.done).resolves.toBe('error');
    expect(warn).toHaveBeenCalled();
  });

  it('cancel() prevents any later injection', async () => {
    const deferred = createDeferred<string>();
    const sendSteer = vi.fn();
    const handle = attachDeferredMemoryInjection(deferred.promise, {
      sendSteer,
      isTurnActive: () => true,
      timeoutMs: 8000,
    });

    handle.cancel();
    deferred.resolve('MEMORY_BLOCK');
    await vi.advanceTimersByTimeAsync(0);
    await expect(handle.done).resolves.toBe('cancelled');
    expect(sendSteer).not.toHaveBeenCalled();
  });
});
