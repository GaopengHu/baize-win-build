import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TraceWriteBatcher } from '../../main/db/trace-write-batcher';

describe('TraceWriteBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not execute enqueued writes immediately', () => {
    const batcher = new TraceWriteBatcher();
    const op = vi.fn();
    batcher.enqueue(op);
    expect(op).not.toHaveBeenCalled();
    expect(batcher.pending).toBe(1);
    batcher.dispose();
  });

  it('flushes automatically after the interval and keeps write order', () => {
    const batcher = new TraceWriteBatcher({ flushIntervalMs: 200 });
    const order: string[] = [];
    batcher.enqueue(() => order.push('a'));
    batcher.enqueue(() => order.push('b'));
    batcher.enqueue(() => order.push('c'));

    vi.advanceTimersByTime(199);
    expect(order).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(batcher.pending).toBe(0);
    batcher.dispose();
  });

  it('flushes immediately when maxPending is reached', () => {
    const batcher = new TraceWriteBatcher({ flushIntervalMs: 5000, maxPending: 3 });
    const order: string[] = [];
    batcher.enqueue(() => order.push('a'));
    batcher.enqueue(() => order.push('b'));
    expect(order).toEqual([]);
    batcher.enqueue(() => order.push('c'));
    expect(order).toEqual(['a', 'b', 'c']);
    batcher.dispose();
  });

  it('manual flush runs pending writes once and cancels the scheduled flush', () => {
    const batcher = new TraceWriteBatcher({ flushIntervalMs: 200 });
    const op = vi.fn();
    batcher.enqueue(op);
    batcher.flush();
    expect(op).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    expect(op).toHaveBeenCalledTimes(1);
    batcher.dispose();
  });

  it('isolates failing writes: later ops still run and onError is notified', () => {
    const onError = vi.fn();
    const batcher = new TraceWriteBatcher({ flushIntervalMs: 200, onError });
    const order: string[] = [];
    batcher.enqueue(() => {
      throw new Error('db locked');
    });
    batcher.enqueue(() => order.push('second'));

    batcher.flush();
    expect(order).toEqual(['second']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    batcher.dispose();
  });

  it('dispose flushes pending writes', () => {
    const batcher = new TraceWriteBatcher({ flushIntervalMs: 60_000 });
    const op = vi.fn();
    batcher.enqueue(op);
    batcher.dispose();
    expect(op).toHaveBeenCalledTimes(1);
    expect(batcher.pending).toBe(0);
  });

  it('schedules a new timer for writes arriving after a flush', () => {
    const batcher = new TraceWriteBatcher({ flushIntervalMs: 200 });
    const first = vi.fn();
    const second = vi.fn();
    batcher.enqueue(first);
    vi.advanceTimersByTime(200);
    expect(first).toHaveBeenCalledTimes(1);

    batcher.enqueue(second);
    vi.advanceTimersByTime(199);
    expect(second).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(second).toHaveBeenCalledTimes(1);
    batcher.dispose();
  });
});
