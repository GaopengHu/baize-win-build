import type { ContentBlock, Message } from '../types';
import {
  normalizeAssistantBlocks,
  type NormalizedAssistantBlocks,
} from './content-block-partition';

/**
 * Render-plan construction for the chat message list.
 *
 * Streaming updates rebuild `displayedMessages` on every animation frame. To
 * keep that O(changed round) instead of O(all blocks), this module:
 *  - memoizes block normalization per Message reference (WeakMap), so historic
 *    messages never re-run mergeThinkingBlocks/filter/reduce;
 *  - memoizes whole round plans by a stable key with a signature check on the
 *    round's message references, so untouched rounds keep IDENTICAL plan (and
 *    block array) references across frames — React.memo on ProcessPanel /
 *    ContentBlockView then skips them entirely;
 *  - derives round keys from message ids instead of array indexes, so
 *    paginated prepend does not remount every round subtree.
 */

export interface RoundRenderItem {
  message: Message;
  mergedBlocks: ContentBlock[];
  visibleBlocks: ContentBlock[];
  isStreaming: boolean;
}

export interface RoundRenderPlan {
  key: string;
  userMessage: Message | null;
  processBlocks: ContentBlock[];
  lastAssistantMessage: Message | undefined;
  items: RoundRenderItem[];
}

interface Round {
  userMessage: Message | null;
  assistantMessages: Message[];
}

export function getMessageContentBlocks(message: Message): ContentBlock[] {
  const rawContent = message.content as unknown;
  return Array.isArray(rawContent)
    ? (rawContent as ContentBlock[])
    : ([{ type: 'text', text: String(rawContent ?? '') }] as ContentBlock[]);
}

function groupMessagesIntoRounds(messages: Message[]): Round[] {
  const rounds: Round[] = [];
  let currentRound: Round = { userMessage: null, assistantMessages: [] };

  for (const message of messages) {
    if (message.role === 'user') {
      if (currentRound.userMessage || currentRound.assistantMessages.length > 0) {
        rounds.push(currentRound);
      }
      currentRound = { userMessage: message, assistantMessages: [] };
    } else {
      currentRound.assistantMessages.push(message);
    }
  }

  if (currentRound.userMessage || currentRound.assistantMessages.length > 0) {
    rounds.push(currentRound);
  }

  return rounds;
}

// Per-message normalization memo. Keyed by Message identity; validated against
// the content array reference in case a Message object is mutated in place.
const normalizeCache = new WeakMap<
  Message,
  { content: unknown; normalized: NormalizedAssistantBlocks }
>();

function normalizeForMessage(message: Message): NormalizedAssistantBlocks {
  const cached = normalizeCache.get(message);
  if (cached && cached.content === message.content) {
    return cached.normalized;
  }
  const blocks = getMessageContentBlocks(message);
  const normalized = normalizeAssistantBlocks(blocks);
  normalizeCache.set(message, { content: message.content, normalized });
  return normalized;
}

// Round-level plan memo. Stable key -> signature + plan. When a round's message
// references are unchanged, the previous plan object is returned as-is.
interface RoundCacheEntry {
  userMessage: Message | null;
  assistantMessages: Message[];
  plan: RoundRenderPlan;
}
const roundPlanCache = new Map<string, RoundCacheEntry>();
const ROUND_CACHE_MAX = 500;

function isStreamingMessage(message: Message): boolean {
  return typeof message.id === 'string' && message.id.startsWith('partial-');
}

function buildPlan(round: Round): RoundRenderPlan {
  const processBlocks: ContentBlock[] = [];
  const items: RoundRenderItem[] = [];

  for (const assistantMessage of round.assistantMessages) {
    const normalized = normalizeForMessage(assistantMessage);
    if (normalized.hasTools) {
      processBlocks.push(...normalized.processBlocks);
    }
    items.push({
      message: assistantMessage,
      mergedBlocks: normalized.mergedBlocks,
      visibleBlocks: normalized.visibleBlocks,
      isStreaming: isStreamingMessage(assistantMessage),
    });
  }

  return {
    key: round.userMessage?.id ?? round.assistantMessages[0]?.id ?? 'empty-round',
    userMessage: round.userMessage,
    processBlocks,
    lastAssistantMessage: round.assistantMessages[round.assistantMessages.length - 1],
    items,
  };
}

function sameSignature(entry: RoundCacheEntry, round: Round): boolean {
  if (entry.userMessage !== round.userMessage) {
    return false;
  }
  if (entry.assistantMessages.length !== round.assistantMessages.length) {
    return false;
  }
  for (let i = 0; i < entry.assistantMessages.length; i += 1) {
    if (entry.assistantMessages[i] !== round.assistantMessages[i]) {
      return false;
    }
  }
  return true;
}

export function buildRoundRenderPlans(messages: Message[]): RoundRenderPlan[] {
  const rounds = groupMessagesIntoRounds(messages);
  if (roundPlanCache.size > ROUND_CACHE_MAX) {
    roundPlanCache.clear();
  }

  return rounds.map((round) => {
    const key = round.userMessage?.id ?? round.assistantMessages[0]?.id ?? undefined;
    if (key) {
      const cached = roundPlanCache.get(key);
      if (cached && sameSignature(cached, round)) {
        return cached.plan;
      }
      const plan = buildPlan(round);
      roundPlanCache.set(key, {
        userMessage: round.userMessage,
        assistantMessages: round.assistantMessages,
        plan,
      });
      return plan;
    }
    return buildPlan(round);
  });
}
