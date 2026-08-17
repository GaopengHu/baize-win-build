import type { ContentBlock } from '../types';

export const isResultBlock = (b: ContentBlock) =>
  b.type === 'text' || b.type === 'image' || b.type === 'file_attachment';

export const isProcessBlock = (b: ContentBlock) =>
  b.type === 'thinking' || b.type === 'tool_use' || b.type === 'tool_result';

export function partitionBlocks(blocks: ContentBlock[]) {
  return {
    resultBlocks: blocks.filter(isResultBlock),
    processBlocks: blocks.filter(isProcessBlock),
  };
}
export function mergeThinkingBlocks(blocks: ContentBlock[]): ContentBlock[] {
  const allThinking: string[] = [];
  const nonThinking: ContentBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'thinking') {
      allThinking.push((block as { type: 'thinking'; thinking: string }).thinking);
    } else {
      nonThinking.push(block);
    }
  }
  const merged: ContentBlock[] = [];
  if (allThinking.length > 0) {
    merged.push({ type: 'thinking', thinking: allThinking.join('\n') });
  }
  merged.push(...nonThinking);
  return merged;
}
