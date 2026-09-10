export interface TraceWriteBatcherOptions {
  /** Delay before pending writes are flushed (default 200ms). */
  flushIntervalMs?: number;
  /** Flush immediately once this many writes are queued (default 20). */
  maxPending?: number;
  /** Called when a queued write throws; defaults to a no-op. */
  onError?: (error: unknown) => void;
}

/**
 * Batches synchronous SQLite trace writes off the event-forwarding hot path.
 * Events reach the renderer immediately; persistence happens on a short timer
 * or when the queue fills, and callers must flush() at turn end / shutdown so
 * nothing is lost.
 */
export class TraceWriteBatcher {
  private readonly flushIntervalMs: number;
  private readonly maxPending: number;
  private readonly onError: (error: unknown) => void;
  private queue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TraceWriteBatcherOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 200;
    this.maxPending = options.maxPending ?? 20;
    this.onError = options.onError ?? (() => {});
  }

  get pending(): number {
    return this.queue.length;
  }

  enqueue(op: () => void): void {
    this.queue.push(op);
    if (this.queue.length >= this.maxPending) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushIntervalMs);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.length) {
      return;
    }
    const ops = this.queue;
    this.queue = [];
    for (const op of ops) {
      try {
        op();
      } catch (error) {
        this.onError(error);
      }
    }
  }

  dispose(): void {
    this.flush();
  }
}
