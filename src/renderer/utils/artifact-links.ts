/**
 * Utilities for detecting and creating artifact file links
 * from assistant message text. Links open the folder containing the file.
 */

import { resolveArtifactPath } from './artifact-path';
import { extractFilePathCandidatesFromText, normalizeArtifactPathValue } from './tool-output-path';

const DOWNLOADABLE_EXTENSIONS = new Set([
  'pptx',
  'ppt',
  'key',
  'keynote',
  'docx',
  'doc',
  'pdf',
  'xlsx',
  'xls',
  'csv',
  'tsv',
  'txt',
  'md',
  'markdown',
  'rtf',
  'odt',
  'ods',
  'odp',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'mp3',
  'wav',
  'm4a',
  'ogg',
  'mp4',
  'mov',
  'mkv',
  'webm',
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
]);

const FILE_GENERATED_PATTERNS = [
  /(?:文件|报告|文档|演示文稿|表格|幻灯片|PPT|Word|Excel|PDF|图片|视频|音频|压缩包)[：:\s]*([^\n\r]+?\.(?:pptx?|ppt|key|keynote|docx?|doc|pdf|xlsx?|xls|csv|tsv|txt|md|markdown|rtf|odt|ods|odp|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i,
  /(?:已生成|已创建|已保存|已写入|已导出|已完成|生成成功|创建成功|保存成功)[：:\s]*([^\n\r]+?\.(?:pptx?|ppt|key|keynote|docx?|doc|pdf|xlsx?|xls|csv|tsv|txt|md|markdown|rtf|odt|ods|odp|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i,
  /(?:下载链接|点击下载|下载地址)[：:\s]*([^\n\r]+?\.(?:pptx?|ppt|key|keynote|docx?|doc|pdf|xlsx?|xls|csv|tsv|txt|md|markdown|rtf|odt|ods|odp|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getBaseName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  return normalized.split('/').pop() || path;
}

/**
 * Extract file paths from text that indicate a file has been generated.
 * Returns the cleaned file paths.
 */
export function extractGeneratedFilePaths(text: string): string[] {
  const candidates = new Set<string>();

  for (const pattern of FILE_GENERATED_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const cleaned = normalizeArtifactPathValue(match[1]);
      if (cleaned && hasDownloadableExtension(cleaned)) {
        candidates.add(cleaned);
      }
    }
  }

  // Also try the generic path extractor as fallback
  for (const candidate of extractFilePathCandidatesFromText(text)) {
    const cleaned = normalizeArtifactPathValue(candidate);
    if (cleaned && hasDownloadableExtension(cleaned)) {
      candidates.add(cleaned);
    }
  }

  return Array.from(candidates);
}

function hasDownloadableExtension(path: string): boolean {
  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1 || lastDot === path.length - 1) {
    return false;
  }
  const ext = path.slice(lastDot + 1).toLowerCase();
  return DOWNLOADABLE_EXTENSIONS.has(ext);
}

/**
 * Create a markdown link for a file path that opens the containing folder.
 * Returns the markdown string with the file name as the link text.
 */
export function createFolderOpenLink(filePath: string, workingDir?: string | null): string {
  const resolved = resolveArtifactPath(filePath, workingDir);
  const displayName = getBaseName(resolved);
  // Use file:// URL so the markdown renderer can turn it into a clickable link.
  // The ContentBlockView will intercept file:// links and call showItemInFolder.
  const fileUrl = `file:///${encodeURI(resolved).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  return `[${displayName}](${fileUrl})`;
}

/**
 * Append folder-open links to text that mentions generated files.
 * Only the filename is shown; clicking it opens the folder containing the file.
 * If the same file is mentioned multiple times, only the first link is kept.
 */
export function appendFolderOpenLinks(text: string, workingDir?: string | null): string {
  const generatedFiles = extractGeneratedFilePaths(text);
  if (generatedFiles.length === 0) {
    return text;
  }

  const uniqueResolvedPaths = new Map<string, string>();
  for (const filePath of generatedFiles) {
    const resolved = normalizeArtifactPathValue(resolveArtifactPath(filePath, workingDir));
    if (!uniqueResolvedPaths.has(resolved)) {
      uniqueResolvedPaths.set(resolved, filePath);
    }
  }

  const lines = text.split(/\r?\n/);
  const outputLines: string[] = [...lines];
  const usedResolved = new Set<string>();

  for (const [resolvedPath, originalPath] of uniqueResolvedPaths.entries()) {
    if (usedResolved.has(resolvedPath)) continue;

    const folderLink = createFolderOpenLink(originalPath, workingDir);
    const displayName = getBaseName(resolvedPath);
    const escapedName = escapeRegExp(displayName);
    const escapedResolved = escapeRegExp(resolvedPath);

    let replacedFirst = false;
    for (let i = 0; i < outputLines.length; i += 1) {
      const line = outputLines[i] ?? '';
      if (!line.trim()) continue;

      // NOTE: these patterns must escape the backslashes for the RegExp
      // *source*. Inside a template literal `\[` collapses to `[` and `\b` is
      // U+0008 (backspace), so the previous version silently compiled
      // `[microservice-arch\.png]([^)]+)` — a CHARACTER CLASS whose `h-.`
      // range is invalid. Any generated filename containing `-` threw
      // "Range out of order in character class" while rendering a message,
      // which the panel error boundary turned into a blank conversation.
      const hasFilename = line.trim().toLowerCase() === displayName.toLowerCase();
      const hasResolvedPath = new RegExp(escapedResolved, 'i').test(line);
      const hasMarkdownLink = new RegExp(`\\[${escapedName}\\]\\([^)]+\\)`, 'i').test(line);

      if (!hasFilename && !hasResolvedPath && !hasMarkdownLink) {
        continue;
      }

      if (!replacedFirst) {
        // Replace the first matching line with the compact filename link.
        // This removes any raw path text on that line.
        outputLines[i] = folderLink;
        replacedFirst = true;
      } else {
        // Remove duplicate mentions of the same file.
        outputLines[i] = '';
      }
    }

    if (!replacedFirst) {
      outputLines.push(folderLink);
    }

    usedResolved.add(resolvedPath);
  }

  return outputLines.filter((line) => line.trim()).join('\n');
}
