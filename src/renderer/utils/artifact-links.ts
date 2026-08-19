/**
 * Utilities for detecting and creating downloadable artifact links
 * from assistant message text.
 */

import { resolveArtifactPath } from './artifact-path';
import { extractFilePathCandidatesFromText, normalizeArtifactPathValue } from './tool-output-path';

const DOWNLOADABLE_EXTENSIONS = new Set([
  'pptx', 'ppt', 'key', 'keynote',
  'docx', 'doc', 'pdf',
  'xlsx', 'xls', 'csv', 'tsv',
  'txt', 'md', 'markdown', 'rtf', 'odt', 'ods', 'odp',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'mp3', 'wav', 'm4a', 'ogg',
  'mp4', 'mov', 'mkv', 'webm',
  'zip', 'rar', '7z', 'tar', 'gz',
]);

const FILE_GENERATED_PATTERNS = [
  /(?:文件|报告|文档|演示文稿|表格|幻灯片|PPT|Word|Excel|PDF|图片|视频|音频|压缩包)[：:\s]*([^\n\r]+?\.(?:pptx?|ppt|key|keynote|docx?|doc|pdf|xlsx?|xls|csv|tsv|txt|md|markdown|rtf|odt|ods|odp|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i,
  /(?:已生成|已创建|已保存|已写入|已导出|已完成|生成成功|创建成功|保存成功)[：:\s]*([^\n\r]+?\.(?:pptx?|ppt|key|keynote|docx?|doc|pdf|xlsx?|xls|csv|tsv|txt|md|markdown|rtf|odt|ods|odp|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i,
  /(?:下载链接|点击下载|下载地址)[：:\s]*([^\n\r]+?\.(?:pptx?|ppt|key|keynote|docx?|doc|pdf|xlsx?|xls|csv|tsv|txt|md|markdown|rtf|odt|ods|odp|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i,
];

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
 * Create a markdown download link for a file path.
 * Returns the markdown string with the download link.
 */
export function createDownloadLink(filePath: string, workingDir?: string | null): string {
  const resolved = resolveArtifactPath(filePath, workingDir);
  const displayName = resolved.split(/[/\\]/).pop() || resolved;
  const fileUrl = `file:///${encodeURI(resolved).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  return `[${displayName}](${fileUrl})`;
}

/**
 * Append download links to text that mentions generated files.
 * If the text already contains a link for the file, it won't be duplicated.
 */
export function appendDownloadLinks(text: string, workingDir?: string | null): string {
  const generatedFiles = extractGeneratedFilePaths(text);
  if (generatedFiles.length === 0) {
    return text;
  }

  let result = text;
  for (const filePath of generatedFiles) {
    const downloadLink = createDownloadLink(filePath, workingDir);
    const displayName = filePath.split('/').pop() || filePath;

    // Check if the file is already linked
    const escapedName = displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const alreadyLinked = new RegExp(`\[${escapedName}\]\([^\)]+\)`).test(result);
    if (alreadyLinked) {
      continue;
    }

    // Try to append after the file mention
    const fileMentionPattern = new RegExp(
      `(?:文件|报告|文档|演示文稿|表格|幻灯片|PPT|Word|Excel|PDF|图片|视频|音频|压缩包|已生成|已创建|已保存|已写入|已导出|已完成|生成成功|创建成功|保存成功|下载链接|点击下载|下载地址)[：:\\s]*${displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      'i'
    );

    if (fileMentionPattern.test(result)) {
      result = result.replace(fileMentionPattern, `可点击下载：${downloadLink}`);
    } else {
      // Append at the end if we can't find the mention
      result = `${result}\n\n可点击下载：${downloadLink}`;
    }
  }

  return result;
}
