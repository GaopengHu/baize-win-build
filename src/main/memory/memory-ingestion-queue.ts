import { AsyncChain } from '../utils/async-chain';

/**
 * 记忆摄入队列：按 sessionId 串行执行 ingest 任务。
 * 薄包装 AsyncChain<string>（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.2）。
 */
export class MemoryIngestionQueue {
  private readonly chain = new AsyncChain<string>();

  enqueue(key: string, task: () => Promise<void>): Promise<void> {
    return this.chain.enqueue(key, task);
  }
}
