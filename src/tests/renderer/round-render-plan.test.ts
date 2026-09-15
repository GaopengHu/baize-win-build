import { describe, expect, it } from 'vitest';
import {
  buildRoundRenderPlans,
  getMessageContentBlocks,
} from '../../renderer/utils/round-render-plan';
import type { ContentBlock, Message } from '../../renderer/types';

function makeMessage(id: string, role: 'user' | 'assistant', blocks: ContentBlock[]): Message {
  return {
    id,
    sessionId: 's1',
    role,
    content: blocks,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
  } as Message;
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t }) as ContentBlock;
const toolUse = (id: string): ContentBlock =>
  ({ type: 'tool_use', id, name: 'bash', input: {} }) as unknown as ContentBlock;
const toolResult = (id: string): ContentBlock =>
  ({ type: 'tool_result', tool_use_id: id, content: 'ok' }) as unknown as ContentBlock;
const thinking = (t: string): ContentBlock => ({ type: 'thinking', thinking: t }) as ContentBlock;

describe('buildRoundRenderPlans', () => {
  it('groups messages into rounds identical to the legacy grouping', () => {
    const u1 = makeMessage('u1', 'user', [text('hello')]);
    const a1 = makeMessage('a1', 'assistant', [text('hi')]);
    const u2 = makeMessage('u2', 'user', [text('bye')]);
    const a2 = makeMessage('a2', 'assistant', [text('bye!')]);

    const plans = buildRoundRenderPlans([u1, a1, u2, a2]);
    expect(plans).toHaveLength(2);
    expect(plans[0].userMessage).toBe(u1);
    expect(plans[0].items.map((i) => i.message)).toEqual([a1]);
    expect(plans[1].userMessage).toBe(u2);
    expect(plans[1].items.map((i) => i.message)).toEqual([a2]);
  });

  it('handles a leading assistant message without a user message', () => {
    const a1 = makeMessage('a1', 'assistant', [text('hi')]);
    const plans = buildRoundRenderPlans([a1]);
    expect(plans).toHaveLength(1);
    expect(plans[0].userMessage).toBeNull();
  });

  it('uses stable keys derived from message ids, not array indexes', () => {
    const u1 = makeMessage('u1', 'user', [text('q1')]);
    const a1 = makeMessage('a1', 'assistant', [text('r1')]);
    const u2 = makeMessage('u2', 'user', [text('q2')]);
    const a2 = makeMessage('a2', 'assistant', [text('r2')]);

    const full = buildRoundRenderPlans([u1, a1, u2, a2]);
    // Prepending an older round must not change keys of later rounds
    // (index-based keys would shift and force full subtree remounts).
    const u0 = makeMessage('u0', 'user', [text('q0')]);
    const a0 = makeMessage('a0', 'assistant', [text('r0')]);
    const prepended = buildRoundRenderPlans([u0, a0, u1, a1, u2, a2]);

    expect(prepended.map((p) => p.key)).toEqual(['u0', 'u1', 'u2']);
    expect(full.map((p) => p.key)).toEqual(['u1', 'u2']);
  });

  it('partitions tool rounds: process blocks vs visible answer blocks', () => {
    const u1 = makeMessage('u1', 'user', [text('run it')]);
    const a1 = makeMessage('a1', 'assistant', [
      thinking('hmm'),
      toolUse('t1'),
      toolResult('t1'),
      text('done'),
    ]);

    const [plan] = buildRoundRenderPlans([u1, a1]);
    expect(plan.processBlocks.map((b) => b.type)).toEqual(['thinking', 'tool_use', 'tool_result']);
    expect(plan.items[0].visibleBlocks.map((b) => b.type)).toEqual(['text']);
    expect(plan.items[0].isStreaming).toBe(false);
    expect(plan.lastAssistantMessage).toBe(a1);
  });

  it('flags partial-* streaming messages', () => {
    const u1 = makeMessage('u1', 'user', [text('q')]);
    const streaming = makeMessage('partial-s1', 'assistant', [text('streaming...')]);

    const [plan] = buildRoundRenderPlans([u1, streaming]);
    expect(plan.items[0].isStreaming).toBe(true);
    expect(plan.key).toBe('u1');
  });

  it('reuses plan object references for rounds whose messages did not change', () => {
    const u1 = makeMessage('u1', 'user', [text('q1')]);
    const a1 = makeMessage('a1', 'assistant', [text('r1')]);
    const u2 = makeMessage('u2', 'user', [text('q2')]);
    const streamingV1 = makeMessage('partial-s1', 'assistant', [text('abc')]);

    const first = buildRoundRenderPlans([u1, a1, u2, streamingV1]);

    // Next animation frame: only the streaming message object is new.
    const streamingV2 = makeMessage('partial-s1', 'assistant', [text('abcd')]);
    const second = buildRoundRenderPlans([u1, a1, u2, streamingV2]);

    // Round 1 is untouched -> identical plan reference (memoized children skip re-render).
    expect(second[0]).toBe(first[0]);
    // Streaming round changed -> new plan reference.
    expect(second[1]).not.toBe(first[1]);
    expect(second[1].items[0].visibleBlocks[0]).toEqual(text('abcd'));
  });

  it('reuses normalized blocks for unchanged messages across calls', () => {
    const u1 = makeMessage('u1', 'user', [text('q')]);
    const a1 = makeMessage('a1', 'assistant', [thinking('t'), toolUse('x'), toolResult('x')]);
    const first = buildRoundRenderPlans([u1, a1]);
    const second = buildRoundRenderPlans([u1, a1]);
    expect(second[0]).toBe(first[0]);
    // Same message reference -> same mergedBlocks array reference.
    expect(second[0].items[0].mergedBlocks).toBe(first[0].items[0].mergedBlocks);
  });

  it('falls back to the first assistant id for round keys without a user message', () => {
    const a1 = makeMessage('a1', 'assistant', [text('hi')]);
    const [plan] = buildRoundRenderPlans([a1]);
    expect(plan.key).toBe('a1');
  });
});

describe('getMessageContentBlocks', () => {
  it('wraps non-array content into a single text block', () => {
    const message = { id: 'm1', role: 'assistant', content: 'plain string' } as unknown as Message;
    expect(getMessageContentBlocks(message)).toEqual([{ type: 'text', text: 'plain string' }]);
  });

  it('passes array content through', () => {
    const message = makeMessage('m1', 'assistant', [text('a'), text('b')]);
    expect(getMessageContentBlocks(message)).toHaveLength(2);
  });
});
