import { useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import type { ContentBlock, Message } from '../../types';
import { ContentBlockView } from './ContentBlockView';

interface ProcessPanelProps {
  blocks: ContentBlock[];
  message?: Message;
}

export const ProcessPanel = memo(function ProcessPanel({ blocks, message }: ProcessPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (blocks.length === 0) return null;

  return (
    <div className="rounded-2xl border border-border-subtle bg-background/40 overflow-hidden">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-hover/50 transition-colors"
      >
        <Terminal className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        <span className="text-xs font-medium text-text-muted flex-1">
          {t('messageCard.process')}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/50 px-3 py-2 space-y-1.5 animate-fade-in">
          {blocks.map((block, index) => (
            <ContentBlockView
              key={'id' in block ? (block as { id: string }).id : `process-block-${index}`}
              block={block}
              isUser={false}
              allBlocks={blocks}
              message={message}
            />
          ))}
        </div>
      )}
    </div>
  );
});
