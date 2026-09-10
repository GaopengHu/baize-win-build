import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const chatViewSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/components/ChatView.tsx'),
  'utf8'
);
const contentBlockSource = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/components/message/ContentBlockView.tsx'),
  'utf8'
);

describe('ChatView streaming render performance wiring', () => {
  it('builds memoized round render plans instead of recomputing in JSX', () => {
    expect(chatViewSource).toContain(
      "import { buildRoundRenderPlans } from '../utils/round-render-plan';"
    );
    expect(chatViewSource).toContain('buildRoundRenderPlans(displayedMessages)');
    expect(chatViewSource).toContain('roundPlans.map((round)');
    // Legacy per-frame recomputation must be gone.
    expect(chatViewSource).not.toContain('groupMessagesIntoRounds(displayedMessages)');
    expect(chatViewSource).not.toContain('normalizeAssistantBlocks(');
  });

  it('keys rounds by stable message id, not array index', () => {
    expect(chatViewSource).toContain('<div key={round.key} className="space-y-5">');
    expect(chatViewSource).not.toMatch(/key=\{roundIndex\}/);
  });
});

describe('ContentBlockView streaming plain-text fast path', () => {
  it('renders streaming assistant text as plain text without the markdown pipeline', () => {
    // Streaming early-return: plain whitespace-preserving text + caret.
    expect(contentBlockSource).toContain('if (isStreaming) {');
    const streamingBlock = contentBlockSource.slice(
      contentBlockSource.indexOf('if (isStreaming) {'),
      contentBlockSource.indexOf('if (isStreaming) {') + 600
    );
    expect(streamingBlock).toContain('whitespace-pre-wrap');
    expect(streamingBlock).toContain('animate-pulse');
    expect(streamingBlock).not.toContain('MessageMarkdown');
    // The markdown pipeline stays for finalized messages (single usage).
    expect(contentBlockSource.match(/<MessageMarkdown/g)).toHaveLength(1);
  });
});
