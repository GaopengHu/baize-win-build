/**
 * @module main/claude/pipeline/cold-start-history
 *
 * 冷启动 `<conversation_history>` 历史重建的序列化纯函数。
 *
 * Phase 1 迁入：escapeXmlAttr/escapeXmlText/serializeMessageContentForHistory。
 * Phase 5 迁入：run() 内的历史组装逻辑（textOnlyMessages 过滤、去重当前 prompt）。
 */
import type { ContentBlock } from '../../../renderer/types';

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
