export type FileTextPart = { type: 'text'; value: string } | { type: 'file'; value: string };
export type FileChildPart = FileTextPart | { type: 'node'; value: unknown };

import { decodeCjkPercentEncoding } from '../../shared/local-file-path';

const fileLinkButtonClassName =
  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#79bfe0]/35 bg-[#eaf7fd] text-[#2f8bb8] hover:bg-[#dff3fb] hover:border-[#5daed6] hover:text-[#237aa7] transition-colors text-left break-all shadow-sm';

export function getFileLinkButtonClassName(): string {
  return fileLinkButtonClassName;
}

const boundaryPattern = /[\s`'"\][(){}.<>”’””’’#,，、:;!?：；&]/;
const mixedFilenamePattern = /[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9._-]*\.[A-Za-z0-9]{1,8}/gu;
const pathPattern = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]+?\.[a-z0-9]{1,8}/gi;

function isBoundaryChar(ch?: string): boolean {
  if (!ch) return true;
  return boundaryPattern.test(ch);
}

function tokenHasUrlPrefix(text: string, index: number): boolean {
  const tokenStart = text.lastIndexOf(' ', index) + 1;
  const token = text.slice(tokenStart, index);
  return /(?:https?:\/\/|file:\/\/|mailto:)/i.test(token);
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[\][`'"(){}.<>”’””’’#,，、:;!?：；&]+$/g, '');
}

function extensionHasLetter(value: string): boolean {
  const lastDot = value.lastIndexOf('.');
  if (lastDot === -1 || lastDot === value.length - 1) {
    return false;
  }
  const ext = value.slice(lastDot + 1);
  return /[a-z]/i.test(ext);
}

export function splitTextByFileMentions(text: string): FileTextPart[] {
  // Model output often contains file:// URLs or percent-encoded Chinese
  // filenames (%E8%A5%BF...docx). Decode CJK-bearing percent runs first so the
  // extractor sees (and emits) the real filename instead of mojibake.
  const decoded = decodeCjkPercentEncoding(text);
  if (!decoded) {
    return [{ type: 'text', value: '' }];
  }

  const parts: FileTextPart[] = [];
  let cursor = 0;
  const matches: Array<{ index: number; value: string }> = [];

  for (const match of decoded.matchAll(pathPattern)) {
    if (match.index === undefined) continue;
    matches.push({ index: match.index, value: match[0] });
  }

  for (const match of decoded.matchAll(mixedFilenamePattern)) {
    if (match.index === undefined) continue;
    matches.push({ index: match.index, value: match[0] });
  }

  matches.sort((a, b) => a.index - b.index);

  for (const match of matches) {
    let value = match.value;
    const index = match.index;

    // Skip matches that overlap with already-emitted content
    if (index < cursor) continue;

    value = trimTrailingPunctuation(value);
    const prev = decoded[index - 1];
    const next = decoded[index + value.length];

    if (!isBoundaryChar(prev) || !isBoundaryChar(next)) {
      continue;
    }

    if (tokenHasUrlPrefix(decoded, index)) {
      continue;
    }

    if (!extensionHasLetter(value)) {
      continue;
    }

    if (index > cursor) {
      parts.push({ type: 'text', value: decoded.slice(cursor, index) });
    }

    parts.push({ type: 'file', value });
    cursor = index + value.length;
  }

  if (cursor < decoded.length) {
    parts.push({ type: 'text', value: decoded.slice(cursor) });
  }

  if (parts.length === 0) {
    parts.push({ type: 'text', value: decoded });
  }

  return parts;
}

export function splitChildrenByFileMentions(children: Array<unknown>): FileChildPart[] {
  const parts: FileChildPart[] = [];

  for (const child of children) {
    if (typeof child === 'string') {
      const childParts = splitTextByFileMentions(child);
      parts.push(...childParts);
      continue;
    }

    if (child === null || child === undefined || child === false) {
      continue;
    }

    parts.push({ type: 'node', value: child });
  }

  if (parts.length === 0) {
    parts.push({ type: 'text', value: '' });
  }

  return parts;
}
