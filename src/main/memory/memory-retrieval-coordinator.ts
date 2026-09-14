import { logWarn } from '../utils/logger';

export interface MemoryRetrievalCoordinatorOptions {
  retrieve: (sessionId: string, prompt: string) => Promise<string>;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry {
  promise: Promise<string>;
  createdAt: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 20;

/**
 * Coordinates asynchronous experience-memory retrieval so it never blocks the
 * first token: prefetch warms the cache while the user types, acquire reuses
 * in-flight/cached results, and failures are evicted so the next call retries.
 */
export class MemoryRetrievalCoordinator {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly retrieve: (sessionId: string, prompt: string) => Promise<string>;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryRetrievalCoordinatorOptions) {
    this.retrieve = options.retrieve;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  prefetch(sessionId: string, prompt: string): void {
    if (!prompt.trim()) {
      return;
    }
    const key = this.buildKey(sessionId, prompt);
    if (this.getFreshEntry(key)) {
      return;
    }
    this.startRetrieval(key, sessionId, prompt).catch((error) => {
      logWarn('[MemoryRetrievalCoordinator] prefetch retrieval failed:', error);
    });
  }

  acquire(sessionId: string, prompt: string): Promise<string> {
    if (!prompt.trim()) {
      return Promise.resolve('');
    }
    const key = this.buildKey(sessionId, prompt);
    const fresh = this.getFreshEntry(key);
    if (fresh) {
      return fresh.promise;
    }
    return this.startRetrieval(key, sessionId, prompt);
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  private buildKey(sessionId: string, prompt: string): string {
    return `${sessionId}\u0000${prompt}`;
  }

  private getFreshEntry(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private startRetrieval(key: string, sessionId: string, prompt: string): Promise<string> {
    const promise = this.retrieve(sessionId, prompt);
    const entry: CacheEntry = { promise, createdAt: this.now() };
    this.entries.set(key, entry);
    this.evictOverflow();
    // Evict on failure so a later acquire retries instead of replaying the error.
    promise.catch(() => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key);
      }
    });
    return promise;
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.entries.delete(oldestKey);
    }
  }
}
