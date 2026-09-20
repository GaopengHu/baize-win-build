/**
 * @module main/claude/pipeline/cold-start-history
 *
 * 冷启动 `<conversation_history>` 历史重建。
 *
 * Phase 1 迁入：escapeXmlAttr/escapeXmlText/serializeMessageContentForHistory。
 * Phase 5 迁入：run() 内的历史组装逻辑（textOnlyMessages 过滤、去重当前 prompt、
 * token 预算裁剪）→ buildColdStartContextualPrompt。
 */
import type { ContentBlock, Message } from '../../../renderer/types';
import { log } from '../../utils/logger';
import { estimateCharsPerToken } from './context-types';

// Escape characters that would break the cold-start `<conversation_history>`
// envelope when interpolated into XML tag bodies or attribute values. Raw user
// text blocks are intentionally not escaped (preserves legacy compatibility);
// only the new wrapper tags (`<thinking>`, `<tool_use>`, `<tool_result>`) and
// their attributes pass through these.
//
// Attribute values additionally need `"` escaped because attributes are
// double-quoted. Tag bodies do not (keeping `"` keeps JSON input legible to
// the model).
export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeXmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Serialize a message's content blocks into the XML representation used inside the
 * cold-start `<conversation_history>` preamble.
 *
 * Why this exists: when the cached pi-coding-agent SDK session is disposed (cwd
 * change or runtime-signature change), agent-runner rebuilds history from
 * DB-persisted messages. The previous implementation only kept `text` blocks,
 * which silently dropped `thinking`, `tool_use`, and `tool_result` blocks.
 * Providers that require previous reasoning/tool-call replay (e.g. DeepSeek V4
 * Flash) then fail with 400 on the next turn, and every other thinking-capable
 * model loses its reasoning trace across cwd switches (issue #162 — Bug B).
 *
 * Blocks handled:
 *   - text          → raw text (matches the legacy serializer's output)
 *   - thinking      → `<thinking>…</thinking>`
 *   - tool_use      → `<tool_use name="…" id="…">{json input}</tool_use>`
 *   - tool_result   → `<tool_result tool_use_id="…"[ is_error="true"]>…</tool_result>`
 *   - image         → skipped (binary, cannot live inside an XML text preamble)
 *   - file_attachment → skipped (large, would bloat the prompt)
 */
export function serializeMessageContentForHistory(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text': {
        const text = block.text ?? '';
        if (text.length > 0) parts.push(text);
        break;
      }
      case 'thinking': {
        const thinking = block.thinking ?? '';
        if (thinking.length > 0) parts.push(`<thinking>${escapeXmlText(thinking)}</thinking>`);
        break;
      }
      case 'tool_use': {
        const name = block.name ?? 'unknown';
        const id = block.id ?? '';
        let inputStr: string;
        try {
          inputStr = JSON.stringify(block.input ?? {});
        } catch {
          inputStr = '{}';
        }
        parts.push(
          `<tool_use name="${escapeXmlAttr(name)}" id="${escapeXmlAttr(id)}">${escapeXmlText(inputStr)}</tool_use>`
        );
        break;
      }
      case 'tool_result': {
        const id = block.toolUseId ?? '';
        const errAttr = block.isError ? ' is_error="true"' : '';
        // Local type says `content: string`, but Anthropic-style payloads
        // from older message rows or third-party providers may store an
        // array of content blocks. Flatten defensively so we never serialize
        // "[object Object]".
        const rawContent = (block as { content: unknown }).content;
        let text: string;
        if (typeof rawContent === 'string') {
          text = rawContent;
        } else if (Array.isArray(rawContent)) {
          text = rawContent
            .map((c) =>
              c && typeof c === 'object' && 'text' in c
                ? String((c as { text: unknown }).text ?? '')
                : ''
            )
            .join('\n');
        } else {
          text = '';
        }
        parts.push(
          `<tool_result tool_use_id="${escapeXmlAttr(id)}"${errAttr}>${escapeXmlText(text)}</tool_result>`
        );
        break;
      }
      case 'image':
      case 'file_attachment':
        // Skip — not representable as XML text in a history preamble.
        break;
    }
  }
  return parts.join('\n');
}

/**
 * Build the contextual prompt for a cold start (new SDK session with existing
 * DB history). Injects a token-budgeted `<conversation_history>` preamble
 * before the new user prompt.
 *
 * Phase 5 迁入：原 agent-runner.ts run() 内联逻辑，行为保持不变——
 * - 只取 user/assistant 消息；含图片的消息**逐条**过滤（不丢弃整段历史）；
 * - 末尾若为当前 user prompt 则去重（slice(0, -1) 语义，避免重复注入）；
 * - 预算：provider === 'ollama' && contextWindow < 16384 → 0.15，否则 0.3；
 *   charsPerToken 按最近 3 条消息采样估算（CJK ~1.5 vs 英文 ~4）；
 * - 从最新往最旧填充，保留 thinking/tool 块（DeepSeek V4 Flash 等需要
 *   reasoning/tool-call 回放，见 #162 Bug B），超预算即停并标注省略条数。
 *
 * @returns 带 preamble 的 contextualPrompt；无可注入历史时原样返回 prompt。
 */
export function buildColdStartContextualPrompt(
  prompt: string,
  existingMessages: Message[],
  provider: string,
  contextWindow: number
): string {
  const conversationMessages = existingMessages.filter(
    (msg) => msg.role === 'user' || msg.role === 'assistant'
  );
  // Filter out messages that contain images (images can't be serialized into text preamble)
  const textOnlyMessages = conversationMessages.filter(
    (msg) => !msg.content.some((c) => (c as { type?: string }).type === 'image')
  );
  const historyMessages =
    textOnlyMessages.length > 0 && textOnlyMessages[textOnlyMessages.length - 1]?.role === 'user'
      ? textOnlyMessages.slice(0, -1)
      : textOnlyMessages;

  if (historyMessages.length === 0) return prompt;

  // Content-aware chars-per-token estimation (CJK text uses ~1.5 chars/token vs ~4 for English)
  const historyBudgetRatio = provider === 'ollama' && contextWindow < 16384 ? 0.15 : 0.3;
  const historyTokenBudget = Math.floor(contextWindow * historyBudgetRatio);

  // Sample recent messages to estimate chars-per-token ratio. Sampling the
  // full serialized form (text + thinking + tool blocks) gives a better CJK
  // ratio estimate than sampling text only.
  const sampleText = historyMessages
    .slice(-3)
    .map((m) => serializeMessageContentForHistory(m.content))
    .join('');
  const charsPerToken = estimateCharsPerToken(sampleText);
  const historyCharBudget = Math.floor(historyTokenBudget * charsPerToken);

  const historyItems: string[] = [];
  let charCount = 0;
  // Build from newest to oldest, then reverse. We preserve thinking and
  // tool blocks (not just text) so providers requiring reasoning/tool-call
  // replay (DeepSeek V4 Flash, and any thinking-capable model after a
  // cwd switch) continue to function after a cold start. See #162 Bug B.
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const msg = historyMessages[i];
    const serialized = serializeMessageContentForHistory(msg.content);
    if (serialized.length === 0) continue;
    const roleTag = msg.role === 'user' ? 'user' : 'assistant';
    const entry = `<turn role="${roleTag}">${serialized}</turn>`;
    if (charCount + entry.length > historyCharBudget) break;
    charCount += entry.length;
    historyItems.unshift(entry);
  }

  if (historyItems.length === 0) return prompt;

  const trimmedCount = historyMessages.length - historyItems.length;
  const historyNote = trimmedCount > 0 ? `[${trimmedCount} older messages omitted]\n` : '';
  const preamble = `<conversation_history>\n${historyNote}${historyItems.join('\n')}\n</conversation_history>`;
  log(
    '[ClaudeAgentRunner] Cold start: injecting',
    historyItems.length,
    'of',
    historyMessages.length,
    'history messages (budget:',
    historyCharBudget,
    'chars, used:',
    charCount,
    ', charsPerToken:',
    charsPerToken.toFixed(2),
    ')'
  );
  return `${preamble}\n\n${prompt}`;
}
