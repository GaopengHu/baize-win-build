// Fenced code block with syntax highlighting (highlight.js), copy button, and HTML preview
import { useState, useMemo, memo } from 'react';
import { Copy, Check, Eye, X } from 'lucide-react';
import hljs from 'highlight.js';

// Sanitize highlight.js output - only allow highlight span tags
const sanitizeHighlight = (html: string): string =>
  html.replace(/<(?!\/?span(?:\s+class="hljs-[^"]*")?\s*\/?>)[^>]*>/g, (match) =>
    match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  );

interface CodeBlockProps {
  language: string;
  children: string;
}

export const CodeBlock = memo(function CodeBlock({ language, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const highlightedHtml = useMemo(() => {
    try {
      const lang = language.toLowerCase();
      let result: string;
      if (hljs.getLanguage(lang)) {
        result = hljs.highlight(children, { language: lang }).value;
      } else {
        result = hljs.highlightAuto(children).value;
      }
      return sanitizeHighlight(result);
    } catch {
      return null;
    }
  }, [children, language]);

  const isHtml = useMemo(() => {
    const lang = language.toLowerCase();
    return lang === 'html' || lang === 'htm';
  }, [language]);

  const blobUrl = useMemo(() => {
    if (!isHtml || !showPreview) return null;
    const blob = new Blob([children], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [isHtml, children, showPreview]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard write can fail if focus is lost or permission denied
    }
  };

  return (
    <div className="relative group my-3">
      <div className="absolute top-2 right-2 flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <span className="text-xs text-text-muted px-2 py-1 rounded bg-surface">{language}</span>
        {isHtml && (
          <button
            onClick={() => setShowPreview((v) => !v)}
            className="w-7 h-7 flex items-center justify-center rounded bg-surface hover:bg-surface-hover transition-colors"
            title="预览 HTML"
          >
            {showPreview ? (
              <X className="w-3.5 h-3.5 text-text-muted" />
            ) : (
              <Eye className="w-3.5 h-3.5 text-text-muted" />
            )}
          </button>
        )}
        <button
          onClick={handleCopy}
          className="w-7 h-7 flex items-center justify-center rounded bg-surface hover:bg-surface-hover transition-colors"
        >
          {copied ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5 text-text-muted" />
          )}
        </button>
      </div>
      {showPreview && isHtml && blobUrl ? (
        <div className="rounded-lg border border-border overflow-hidden bg-white" style={{ minHeight: '200px' }}>
          <iframe
            src={blobUrl}
            className="w-full"
            style={{ height: '400px', border: 'none' }}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            title="HTML Preview"
          />
        </div>
      ) : (
        <pre className="code-block">
          {highlightedHtml ? (
            <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
          ) : (
            <code>{children}</code>
          )}
        </pre>
      )}
    </div>
  );
});
