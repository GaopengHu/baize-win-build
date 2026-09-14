import type { ContentBlock } from '../types';

export const isResultBlock = (b: ContentBlock) =>
  b.type === 'text' || b.type === 'image' || b.type === 'file_attachment';

export const isProcessBlock = (b: ContentBlock) =>
  b.type === 'thinking' || b.type === 'tool_use' || b.type === 'tool_result';

/** Has actual tool invocations (not just thinking). */
export const hasToolBlocks = (blocks: ContentBlock[]) =>
  blocks.some((b) => b.type === 'tool_use' || b.type === 'tool_result');

export interface NormalizedAssistantBlocks {
  visibleBlocks: ContentBlock[];
  processBlocks: ContentBlock[];
  mergedBlocks: ContentBlock[];
  hasTools: boolean;
}

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

export function normalizeAssistantBlocks(blocks: ContentBlock[]): NormalizedAssistantBlocks {
  const mergedBlocks = mergeThinkingBlocks(blocks);
  const hasTools = hasToolBlocks(mergedBlocks);

  if (!hasTools) {
    return {
      mergedBlocks,
      visibleBlocks: mergedBlocks.filter(isResultBlock),
      processBlocks: mergedBlocks.filter(isProcessBlock),
      hasTools,
    };
  }

  const lastToolIndex = mergedBlocks.reduce((lastIndex, block, index) => {
    return block.type === 'tool_use' || block.type === 'tool_result' ? index : lastIndex;
  }, -1);

  // For tool-driven messages, everything up to and including the last tool
  // result stays in the process panel. Anything after that is treated as the
  // final user-facing answer (e.g. "报告已生成" + download link).
  return {
    mergedBlocks,
    visibleBlocks: mergedBlocks.filter((block, index) => {
      if (!isResultBlock(block)) {
        return false;
      }
      return index > lastToolIndex;
    }),
    processBlocks: mergedBlocks.filter((block, index) => {
      if (block.type === 'thinking') {
        return true;
      }
      return index <= lastToolIndex || block.type === 'tool_use' || block.type === 'tool_result';
    }),
    hasTools,
  };
}

export function hasVisibleAssistantContent(blocks: ContentBlock[]): boolean {
  return mergeThinkingBlocks(blocks).some(isResultBlock);
}
