import { useState, useEffect, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  Terminal,
  CheckCircle2,
  Loader2,
  XCircle,
} from 'lucide-react';
import type { ContentBlock, Message, TraceStep } from '../../types';
import { ContentBlockView } from './ContentBlockView';
import { ThinkingBlock } from './ThinkingBlock';
import { getToolIcon, getToolLabel } from './toolHelpers';

interface ProcessPanelProps {
  blocks: ContentBlock[];
  traceSteps?: TraceStep[];
  message?: Message;
  /** 有新思考/trace 活动时自动展开（默认开；用户手动折叠后不再打扰） */
  autoOpenOnActivity?: boolean;
}

function summarizeText(text?: string): string {
  const trimmed = text?.trim() || '';
  if (!trimmed) return '';
  const firstLine = trimmed.split(/\r?\n/)[0] || '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function getStepSummary(step: TraceStep): string {
  if (step.type === 'tool_call') {
    return getToolLabel(step.toolName || '', step.toolInput || {}, step.title);
  }
  if (step.type === 'tool_result') {
    return summarizeText(step.toolOutput) || summarizeText(step.content) || step.title;
  }
  return summarizeText(step.content) || step.title || '';
}

function getStepDetailText(step: TraceStep): string {
  if (step.type === 'tool_call') {
    if (step.toolInput && Object.keys(step.toolInput).length > 0) {
      return JSON.stringify(step.toolInput, null, 2);
    }
    return step.content || '';
  }
  if (step.type === 'tool_result') {
    return step.toolOutput || step.content || '';
  }
  return step.content || '';
}

function getStepStatusIcon(step: TraceStep) {
  if (step.status === 'running') {
    return <Loader2 className="w-3.5 h-3.5 animate-spin text-accent flex-shrink-0" />;
  }
  if (step.status === 'error') {
    return <XCircle className="w-3.5 h-3.5 text-error flex-shrink-0" />;
  }
  return <CheckCircle2 className="w-3.5 h-3.5 text-success flex-shrink-0" />;
}

const TraceStepBlock = memo(function TraceStepBlock({ step }: { step: TraceStep }) {
  const [expanded, setExpanded] = useState(false);
  const summary = getStepSummary(step);
  const detailText = getStepDetailText(step);
  const title = step.title || step.toolName || step.type;

  return (
    <div
      className={`rounded-2xl border overflow-hidden transition-colors ${
        step.status === 'error'
          ? 'border-error/25 bg-error/5'
          : step.status === 'running'
            ? 'border-accent/15 bg-accent/5'
            : 'border-border-subtle bg-background/35'
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-surface-hover/50 transition-colors"
      >
        <div
          className={`flex-shrink-0 ${
            step.status === 'error' ? 'text-error' : step.status === 'running' ? 'text-accent' : 'text-text-muted'
          }`}
        >
          {getStepStatusIcon(step)}
        </div>
        <div className="flex-shrink-0 text-text-muted">{getToolIcon(step.toolName || title)}</div>
        <span className="text-xs font-mono text-text-secondary truncate flex-1 min-w-0">
          {summary || title}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        )}
      </button>

      {expanded && detailText && (
        <div className="border-t border-border/50 px-3 py-2 animate-fade-in bg-background/35">
          <pre className="text-xs font-mono whitespace-pre-wrap break-all rounded-lg p-2.5 border border-border-subtle text-text-secondary bg-surface-muted max-h-[300px] overflow-y-auto">
            {detailText}
          </pre>
        </div>
      )}
    </div>
  );
});

export const ProcessPanel = memo(function ProcessPanel({
  blocks,
  traceSteps = [],
  message,
  autoOpenOnActivity = true,
}: ProcessPanelProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [userToggled, setUserToggled] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 新内容进来时自动展开（仅当用户没手动折叠过）：streaming 期间 traceSteps /
  // thinking 逐帧追加，但 ProcessPanel 默认是收起的，用户根本看不到"当前输出"，
  // 还误以为外层滚轴坏了。用户手动点过一次后就尊重他的选择，不再自动改。
  const activityKey = traceSteps.length + blocks.length;
  const lastBlockLen =
    blocks.length > 0
      ? String(
          (blocks[blocks.length - 1] as { text?: string; thinking?: string }).text ??
            (blocks[blocks.length - 1] as { thinking?: string }).thinking ??
            ''
        ).length
      : 0;
  const lastStepLen = traceSteps.length > 0 ? getStepDetailText(traceSteps[traceSteps.length - 1]).length : 0;
  useEffect(() => {
    if (!autoOpenOnActivity || userToggled) return;
    if (activityKey > 0) setExpanded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityKey, autoOpenOnActivity, userToggled]);

  // 展开状态下新输出进来时，面板内部滚到底（外层整页滚动只到消息锚点，
  // 面板里 pre max-h-[300px] 的独立滚轴不会动 —— 这就是"要手动拉" 的根因）。
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !expanded) return;
    el.scrollTop = el.scrollHeight;
  }, [expanded, activityKey, lastBlockLen, lastStepLen]);

  const thinkingBlocks = blocks.filter((block) => block.type === 'thinking');
  const textBlocks = blocks.filter((block) => block.type === 'text');
  const fallbackProcessBlocks =
    traceSteps.length > 0
      ? []
      : blocks.filter((block) => block.type === 'tool_use' || block.type === 'tool_result');

  if (
    thinkingBlocks.length === 0 &&
    textBlocks.length === 0 &&
    fallbackProcessBlocks.length === 0 &&
    traceSteps.length === 0
  ) {
    return null;
  }

  const orderedTraceSteps = [...traceSteps].sort((a, b) => a.timestamp - b.timestamp);

  return (
    <div className="rounded-2xl border border-border-subtle bg-background/40 overflow-hidden">
      <button
        onClick={() => {
          setExpanded((e) => !e);
          setUserToggled(true);
        }}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-hover/50 transition-colors"
      >
        <Terminal className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        <span className="text-xs font-medium text-text-muted flex-1">{t('messageCard.process')}</span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div
          ref={bodyRef}
          className="border-t border-border/50 px-3 py-2 space-y-1.5 animate-fade-in max-h-[50vh] overflow-y-auto"
        >  {blocks.map((block, index) =>
            block.type === 'thinking' ? (
              <ThinkingBlock
                key={'id' in block ? (block as { id: string }).id : `thinking-block-${index}`}
                block={block as { type: 'thinking'; thinking: string }}
                compact
              />
            ) : block.type === 'text' ? (
              <div
                key={'id' in block ? (block as { id: string }).id : `process-text-${index}`}
                className="text-sm text-text-secondary leading-relaxed prose-chat max-w-none"
              >
                {(block as { type: 'text'; text: string }).text}
              </div>
            ) : traceSteps.length === 0 ? (
              <ContentBlockView
                key={'id' in block ? (block as { id: string }).id : `process-block-${index}`}
                block={block}
                isUser={false}
                allBlocks={blocks}
                message={message}
              />
            ) : null
          )}

          {orderedTraceSteps.map((step) => (
            <TraceStepBlock key={step.id} step={step} />
          ))}
        </div>
      )}
    </div>
  );
});
