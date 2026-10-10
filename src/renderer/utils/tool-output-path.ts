import { decodeCjkPercentEncoding, localPathFromFileUrl } from '../../shared/local-file-path';

type ParsedOutput = {
  path?: string;
  filePath?: string;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

type ParsedInput = {
  path?: string;
  filePath?: string;
  file_path?: string;
  relativePath?: string;
};

export function normalizeArtifactPathValue(value: string): string {
  // file:// URLs from model output are decoded to plain local paths so the
  // artifacts panel and file buttons show the real Chinese filename.
  let decoded = value.trim();
  if (/^file:\/\//i.test(decoded)) {
    decoded = localPathFromFileUrl(decoded) ?? decoded;
  }
  decoded = decodeCjkPercentEncoding(decoded)
    .replace(/^[\s>*\-•`"']+/, '')
    // ASCII wrappers
    .replace(/^\[(.+)\]$/, '$1')
    .replace(/^\((.+)\)$/, '$1')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    // Full-width paired wrappers commonly used around Chinese filenames
    // (《报告》,【要点】,（文件）,「内文」,『引用』). Strip when they wrap
    // the entire value so the inner filename becomes the candidate.
    .replace(/^《(.+)》$/, '$1')
    .replace(/^【(.+)】$/, '$1')
    .replace(/^（(.+)）$/, '$1')
    .replace(/^「(.+)」$/, '$1')
    .replace(/^『(.+)』$/, '$1')
    .replace(/^〈(.+)〉$/, '$1')
    .replace(/^〔(.+)〕$/, '$1')
    .replace(/^〖(.+)〗$/, '$1')
    .replace(/^［(.+)］$/, '$1')
    .replace(/[.,;:!?]+$/, '');
  return decoded;
}

/**
 * Determine whether a match sits inside a URL token (e.g. https://host/a/b.md).
 * We look at the text before the match: if the nearest `://` appears after the
 * nearest whitespace/CJK punctuation boundary, the match belongs to a URL.
 */
function isInsideUrlToken(text: string, matchIndex: number, matchLength: number): boolean {
  const before = text.slice(0, matchIndex);
  // The regex can start a match mid-URL (e.g. at the second slash of `://`),
  // in which case the scheme separator is cut in half right before the match.
  if (text.slice(Math.max(0, matchIndex - 2), matchIndex) === ':/') {
    return true;
  }
  const schemeIdx = before.lastIndexOf('://');
  if (schemeIdx === -1) {
    return false;
  }
  const boundaryChars = [
    ' ',
    '\n',
    '\r',
    '\t',
    '，',
    '。',
    '、',
    '；',
    '：',
    '（',
    '）',
    '【',
    '】',
  ];
  let lastBoundary = -1;
  for (const ch of boundaryChars) {
    const idx = before.lastIndexOf(ch);
    if (idx > lastBoundary) {
      lastBoundary = idx;
    }
  }
  // A trailing `)` / `>` / quote directly attached to the match also suggests a URL/link.
  const after = text.slice(matchIndex + matchLength, matchIndex + matchLength + 1);
  if (after === ')' || after === '>' || after === '"' || after === "'") {
    return schemeIdx > lastBoundary;
  }
  return schemeIdx > lastBoundary;
}

export function extractFilePathFromToolOutput(toolOutput?: string): string | null {
  if (!toolOutput) {
    return null;
  }

  const trimmed = toolOutput.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as ParsedOutput;
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.filePath === 'string' && parsed.filePath.trim()) {
        return parsed.filePath.trim();
      }
      if (typeof parsed.path === 'string' && parsed.path.trim()) {
        return parsed.path.trim();
      }
      if (Array.isArray(parsed.content)) {
        const textContent = parsed.content
          .map((item) => (item && typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n');
        const nestedPath = extractFilePathFromText(textContent);
        if (nestedPath) {
          return nestedPath;
        }
      }
    }
  } catch {
    // ignore JSON parse failures
  }

  return extractFilePathFromText(trimmed);
}

export function extractFilePathCandidatesFromText(text: string): string[] {
  const candidates = new Set<string>();
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  const direct = extractFilePathFromText(trimmed);
  if (direct) {
    candidates.add(direct);
  }

  const markdownLinkRegex = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  const trimmedForLinks = decodeCjkPercentEncoding(trimmed);
  while ((match = markdownLinkRegex.exec(trimmedForLinks)) !== null) {
    const href = match[2]?.trim();
    if (href) {
      candidates.add(normalizeArtifactPathValue(href));
    }
  }

  // Match local file paths with Chinese filenames support.
  // file:// URLs are decoded to plain paths FIRST so downstream consumers
  // always see real filenames (never `…%E8%A5%BF…`). URLs on remote schemes
  // (https://host/README.md) are skipped by isInsideUrlToken.
  const decodedForScan = /file:\/\//i.test(trimmed) ? decodeCjkPercentEncoding(trimmed) : trimmed;
  // Captures: optional root (drive letter or POSIX leading slash) + chained path
  // segments + filename with known extension. Each segment consumes its OWN
  // trailing separator so multi-segment paths match in full — the previous
  // pattern `[\\/][\w...]+[\\/]` swallowed the next segment's leading separator
  // and only ever captured path tails (broke the artifacts panel on Windows).
  // NOTE: filename charset intentionally excludes CJK punctuation (U+3000-303F) so
  // things like "总结。docx" or "要点、png" are never treated as files.
  // ASCII brackets/parens ARE included: real-world filenames often contain
  // them (e.g. "西直门外大街136号1(1).docx", "report[final].pdf"). A match that
  // merely wraps a path in outer parens ("(C:\out\a.docx)") is unwrapped by
  // normalizeArtifactPathValue, so including them nets far more true positives
  // than false ones.
  const pathLikeRegex =
    /(?:[A-Za-z]:[\\/]|\/)?(?:[\]\w\u4e00-\u9fff.\-_()《》〈〉「」『』【】〔〕〖〗（）［］]+[\\/])*[\]\w\u4e00-\u9fff.\-_()《》〈〉「」『』【】〔〕〖〗（）［］]+\.(?:docx?|pptx?|xlsx?|pdf|txt|md|markdown|rtf|odt|ods|odp|srt|vtt|html?|json|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz)/giu;
  for (const found of decodedForScan.matchAll(pathLikeRegex)) {
    const index = typeof found.index === 'number' ? found.index : -1;
    // Skip matches that live inside a URL token (e.g. https://host/README.md),
    // otherwise URLs would produce phantom artifacts.
    if (index >= 0 && isInsideUrlToken(decodedForScan, index, found[0].length)) {
      continue;
    }
    const value = found[0].trim();
    if (value) {
      candidates.add(normalizeArtifactPathValue(value));
    }
  }

  return Array.from(candidates);
}

export function extractFilePathFromToolInput(toolInput?: Record<string, unknown>): string | null {
  if (!toolInput || typeof toolInput !== 'object') {
    return null;
  }

  const input = toolInput as ParsedInput;
  const candidates = [input.path, input.filePath, input.file_path, input.relativePath];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractFilePathFromText(text: string): string | null {
  const match =
    text.match(/File (?:written|edited):\s*(.+)$/i) ||
    text.match(/File created successfully at:?\s*(.+)$/i) ||
    text.match(/Successfully wrote \d+ bytes to ([^\r\n]+)/i) ||
    text.match(/The file (.+?) has been updated(?: successfully)?(?:\.|$)/i) ||
    text.match(/Saved screenshot to ([^\r\n]+)/i) ||
    // Chinese patterns: 文件已生成/已创建/已保存/已写入/路径
    // NOTE: 分隔符只认 [:：] 和空白，不认括号 —— 正文里
    // "交付文件（已收到…）" 这种“文件（…”不能误命中。路径必须紧跟分隔符。
    text.match(
      /(?:已生成|已创建|已保存|已写入|已导出|保存到|生成到|输出到|写入到|创建到)\s*[:：]?\s*(.+?\.(?:docx?|pptx?|xlsx?|pdf|txt|md|markdown|rtf|odt|ods|odp|srt|vtt|html?|json|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i
    ) ||
    text.match(
      /(?:文件|报告|文档|演示文稿|表格|幻灯片)\s*[:：]\s*(.+?\.(?:docx?|pptx?|xlsx?|pdf|txt|md|markdown|rtf|odt|ods|odp|srt|vtt|html?|json|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i
    );
  if (!match || !match[1]) {
    return null;
  }

  return normalizeArtifactPathValue(match[1]);
}
