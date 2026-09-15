// Dispatches a single ContentBlock to the appropriate sub-renderer
import { Suspense, lazy, isValidElement, cloneElement, memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import { PanelErrorBoundary } from '../PanelErrorBoundary';
import {
  splitTextByFileMentions,
  splitChildrenByFileMentions,
  getFileLinkButtonClassName,
} from '../../utils/file-link';
import { resolvePathAgainstWorkspace } from '../../../shared/workspace-path';
import {
  normalizeLocalFileMarkdownLinks,
  resolveLocalFilePathFromHref,
} from '../../utils/markdown-local-link';
import { decodeCjkPercentEncoding } from '../../../shared/local-file-path';
import { normalizeLatexDelimiters } from '../../utils/latex-delimiters';
import { appendFolderOpenLinks } from '../../utils/artifact-links';
import type { ToolUseContent, ToolResultContent, FileAttachmentContent } from '../../types';
import { FileText } from 'lucide-react';
import { CodeBlock } from './CodeBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolUseBlock } from './ToolUseBlock';
import { ToolResultBlock } from './ToolResultBlock';
import type { ContentBlockViewProps } from './types';

const MessageMarkdown = lazy(() =>
  import('../MessageMarkdown').then((module) => ({ default: module.MessageMarkdown }))
);

// Cowork citation guidance can emit ~[Title](url)~ markers.
// Render them as regular links instead of strikethrough links.
function normalizeCitationMarkdownLinks(markdown: string): string {
  return markdown.replace(/~\[(.+?)\]\(([^)\s]+)\)~/g, '[$1]($2)');
}

export const ContentBlockView = memo(function ContentBlockView({
  block,
  isUser,
  isStreaming,
  allBlocks,
  message,
}: ContentBlockViewProps) {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const workingDir = useAppStore((s) => s.workingDir);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : null;
  const currentWorkingDir = activeSession?.cwd || workingDir;

  const resolveFilePath = (value: string) =>
    resolvePathAgainstWorkspace(decodeCjkPercentEncoding(value), currentWorkingDir);

  const openContainingFolder = async (filePath: string) => {
    if (typeof window === 'undefined' || !window.electronAPI?.showItemInFolder) {
      return;
    }

    const resolvedPath = resolveFilePath(filePath);
    try {
      const revealed = await window.electronAPI.showItemInFolder(
        resolvedPath,
        currentWorkingDir ?? undefined
      );
      if (!revealed) {
        setGlobalNotice({
          id: `message-card-reveal-failed-${Date.now()}`,
          type: 'warning',
          message: t('context.revealFailed'),
        });
      }
    } catch (error) {
      setGlobalNotice({
        id: `message-card-reveal-failed-${Date.now()}`,
        type: 'warning',
        message:
          error instanceof Error && error.message ? error.message : t('context.revealFailed'),
      });
    }
  };

  const renderFileButton = (value: string, key?: string) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        void openContainingFolder(value);
      }}
      className={getFileLinkButtonClassName()}
      title={resolveFilePath(value)}
    >
      <span className="truncate">{value}</span>
    </button>
  );

  const renderFileMentionParts = (
    parts: ReturnType<typeof splitChildrenByFileMentions>,
    keyPrefix: string
  ) =>
    parts.map((part, partIndex) => {
      const key = `${keyPrefix}-${partIndex}`;
      if (part.type === 'file') {
        return renderFileButton(part.value, key);
      }
      if (part.type === 'text') {
        return <span key={key}>{part.value}</span>;
      }
      if (isValidElement(part.value)) {
        return part.value.key ? part.value : cloneElement(part.value, { key });
      }
      return <span key={key}>{String(part.value)}</span>;
    });

  const renderChildrenWithFileLinks = (children: unknown, keyPrefix: string) => {
    const normalized = Array.isArray(children) ? children : [children];
    const parts = splitChildrenByFileMentions(normalized);
    return renderFileMentionParts(parts, keyPrefix);
  };

  const markdownComponents = useMemo(
    () => ({
      a({ children, href }: { children?: React.ReactNode; href?: string }) {
        // href 里可能带着模型回吐的 %E8%A5%BF… 编码中文名。
        // 幸运的是 normalizeLocalFileMarkdownLinks 在渲染前已把本地 href
        // 转成 file:// 编码 URL，而 resolveLocalFilePathFromHref 内部经
        // localPathFromFileUrl 会解码——点击目标天然是真实路径。
        // 这里只对"可见按钮文字"做 CJK 解码，保证文件名显示正常；
        // href 本体不二次解码，避免破坏 file:// URL 的 #/%23 边界。
        const localFilePath = resolveLocalFilePathFromHref(href, currentWorkingDir);
        if (localFilePath) {
          const displayChildren = Array.isArray(children)
            ? children.map((c) =>
                typeof c === 'string' ? decodeCjkPercentEncoding(c) : c
              )
            : typeof children === 'string'
              ? decodeCjkPercentEncoding(children)
              : children;
          return (
            <button
              type="button"
              onClick={() => {
                void openContainingFolder(localFilePath);
              }}
              className={getFileLinkButtonClassName()}
              title={localFilePath}
            >
              {displayChildren}
            </button>
          );
        }

        const safeHref = href && /^(?:https?:|mailto:|#)/i.test(href) ? href : undefined;
        if (!safeHref) {
          return <span className="text-text-primary">{children}</span>;
        }
        return (
          <a
            href={safeHref}
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault();
              if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
                void window.electronAPI.openExternal(safeHref);
              }
            }}
            className="text-[#2f8bb8] hover:text-[#237aa7] underline decoration-[#79bfe0]/40 transition-colors"
          >
            {children}
          </a>
        );
      },
      blockquote({ children }: { children?: React.ReactNode }) {
        return (
          <blockquote className="border-l-2 border-accent/40 pl-4 text-text-muted">
            {children}
          </blockquote>
        );
      },
      code({ className, children, ...props }: { className?: string; children?: React.ReactNode }) {
        const match = /language-([\w+#.-]+)/.exec(className || '');
        const isInline = !match;

        if (isInline) {
          let raw = String(children).replace(/\s*[\(（]\s*\d+(\.\d+)?\s*(B|KB|MB|GB)\s*[\)）]\s*$/i, '');
          const parts = splitTextByFileMentions(raw);
          if (parts.length === 1 && parts[0]?.type === 'file') {
            return renderFileButton(parts[0].value);
          }
          if (parts.some((p) => p.type === 'file')) {
            return (
              <span className="inline-flex flex-wrap gap-1 items-center">
                {renderFileMentionParts(parts as ReturnType<typeof splitChildrenByFileMentions>, 'code')}
              </span>
            );
          }
          return (
            <code
              className="px-1.5 py-0.5 rounded bg-surface-muted text-accent font-mono text-sm"
              {...props}
            >
              {children}
            </code>
          );
        }

        return <CodeBlock language={match[1]}>{String(children).replace(/\n$/, '')}</CodeBlock>;
      },
      p({ children }: { children?: React.ReactNode }) {
        return <p className="text-left">{renderChildrenWithFileLinks(children, 'p')}</p>;
      },
      li({ children }: { children?: React.ReactNode }) {
        return <li className="text-left">{renderChildrenWithFileLinks(children, 'li')}</li>;
      },
      table({ children }: { children?: React.ReactNode }) {
        return (
          <div className="overflow-x-auto my-3">
            <table className="min-w-full border-collapse">{children}</table>
          </div>
        );
      },
      th({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
        return (
          <th
            className="border border-border px-3 py-2 text-sm font-semibold text-text-primary bg-surface-muted"
            style={style}
          >
            {children}
          </th>
        );
      },
      td({ children, style }: { children?: React.ReactNode; style?: React.CSSProperties }) {
        return (
          <td className="border border-border px-3 py-2 text-sm text-text-primary" style={style}>
            {children}
          </td>
        );
      },
      input({ checked, ...props }: { checked?: boolean }) {
        return (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            className="mr-2 accent-accent"
            {...props}
          />
        );
      },
      strong({ children }: { children?: React.ReactNode }) {
        return <strong>{renderChildrenWithFileLinks(children, 'strong')}</strong>;
      },
      em({ children }: { children?: React.ReactNode }) {
        return <em>{renderChildrenWithFileLinks(children, 'em')}</em>;
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentWorkingDir, setGlobalNotice, t]
  );

  switch (block.type) {
    case 'text': {
      const textBlock = block as { type: 'text'; text: string };
      // 渲染链文本管线：先 Latex 规整、再 file:// markdown 链接规整。
      // %E8%A5%BF… 类 CJK 百分比编码的解码不放在这里做——它下沉到链接/
      // 文件按钮/产物面板的提取层，保证"同一文件名只认一个真实路径"，
      // 避免正文与候选项对不上造成重复链接。
      const text = textBlock.text || '';
      const normalizedText = normalizeCitationMarkdownLinks(
        normalizeLocalFileMarkdownLinks(normalizeLatexDelimiters(text))
      );
      const augmentedText = appendFolderOpenLinks(normalizedText, currentWorkingDir);

      if (!text) {
        return <span className="text-text-muted italic">{t('messageCard.emptyText')}</span>;
      }

      // Simple text display for user messages, Markdown for assistant
      // Non-user text blocks should render as normal assistant output, not as process-only content.
      if (isUser) {
        return (
          <p className="text-text-primary whitespace-pre-wrap break-words text-left">
            {text}
            {isStreaming && <span className="inline-block w-2 h-4 bg-accent ml-1 animate-pulse" />}
          </p>
        );
      }

      return (
        <PanelErrorBoundary
          name="MessageMarkdown"
          fallback={
            <div className="prose-chat max-w-none text-text-primary whitespace-pre-wrap break-words">
              {augmentedText}
            </div>
          }
        >
          <Suspense
            fallback={
              <div className="prose-chat max-w-none text-text-primary whitespace-pre-wrap break-words">
                {augmentedText}
              </div>
            }
          >
            <MessageMarkdown
              normalizedText={augmentedText}
              isStreaming={isStreaming}
              components={markdownComponents}
            />
          </Suspense>
        </PanelErrorBoundary>
      );
    }

    case 'image': {
      const imageBlock = block as {
        type: 'image';
        source: { type: 'base64'; media_type: string; data: string };
      };
      if (!imageBlock.source?.media_type || !imageBlock.source?.data) {
        return null;
      }
      const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
      if (!ALLOWED_IMAGE_TYPES.has(imageBlock.source.media_type)) {
        return null;
      }
      const { source } = imageBlock;
      const imageSrc = `data:${source.media_type};base64,${source.data}`;

      return (
        <div className={`${isUser ? 'inline-block' : ''}`}>
          <img
            src={imageSrc}
            alt={t('messageCard.pastedContentAlt')}
            className="w-full max-w-full rounded-lg border border-border"
            style={{ maxHeight: '600px', objectFit: 'contain' }}
          />
        </div>
      );
    }

    case 'file_attachment': {
      const fileBlock = block as FileAttachmentContent;

      return (
        <div className="flex max-w-full min-w-0 items-center gap-2 px-3 py-2 rounded-lg bg-[#eaf7fd] border border-[#79bfe0]/35 overflow-hidden">
          <FileText className="w-4 h-4 text-[#2f8bb8] flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-text-primary truncate">{fileBlock.filename}</p>
          </div>
        </div>
      );
    }

    case 'tool_use':
      return (
        <ToolUseBlock block={block as ToolUseContent} allBlocks={allBlocks} message={message} />
      );

    case 'tool_result':
      return (
        <ToolResultBlock
          block={block as ToolResultContent}
          allBlocks={allBlocks}
          message={message}
        />
      );

    case 'thinking':
      return (
        <ThinkingBlock block={block as { type: 'thinking'; thinking: string }} compact={false} />
      );

    default:
      return null;
  }
});
