import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseInstance } from '../src/main/db/database';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getVersion: () => '0.0.0',
  },
}));

vi.mock('electron-store', () => {
  class MockStore<T extends Record<string, unknown>> {
    public store: Record<string, unknown>;
    public path = '/tmp/mock-session-manager-trace-batching-store.json';

    constructor(options: { defaults?: Record<string, unknown> }) {
      this.store = { ...(options?.defaults || {}) };
    }

    get<K extends keyof T>(key: K): T[K] {
      return this.store[key as string] as T[K];
    }

    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.store[key] = value;
        return;
      }
      this.store = { ...this.store, ...key };
    }
  }
  return { default: MockStore };
});

vi.mock('../src/main/claude/agent-runner', () => ({
  ClaudeAgentRunner: class {
    run = vi.fn();
    cancel = vi.fn();
    handleQuestionResponse = vi.fn();
  },
}));

vi.mock('../src/main/mcp/mcp-config-store', () => ({
  mcpConfigStore: {
    getEnabledServers: () => [],
  },
}));

import { SessionManager } from '../src/main/session/session-manager';
import type { ServerEvent, TraceStep } from '../src/renderer/types';

function makeDb(overrides: Partial<DatabaseInstance> = {}): DatabaseInstance {
  return {
    sessions: {
      create: vi.fn(),
      get: vi.fn(() => null),
      getAll: vi.fn(() => []),
      update: vi.fn(),
      delete: vi.fn(),
    },
    messages: {
      create: vi.fn(),
      getBySessionId: vi.fn(() => []),
      delete: vi.fn(),
      deleteBySessionId: vi.fn(),
    },
    traceSteps: {
      create: vi.fn(),
      update: vi.fn(),
      getBySessionId: vi.fn(() => []),
      deleteBySessionId: vi.fn(),
    },
    ...overrides,
  } as unknown as DatabaseInstance;
}

function makeStep(id: string, title: string): TraceStep {
  return {
    id,
    type: 'tool_call',
    status: 'running',
    title,
    timestamp: Date.now(),
  };
}

describe('SessionManager trace write batching', () => {
  let events: ServerEvent[];
  let db: DatabaseInstance;
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
    db = makeDb();
    manager = new SessionManager(db, (event) => events.push(event));
  });

  afterEach(() => {
    manager.flushTraceWrites();
    vi.useRealTimers();
  });

  function emitTraceStep(sessionId: string, step: TraceStep): void {
    // The wrapper is installed on the private sendToRenderer; drive it through
    // the same path agent events use — the manager's own emit helper.
    (manager as unknown as { sendToRenderer: (e: ServerEvent) => void }).sendToRenderer({
      type: 'trace.step',
      payload: { sessionId, step },
    });
  }

  function emitTraceUpdate(sessionId: string, stepId: string, updates: Partial<TraceStep>): void {
    (manager as unknown as { sendToRenderer: (e: ServerEvent) => void }).sendToRenderer({
      type: 'trace.update',
      payload: { sessionId, stepId, updates },
    });
  }

  it('forwards trace.step to the renderer immediately without writing the DB', () => {
    emitTraceStep('s1', makeStep('step-1', 'Calling tool'));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('trace.step');
    expect(db.traceSteps.create).not.toHaveBeenCalled();
  });

  it('persists the trace step on the batch flush with the mapped row', () => {
    const step = makeStep('step-1', 'Calling tool');
    emitTraceStep('s1', step);

    vi.advanceTimersByTime(200);

    expect(db.traceSteps.create).toHaveBeenCalledTimes(1);
    const row = (db.traceSteps.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(row.id).toBe('step-1');
    expect(row.session_id).toBe('s1');
    expect(row.title).toBe('Calling tool');
  });

  it('batches trace.update the same way', () => {
    emitTraceUpdate('s1', 'step-1', { status: 'completed', duration: 42 });
    expect(db.traceSteps.update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(db.traceSteps.update).toHaveBeenCalledWith('step-1', {
      status: 'completed',
      duration: 42,
    });
  });

  it('preserves write order across mixed step/update events', () => {
    const order: string[] = [];
    (db.traceSteps.create as ReturnType<typeof vi.fn>).mockImplementation((row) => {
      order.push(`create:${row.id}`);
    });
    (db.traceSteps.update as ReturnType<typeof vi.fn>).mockImplementation((id) => {
      order.push(`update:${id}`);
    });

    emitTraceStep('s1', makeStep('a', 'A'));
    emitTraceUpdate('s1', 'a', { status: 'completed' });
    emitTraceStep('s1', makeStep('b', 'B'));

    manager.flushTraceWrites();
    expect(order).toEqual(['create:a', 'update:a', 'create:b']);
  });

  it('flushTraceWrites persists pending writes on demand', () => {
    emitTraceStep('s1', makeStep('step-1', 'Calling tool'));
    manager.flushTraceWrites();
    expect(db.traceSteps.create).toHaveBeenCalledTimes(1);

    // A second flush must not double-write.
    manager.flushTraceWrites();
    expect(db.traceSteps.create).toHaveBeenCalledTimes(1);
  });

  it('deleteSession flushes pending trace writes before deleting the session', async () => {
    const order: string[] = [];
    (db.traceSteps.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('trace-create');
    });
    (db.sessions.delete as ReturnType<typeof vi.fn>).mockImplementation(() => {
      order.push('session-delete');
    });

    emitTraceStep('s1', makeStep('step-1', 'Calling tool'));
    await manager.deleteSession('s1');

    expect(order).toEqual(['trace-create', 'session-delete']);
  });

  it('a failing trace write does not break event forwarding or later writes', () => {
    (db.traceSteps.create as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => {
        throw new Error('db locked');
      })
      .mockImplementation(() => {});

    emitTraceStep('s1', makeStep('bad', 'Bad'));
    emitTraceStep('s1', makeStep('good', 'Good'));

    expect(() => manager.flushTraceWrites()).not.toThrow();
    expect(db.traceSteps.create).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(2);
  });
});
