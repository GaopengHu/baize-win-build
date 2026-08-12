// Collapsible "thinking" block — hidden by default, click to reveal
import { Suspense, lazy, useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Brain } from 'lucide-react';
import { PanelErrorBoundary } from '../PanelErrorBoundary';

const MessageMarkdown = lazy(() =>
  import('../MessageMarkdown').then((module) => ({ default: module.MessageMarkdown }))
);

interface ThinkingBlockProps {
  block: { type: 'thinking'; thinking: string };
}

export const ThinkingBlock = memo(function ThinkingBlock({ block }: ThinkingBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const text = block.thinking || '';
  if (!text) return null;

  return (
    <div className="rounded-2xl border border-border-subtle bg-background/40 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-hover/50 transition-colors"
      >
        <Brain className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        <span className="text-xs font-medium text-text-muted">{t('messageCard.thinking')}</span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0 ml-auto" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0 ml-auto" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/50 px-4 py-3 animate-fade-in">
          <div className="text-sm text-text-secondary leading-relaxed prose-chat max-w-none">
            <PanelErrorBoundary
              name="ThinkingMarkdown"
              fallback={<div className="whitespace-pre-wrap">{text}</div>}
            >
              <Suspense fallback={<div className="whitespace-pre-wrap">{text}</div>}>
                <MessageMarkdown normalizedText={text} />
              </Suspense>
            </PanelErrorBoundary>
          </div>
        </div>
      )}
    </div>
  );
});
