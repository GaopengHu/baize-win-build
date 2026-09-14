import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { TraceStep } from '../../renderer/types';

export type ArtifactInfo = {
  path: string;
  name?: string;
  type?: string;
};

export type ArtifactParseResult = {
  cleanText: string;
  artifacts: ArtifactInfo[];
};

const FINAL_ARTIFACT_EXTENSIONS = new Set([
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'csv',
  'txt',
  'md',
  'markdown',
  'pdf',
  'html',
  'htm',
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

function getArtifactExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return ext;
}

function isFinalArtifactPath(filePath: string): boolean {
  const ext = getArtifactExtension(filePath);
  return ext ? FINAL_ARTIFACT_EXTENSIONS.has(ext) : false;
}

export function extractArtifactsFromText(text: string): ArtifactParseResult {
  if (!text) {
    return { cleanText: text, artifacts: [] };
  }

  // Create a fresh regex instance each call to avoid lastIndex state issues
  // with the stateful global flag across successive calls.
  const artifactBlockRegex = /```artifact\s*([\s\S]*?)```/g;
  const artifacts: ArtifactInfo[] = [];
  const cleanText = text.replace(artifactBlockRegex, (_match, jsonText: string) => {
    try {
      const parsed = JSON.parse(jsonText.trim());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const record = item as Record<string, unknown>;
        const path = typeof record.path === 'string' ? record.path : '';
        if (!path) {
          continue;
        }
        const name = typeof record.name === 'string' ? record.name : undefined;
        const type = typeof record.type === 'string' ? record.type : undefined;
        artifacts.push({ path, name, type });
      }
    } catch {
      // 忽略无效的 JSON 块
    }
    return '';
  });

  return {
    cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trimEnd(),
    artifacts,
  };
}

export function buildArtifactTraceSteps(
  artifacts: ArtifactInfo[],
  now: () => number = () => Date.now(),
  nextId: () => string = () => uuidv4()
): TraceStep[] {
  return artifacts.map((artifact) => ({
    id: nextId(),
    type: 'tool_result',
    status: 'completed',
    title: 'artifact',
    toolName: 'artifact',
    toolOutput: JSON.stringify(artifact),
    timestamp: now(),
  }));
}

export function getPrimaryArtifact(artifacts: ArtifactInfo[]): ArtifactInfo | null {
  if (artifacts.length === 0) {
    return null;
  }

  const finalArtifacts = artifacts.filter((artifact) => isFinalArtifactPath(artifact.path));
  if (finalArtifacts.length === 1) {
    return finalArtifacts[0];
  }

  if (finalArtifacts.length > 1) {
    return finalArtifacts.reduce((best, current) => {
      const bestExt = getArtifactExtension(best.path);
      const currentExt = getArtifactExtension(current.path);
      const priorityOrder = ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'csv', 'pdf', 'txt', 'html', 'htm'];
      const bestScore = priorityOrder.indexOf(bestExt) === -1 ? 999 : priorityOrder.indexOf(bestExt);
      const currentScore = priorityOrder.indexOf(currentExt) === -1 ? 999 : priorityOrder.indexOf(currentExt);
      return currentScore < bestScore ? current : best;
    }, finalArtifacts[0]);
  }

  return artifacts[0] ?? null;
}

function getArtifactFriendlyLabel(filePath: string): string {
  const ext = getArtifactExtension(filePath);
  switch (ext) {
    case 'doc':
    case 'docx':
      return 'Word 文档';
    case 'ppt':
    case 'pptx':
      return 'PPT';
    case 'xls':
    case 'xlsx':
    case 'csv':
      return 'Excel 表格';
    case 'pdf':
      return 'PDF 文件';
    case 'txt':
      return '文本文件';
    case 'md':
    case 'markdown':
      return 'Markdown 文档';
    case 'html':
    case 'htm':
      return 'HTML 页面';
    default:
      return '文件';
  }
}

export function buildArtifactCompletionText(artifacts: ArtifactInfo[]): string | null {
  if (artifacts.length === 0) {
    return null;
  }

  const primary = getPrimaryArtifact(artifacts);
  if (!primary) {
    return null;
  }

  const label = getArtifactFriendlyLabel(primary.path);
  const displayName = primary.name?.trim() || path.basename(primary.path) || primary.path;
  return `${label}已生成，点击查看：[${displayName}](${primary.path})`;
}
