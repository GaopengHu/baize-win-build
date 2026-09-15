/**
 * Regression tests for truncated session history when scrolling up.
 *
 * Reproduced live: a 409-message session loaded only its newest 50, and
 * scrolling to the top three times produced zero further
 * `session.getMessagesPaginated` calls — the container had no scroll listener
 * at all.
 *
 * Root cause: ChatView's scroll effect returned early when the session had
 * just changed, skipping `addEventListener('scroll', ...)`. Its deps are
 * `[activeSessionId, hasMoreMessages]`, and `hasMoreMessages` defaults to
 * `true`, so a session with more than one page of history kept the same value
 * after loading — the effect never re-ran and the listener never came back.
 * Only the *initial* `updateScrollState()` call needed to be skipped (that was
 * the duplicate page-0 load the early return was protecting against).
 *
 * Also covered here: OFFSET pagination hands the renderer overlapping pages
 * when new messages land mid-flight, so `prependMessages` must dedupe by id —
 * duplicate ids become duplicate React keys and silently drop rounds.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useAppStore } from '../../renderer/store';
import type { Message } from '../../renderer/types';

const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const makeMessage = (id: string, sessionId = 's1', role: Message['role'] = 'user'): Message => ({
  id,
  sessionId,
  role,
  content: [{ type: 'text', text: id }],
  timestamp: Number(id.replace(/\D/g, '')) || 1,
});

describe('ChatView scroll pagination wiring (source guard)', () => {
  const source = read('src/renderer/components/ChatView.tsx');

  it('never returns early before attaching the scroll listener', () => {
    // The exact statement that orphaned every session with >1 page of history.
    expect(source).not.toMatch(/if \(sessionJustChanged\) return;/);
  });

  it('attaches the scroll listener unconditionally', () => {
    expect(source).toContain("container.addEventListener('scroll', onScroll");
    expect(source).toContain("return () => container.removeEventListener('scroll', onScroll)");
  });

  it('still skips the initial scroll check after a session switch', () => {
    // Guards against the duplicate page-0 load that the early return was added
    // for — the skip must stay, just not at the cost of the listener.
    expect(source).toContain('if (!sessionJustChanged) updateScrollState();');
  });

  it('ignores self-inflicted scroll events while settling a new session', () => {
    expect(source).toContain('suppressScrollStateRef.current');
    expect(source).toMatch(
      /if \(suppressScrollStateRef\.current \|\| isScrollingRef\.current\) return;/
    );
  });
});

describe('paginated message query is deterministic (source guard)', () => {
  const source = read('src/main/db/database.ts');

  it('breaks timestamp ties so LIMIT/OFFSET pages cannot skip or repeat rows', () => {
    const stmt = source.match(
      /SELECT \* FROM messages WHERE session_id = \?[\s\S]{0,120}?LIMIT \? OFFSET \?/
    );
    expect(stmt, 'paginated statement not found').not.toBeNull();
    expect(stmt![0]).toContain('ORDER BY timestamp DESC, rowid DESC');
  });
});

describe('prependMessages dedupes overlapping pages', () => {
  beforeEach(() => {
    useAppStore.setState({
      sessions: [],
      activeSessionId: 's1',
      sessionStates: {},
    });
  });

  it('prepends an older page in chronological order', () => {
    const { setMessages, prependMessages } = useAppStore.getState();
    setMessages('s1', [makeMessage('m3'), makeMessage('m4')]);
    prependMessages('s1', [makeMessage('m1'), makeMessage('m2')], true);

    const messages = useAppStore.getState().sessionStates['s1'].messages;
    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(useAppStore.getState().sessionStates['s1'].hasMoreMessages).toBe(true);
  });

  it('drops messages that are already loaded', () => {
    const { setMessages, prependMessages } = useAppStore.getState();
    setMessages('s1', [makeMessage('m3'), makeMessage('m4')]);
    // Overlapping page: m3 arrives again because the offset drifted.
    prependMessages('s1', [makeMessage('m2'), makeMessage('m3')], true);

    const messages = useAppStore.getState().sessionStates['s1'].messages;
    expect(messages.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
    expect(new Set(messages.map((m) => m.id)).size).toBe(messages.length);
  });

  it('is a no-op when the page adds nothing new and hasMore is unchanged', () => {
    const { setMessages, prependMessages } = useAppStore.getState();
    setMessages('s1', [makeMessage('m1')]);
    const before = useAppStore.getState().sessionStates;

    prependMessages('s1', [makeMessage('m1')], true);

    // Same reference — no re-render is scheduled for an empty page.
    expect(useAppStore.getState().sessionStates).toBe(before);
  });

  it('records the end of history when the last page is exhausted', () => {
    const { setMessages, prependMessages } = useAppStore.getState();
    setMessages('s1', [makeMessage('m2')]);
    useAppStore.getState().setHasMoreMessages('s1', true);

    prependMessages('s1', [makeMessage('m1')], false);

    const state = useAppStore.getState().sessionStates['s1'];
    expect(state.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(state.hasMoreMessages).toBe(false);
  });
});
