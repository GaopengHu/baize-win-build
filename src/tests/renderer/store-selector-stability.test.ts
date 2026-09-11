/**
 * Regression tests for React error #185 ("Maximum update depth exceeded")
 * caused by unstable zustand selector snapshots.
 *
 * Reproduced live against the packaged renderer: opening a history session
 * whose state was not cached yet blanked the chat area, because
 * `PanelErrorBoundary` caught #185 thrown from ChatView. Re-opening the same
 * session rendered fine — by then `sessionStates[id].messages` existed, so the
 * selector returned the stored (stable) array.
 *
 * Mechanism: zustand v5 subscribes via React's `useSyncExternalStore`, whose
 * passive effect re-reads the snapshot after every commit and forces a
 * re-render when `Object.is(prev, next)` is false. A selector falling back to a
 * fresh `[]` literal never satisfies that check, so render -> effect -> render
 * spins until React aborts with #185.
 *
 * The fix is that every empty fallback is a shared module-level constant, so
 * repeated reads are reference-identical. These tests pin that contract.
 */
import { describe, it, expect } from 'vitest';
import {
  selectActiveMessages,
  selectActivePendingTurns,
  selectActiveTraceSteps,
  selectSessionMessages,
  type SelectorState,
} from '../../renderer/store/selectors';
import type { Message, TraceStep } from '../../renderer/types';

const noSession: SelectorState = { activeSessionId: null, sessionStates: {} };

const unknownSession: SelectorState = {
  activeSessionId: 'not-loaded-yet',
  sessionStates: {},
};

const makeMessage = (id: string, sessionId: string): Message => ({
  id,
  sessionId,
  role: 'user',
  content: [{ type: 'text', text: id }],
  timestamp: 1,
});

describe('selector snapshot stability (React #185 guard)', () => {
  it('returns the identical empty array when no session is active', () => {
    expect(selectActiveMessages(noSession)).toBe(selectActiveMessages(noSession));
    expect(selectActivePendingTurns(noSession)).toBe(selectActivePendingTurns(noSession));
    expect(selectActiveTraceSteps(noSession)).toBe(selectActiveTraceSteps(noSession));
  });

  it('returns the identical empty array for a session that is not cached yet', () => {
    // This is the exact state ChatView sees right after handleSessionClick
    // switches activeSessionId, before the paginated IPC call resolves.
    expect(selectActiveMessages(unknownSession)).toBe(selectActiveMessages(unknownSession));
    expect(selectActiveMessages(unknownSession)).toBe(selectActiveMessages(noSession));
    expect(selectActivePendingTurns(unknownSession)).toBe(selectActivePendingTurns(unknownSession));
    expect(selectActiveTraceSteps(unknownSession)).toBe(selectActiveTraceSteps(unknownSession));
  });

  it('returns the identical empty array for an unknown session id', () => {
    expect(selectSessionMessages(unknownSession, 'missing')).toBe(
      selectSessionMessages(unknownSession, 'missing')
    );
    expect(selectSessionMessages(unknownSession, 'missing')).toBe(selectActiveMessages(noSession));
  });

  it('returns the stored array reference once the session is loaded', () => {
    const messages = [makeMessage('m1', 's1')];
    const loaded: SelectorState = {
      activeSessionId: 's1',
      sessionStates: {
        s1: { messages } as unknown as SelectorState['sessionStates'][string],
      },
    };

    expect(selectActiveMessages(loaded)).toBe(messages);
    expect(selectSessionMessages(loaded, 's1')).toBe(messages);
    // Repeated reads stay stable — no new array per call.
    expect(selectActiveMessages(loaded)).toBe(selectActiveMessages(loaded));
  });

  it('exposes empty fallbacks that are safe to read but never mutated', () => {
    const traceSteps = selectActiveTraceSteps(unknownSession) as TraceStep[];
    expect(traceSteps).toHaveLength(0);
    expect(selectActivePendingTurns(unknownSession)).toHaveLength(0);
  });
});
