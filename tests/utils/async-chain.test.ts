import { describe, expect, it } from 'vitest';
import { AsyncChain } from '../../src/main/utils/async-chain';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('AsyncChain', () => {
  it('serializes tasks with the same key (no overlap)', async () => {
    const chain = new AsyncChain<string>();
    const events: string[] = [];

    const p1 = chain.enqueue('a', async () => {
      events.push('start-1');
      await delay(20);
      events.push('end-1');
    });
    const p2 = chain.enqueue('a', async () => {
      events.push('start-2');
      await delay(5);
      events.push('end-2');
    });

    await Promise.all([p1, p2]);
    expect(events).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('runs tasks with different keys concurrently', async () => {
    const chain = new AsyncChain<string>();
    const events: string[] = [];

    const p1 = chain.enqueue('a', async () => {
      events.push('start-a');
      await delay(30);
      events.push('end-a');
    });
    const p2 = chain.enqueue('b', async () => {
      events.push('start-b');
      await delay(5);
      events.push('end-b');
    });

    await Promise.all([p1, p2]);
    // b 应先完成（并发执行，而不是排在 a 后面）
    expect(events.indexOf('end-b')).toBeLessThan(events.indexOf('end-a'));
  });

  it('isolates errors: a failed task does not block subsequent tasks', async () => {
    const chain = new AsyncChain<string>();

    const p1 = chain.enqueue('a', async () => {
      throw new Error('boom');
    });
    const p2 = chain.enqueue('a', async () => 'ok');

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  it('propagates the task result and type to the caller', async () => {
    const chain = new AsyncChain<number>();
    const result = await chain.enqueue(1, async () => ({ value: 42 }));
    expect(result).toEqual({ value: 42 });
  });

  it('auto-cleans the map entry when the chain drains', async () => {
    const chain = new AsyncChain<string>();
    await chain.enqueue('a', async () => undefined);
    // finally 回调在微任务中执行，等待一轮事件循环
    await delay(0);
    expect(chain.has('a')).toBe(false);
  });

  it('keeps the map entry while tasks are pending', async () => {
    const chain = new AsyncChain<string>();
    const p = chain.enqueue('a', async () => {
      await delay(20);
    });
    expect(chain.has('a')).toBe(true);
    await p;
    await delay(0);
    expect(chain.has('a')).toBe(false);
  });
});
