import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import type { ContentBlock, Message } from '../../../src/renderer/types';
import {
  buildColdStartContextualPrompt,
  escapeXmlAttr,
  escapeXmlText,
  serializeMessageContentForHistory,
} from '../../../src/main/claude/pipeline/cold-start-history';

/**
 * Phase 1/5 行为契约（AGENT-RUNNER-REFACTOR-PLAN.md §5.0.1）。
 * Phase 1：escapeXmlAttr/Text、serializeMessageContentForHistory 纯函数。
 * Phase 5：buildColdStartContextualPrompt（原 agent-runner run() 内联历史组装）。
 * 序列化器的完整回归集另见 src/tests/claude/agent-runner-history-rebuild.test.ts
 * （经 agent-runner re-export 导入，锁定 #162 Bug B 不回归）。
 */

let seq = 0;
function msg(role: Message['role'], content: ContentBlock[]): Message {
  seq += 1;
  return {
    id: `m-${seq}`,
    sessionId: 'sess-cold',
    role,
    content,
    timestamp: Date.now(),
  };
}

function text(t: string): ContentBlock {
  return { type: 'text', text: t };
}

describe('cold-start-history (Phase 1/5)', () => {
  describe('Phase 1 纯函数', () => {
    it('escapeXmlAttr 转义 & < > " 四字符', () => {
      expect(escapeXmlAttr('a & b < c > d " e')).toBe('a &amp; b &lt; c &gt; d &quot; e');
    });

    it('escapeXmlText 转义 & < >（不转义引号，保留 JSON 可读性）', () => {
      expect(escapeXmlText('a & b < c > d " e')).toBe('a &amp; b &lt; c &gt; d " e');
    });

    it('serializeMessageContentForHistory 处理 string / 数组内容 / 图片过滤', () => {
      // string 内容
      expect(
        serializeMessageContentForHistory([{ type: 'tool_result', toolUseId: 't1', content: 'ok' }])
      ).toBe('<tool_result tool_use_id="t1">ok</tool_result>');
      // Anthropic 风格数组内容（防御性展平，绝不出现 [object Object]）
      expect(
        serializeMessageContentForHistory([
          {
            type: 'tool_result',
            toolUseId: 't2',
            content: [
              { type: 'text', text: 'line1' },
              { type: 'text', text: 'line2' },
            ],
          } as unknown as ContentBlock,
        ])
      ).toBe('<tool_result tool_use_id="t2">line1\nline2</tool_result>');
      // 图片与文件附件块被跳过
      expect(
        serializeMessageContentForHistory([
          { type: 'image', source: { type: 'base64', data: 'x' } } as unknown as ContentBlock,
          text('kept'),
        ])
      ).toBe('kept');
    });
  });

  describe('Phase 5 历史组装 buildColdStartContextualPrompt', () => {
    it('不重复注入当前用户 prompt（末尾 user 消息被 slice(0, -1) 去重）', () => {
      const messages = [
        msg('user', [text('earlier question')]),
        msg('assistant', [text('earlier answer')]),
        msg('user', [text('current prompt')]), // 当前 prompt，必须被去重
      ];
      const result = buildColdStartContextualPrompt(
        'current prompt',
        messages,
        'anthropic',
        128000
      );
      expect(result).toContain('<conversation_history>');
      expect(result).toContain('earlier question');
      expect(result).toContain('earlier answer');
      // 'current prompt' 只应作为结尾的新 prompt 出现一次，不出现在 preamble 里
      const occurrences = result.split('current prompt').length - 1;
      expect(occurrences).toBe(1);
      expect(result.endsWith('current prompt')).toBe(true);
    });

    it('末尾为 assistant 时不做 slice 去重，全量历史保留', () => {
      const messages = [msg('user', [text('q1')]), msg('assistant', [text('a1')])];
      const result = buildColdStartContextualPrompt('q2', messages, 'anthropic', 128000);
      expect(result).toContain('<turn role="user">q1</turn>');
      expect(result).toContain('<turn role="assistant">a1</turn>');
    });

    it('含图片的消息被单独过滤，而不是丢弃整段历史', () => {
      const messages = [
        msg('user', [text('with-image')]),
        msg('assistant', [
          { type: 'image', source: { type: 'base64', data: 'x' } } as unknown as ContentBlock,
        ]),
        msg('assistant', [text('pure-text-answer')]),
        msg('user', [text('current')]),
      ];
      const result = buildColdStartContextualPrompt('current', messages, 'anthropic', 128000);
      expect(result).toContain('with-image');
      expect(result).toContain('pure-text-answer');
      expect(result).not.toContain('base64');
    });

    it('非 user/assistant 角色（system）被过滤', () => {
      const messages = [
        msg('system', [text('system notice')]),
        msg('assistant', [text('a1')]),
        msg('user', [text('current')]),
      ];
      const result = buildColdStartContextualPrompt('current', messages, 'anthropic', 128000);
      expect(result).not.toContain('system notice');
      expect(result).toContain('a1');
    });

    it('无历史可注入时原样返回 prompt（空数组 / 仅当前 prompt）', () => {
      expect(buildColdStartContextualPrompt('hello', [], 'anthropic', 128000)).toBe('hello');
      const onlyCurrent = [msg('user', [text('hello')])];
      expect(buildColdStartContextualPrompt('hello', onlyCurrent, 'anthropic', 128000)).toBe(
        'hello'
      );
    });

    it('超预算时从最旧开始裁剪，并标注 [N older messages omitted]', () => {
      // 小窗口（ollama 8k → ratio 0.15 → 预算 ~1200 token → char 预算较小）
      const messages: Message[] = [];
      for (let i = 0; i < 40; i++) {
        messages.push(msg('assistant', [text(`answer-${i} ` + 'x'.repeat(200))]));
      }
      messages.push(msg('user', [text('current')]) as Message);
      const result = buildColdStartContextualPrompt('current', messages, 'ollama', 8192);
      expect(result).toContain('<conversation_history>');
      expect(result).toMatch(/\[\d+ older messages omitted\]/);
      // 最新的回答保留，最旧的被裁掉
      expect(result).toContain('answer-39');
      expect(result).not.toContain('answer-0 ');
    });

    it('thinking/tool 块被保留（#162 Bug B：reasoning/tool-call 回放）', () => {
      const messages = [
        msg('assistant', [
          { type: 'thinking', thinking: 'deep reasoning' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
        ]),
        msg('user', [text('current')]),
      ];
      const result = buildColdStartContextualPrompt('current', messages, 'anthropic', 128000);
      expect(result).toContain('<thinking>deep reasoning</thinking>');
      expect(result).toContain('<tool_use name="Bash" id="tu1">');
    });

    it('preamble 结构：<conversation_history> + turns + 新 prompt', () => {
      const messages = [
        msg('user', [text('q1')]),
        msg('assistant', [text('a1')]),
        msg('user', [text('now')]),
      ];
      const result = buildColdStartContextualPrompt('now', messages, 'anthropic', 128000);
      expect(result).toMatch(
        /^<conversation_history>\n<turn role="user">q1<\/turn>\n<turn role="assistant">a1<\/turn>\n<\/conversation_history>\n\nnow$/
      );
    });
  });
});
