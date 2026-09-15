import { logWarn as defaultLogWarn } from '../utils/logger';

export type DeferredMemoryInjectionOutcome =
  | 'injected'
  | 'skipped'
  | 'timeout'
  | 'cancelled'
  | 'empty'
  | 'error';

export interface DeferredMemoryInjectorDeps {
  /** Deliver text into the running turn via pi's steering channel. */
  sendSteer: (text: string) => Promise<void> | void;
  /** Whether the current turn is still streaming/executing tools. */
  isTurnActive: () => boolean;
  /** Budget for the retrieval; after this we give up injecting for this turn. */
  timeoutMs: number;
  /** Called after a successful injection (e.g. to emit a trace step). */
  onInjected?: () => void;
  logWarn?: (message: string, error?: unknown) => void;
}

export interface DeferredMemoryInjectionHandle {
  cancel: () => void;
  done: Promise<DeferredMemoryInjectionOutcome>;
}

/**
 * Injects asynchronously retrieved memory context into the running turn via
 * the steering channel, so experience retrieval never blocks the first token.
 * The deferred promise keeps running after a timeout/cancel — its result is
 * cached upstream (MemoryRetrievalCoordinator) and benefits the next turn.
 */
export function attachDeferredMemoryInjection(
  deferred: Promise<string> | undefined,
  deps: DeferredMemoryInjectorDeps
): DeferredMemoryInjectionHandle {
  const warn = deps.logWarn ?? defaultLogWarn;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (!deferred) {
    return { cancel: () => {}, done: Promise.resolve('skipped') };
  }

  const done = new Promise<DeferredMemoryInjectionOutcome>((resolve) => {
    const timeout = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => res('timeout'), deps.timeoutMs);
    });

    Promise.race([deferred.then((value) => ({ value })), timeout])
      .then(async (result): Promise<void> => {
        if (result === 'timeout') {
          resolve('timeout');
          return;
        }
        if (cancelled) {
          resolve('cancelled');
          return;
        }
        const text = result.value?.trim();
        if (!text) {
          resolve('empty');
          return;
        }
        if (!deps.isTurnActive()) {
          resolve('skipped');
          return;
        }
        try {
          await deps.sendSteer(text);
          deps.onInjected?.();
          resolve('injected');
        } catch (error) {
          warn('[DeferredMemoryInjector] steer injection failed:', error);
          resolve('error');
        }
      })
      .catch((error) => {
        warn('[DeferredMemoryInjector] deferred retrieval failed:', error);
        resolve('error');
      })
      .finally(() => {
        if (timer) {
          clearTimeout(timer);
        }
      });
  });

  return {
    cancel: () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
    done,
  };
}
