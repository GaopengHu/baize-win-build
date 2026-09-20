/**
 * AsyncChain<K> — 按 key 串行的异步任务队列（通用并发原语）。
 *
 * 定位（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.2 / §零 R2）：
 * 这是"纵深防御护栏"，不是修 bug——上游 session-manager 的 promptQueues
 * 已按 session 串行 prompt；AsyncChain 防的是未来调用方变化导致同一 key
 * 并发进入关键区（如 Phase 5 的 PiSessionFactory.resolveOrCreate）。
 *
 * 特性：
 * 1. 串行：同 key 的 task 按 enqueue 顺序依次执行，不重叠；
 * 2. 错误隔离：前一个 task 失败不会阻断后续 task；
 * 3. 自动清理：链上无待执行任务时删除 Map 条目，避免内存泄漏。
 */
export class AsyncChain<K> {
  private readonly chains = new Map<K, Promise<unknown>>();

  enqueue<T>(key: K, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    // 注意：Map 里存的是 tracked（finally 包装后的 promise），清理比较也必须
    // 对照 tracked——原 MemoryIngestionQueue 实现比较的是未包装的 next，导致
    // 条目永远删不掉（静默内存泄漏）。此处修正，行为契约（串行/错误隔离）不变。
    const tracked: Promise<unknown> = next.finally(() => {
      if (this.chains.get(key) === tracked) {
        this.chains.delete(key);
      }
    });
    this.chains.set(key, tracked);
    return next;
  }

  /** 当前是否有排队中/执行中的任务（测试与诊断用）。 */
  has(key: K): boolean {
    return this.chains.has(key);
  }
}
