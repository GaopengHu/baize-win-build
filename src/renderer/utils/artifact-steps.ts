import type { TraceStep, Message } from '../types';
import {
  extractFilePathCandidatesFromText,
  extractFilePathFromToolInput,
  extractFilePathFromToolOutput,
  normalizeArtifactPathValue,
} from './tool-output-path';

const FILE_TOOL_NAMES = new Set([
  'write_file',
  'edit_file',
  'Write',
  'Edit',
  'write',
  'edit',
  'NotebookEdit',
  'notebook_edit',
  'artifact',
]);

const FORMAT_KEYWORD_MAP: Array<{ keywords: string[]; extensions: string[] }> = [
  {
    keywords: ['pptx', '.ppt', 'powerpoint', '幻灯片', '演示文稿', 'ppt格式', 'ppt报告', '转成ppt', '转为ppt', '生成ppt'],
    extensions: ['ppt', 'pptx'],
  },
  {
    keywords: ['docx', '.doc', 'word文档', 'word格式', 'word报告', '转成word', '转为word', '生成word', 'word文件'],
    extensions: ['doc', 'docx'],
  },
  {
    keywords: ['xlsx', '.xls', 'excel', '电子表格', 'spreadsheet', 'excel格式', '转成excel', '转为excel', '生成excel'],
    extensions: ['xls', 'xlsx', 'csv'],
  },
  {
    keywords: ['.pdf', 'pdf格式', '转成pdf', '转为pdf', '生成pdf', 'pdf文件'],
    extensions: ['pdf'],
  },
  {
    keywords: ['.html', '.htm', 'html格式', '网页', 'web page', 'webpage', '转成html', '转为html', '生成html'],
    extensions: ['html', 'htm'],
  },
  {
    keywords: ['.txt', 'txt格式', '纯文本', 'text file', '转成txt', '转为txt', '生成txt'],
    extensions: ['txt'],
  },
  {
    keywords: ['.md', 'markdown', 'md格式', 'md文档', '转成md', '转为md'],
    extensions: ['md', 'markdown'],
  },
  {
    keywords: ['png格式', 'jpg格式', 'jpeg格式', '图片格式', '转成png', '转成jpg', '生成图片', 'image format'],
    extensions: ['png', 'jpg', 'jpeg'],
  },
  {
    keywords: ['mp3格式', '音频格式', '转成mp3', '生成音频', 'audio format'],
    extensions: ['mp3', 'wav', 'm4a', 'ogg'],
  },
  {
    keywords: ['mp4格式', '视频格式', '转成mp4', '生成视频', 'video format'],
    extensions: ['mp4', 'mov', 'mkv', 'webm'],
  },
  {
    keywords: ['zip格式', '压缩包', 'archive', '压缩文件', '转成zip'],
    extensions: ['zip', 'rar', '7z', 'tar', 'gz'],
  },
];

export function extractRequestedFormats(messages: Message[]): Set<string> {
  const result = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = getMessageText(msg);
    if (!text) continue;
    const lower = text.toLowerCase();
    for (const entry of FORMAT_KEYWORD_MAP) {
      for (const kw of entry.keywords) {
        if (lower.includes(kw.toLowerCase())) {
          for (const ext of entry.extensions) {
            result.add(ext);
          }
          break;
        }
      }
    }
  }
  return result;
}

function getMessageText(msg: Message): string {
  const content = msg.content as unknown;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join(' ');
}

function isReliablePathToolName(toolName: string | undefined): boolean {
  if (!toolName) {
    return false;
  }
  if (FILE_TOOL_NAMES.has(toolName)) {
    return true;
  }

  const normalized = toolName.trim().toLowerCase();
  return /(?:^|__|_)(?:screenshot|take_screenshot|capture_screenshot)(?:$|__|_)/.test(normalized);
}

function getFileExtension(pathValue: string): string {
  const normalized = pathValue.trim().replace(/\\/g, '/');
  const lastSegment = normalized.split('/').pop() || normalized;
  const lastDot = lastSegment.lastIndexOf('.');
  if (lastDot === -1 || lastDot === lastSegment.length - 1) {
    return '';
  }
  return lastSegment.slice(lastDot + 1).toLowerCase();
}

function getFileStem(pathValue: string): string {
  const normalized = pathValue.trim().replace(/\\/g, '/');
  const lastSegment = normalized.split('/').pop() || normalized;
  const lastDot = lastSegment.lastIndexOf('.');
  return lastDot === -1 ? lastSegment : lastSegment.slice(0, lastDot);
}

// Extensions that represent final deliverable files.
const FINAL_DELIVERABLE_EXTENSIONS = new Set([
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

// Patterns that indicate an automated/intermediate image (screenshots, renders, etc.).
const SIDECAR_IMAGE_STEM_PREFIX = /^(slide|slides|chart|preview|tmp|temp|render|page|sheet|screenshot|screen|capture|snap)[-_\d]/i;
const SIDECAR_IMAGE_STEM_SEGMENT = /(?:^|[-_])(slide|chart|preview|render|draft|temp|tmp|index|screenshot|screen|capture)(?:$|[-_])/i;
// Directories that are never deliverable output.
const TEMP_PATH_PATTERNS = [
  /(?:^|[/\\])tmp[/\\]/i,
  /(?:^|[/\\])\.tmp[/\\]/i,   // .tmp/ — session-manager copies attachments here
  /(?:^|[/\\])temp[/\\]/i,
  /AppData[/\\]Local[/\\]Temp/i,
  /node_modules[/\\]/i,
  /__pycache__[/\\]/i,
  /\.git[/\\]/i,
  /\.cowork-user-data[/\\]/i,
];

function isLikelySidecarArtifact(pathValue: string): boolean {
  const ext = getFileExtension(pathValue);
  const stem = getFileStem(pathValue).toLowerCase();
  const normalized = pathValue.trim().replace(/\\/g, '/');

  // Temp / tool-internal directories always win, regardless of extension.
  // (Previously checked last, so html/image files inside .tmp/ slipped through.)
  if (TEMP_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  // Intermediate render files (html previews for slides/charts).
  if (ext === 'html' || ext === 'htm') {
    return SIDECAR_IMAGE_STEM_PREFIX.test(stem)
      || SIDECAR_IMAGE_STEM_SEGMENT.test(stem);
  }

  // Automated screenshots / render outputs for images.
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'svg' || ext === 'webp') {
    return SIDECAR_IMAGE_STEM_PREFIX.test(stem)
      || SIDECAR_IMAGE_STEM_SEGMENT.test(stem);
  }

  return false;
}

// Keep only final deliverables, but do not collapse different file extensions.
// Example: .docx and .pptx should both remain visible if both exist.


export function shouldDisplayArtifactPath(pathValue: string): boolean {
  const ext = getFileExtension(pathValue);
  if (!ext) {
    return false;
  }

  if (!FINAL_DELIVERABLE_EXTENSIONS.has(ext)) {
    return false;
  }

  const trimmed = pathValue.trim();
  const normalized = trimmed.replace(/\\/g, '/');

  // A URL is not a local deliverable (e.g. https://host/README.md).
  if (normalized.includes('://') || /^www\./i.test(normalized)) {
    return false;
  }

  // Filenames that contain CJK punctuation are almost certainly false
  // positives from text scanning (e.g. "总结。docx").
  if (/[\u3000-\u303f]/.test(trimmed)) {
    return false;
  }

  // Office lock / editor temp files.
  const stem = getFileStem(trimmed);
  if (/^~\$/.test(stem) || /[~#]$/.test(stem)) {
    return false;
  }

  if (isLikelySidecarArtifact(trimmed)) {
    return false;
  }

  return true;
}

/**
 * Given all artifact candidates, return only the ones that should appear in
 * the right-side artifacts panel. Intermediate files (html, json, png, etc.)
 * are filtered out; all deliverable files (docx, pptx, xlsx, pdf, etc.) pass through.
 */
export function filterPrimaryArtifacts(
  paths: string[],
  _requestedFormats?: Set<string>
): string[] {
  // Remove obviously invalid paths (non-deliverable extensions, sidecars, etc.)
  return paths.filter((p) => shouldDisplayArtifactPath(p));
}

type ArtifactStepResult = {
  artifactSteps: TraceStep[];
  fileSteps: TraceStep[];
  displayArtifactSteps: TraceStep[];
};

type ArtifactCandidate = {
  path: string;
  source: 'step' | 'text';
  step?: TraceStep;
};

export function getArtifactLabel(pathValue: string, name?: string): string {
  const trimmedName = name?.trim();
  const trimmedPath = pathValue.trim();
  if (trimmedPath) {
    const normalized = trimmedPath.replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || trimmedPath;
  }

  return trimmedName ?? '';
}

export type ArtifactIconKey =
  | 'slides'
  | 'table'
  | 'doc'
  | 'code'
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'archive'
  | 'file';

export type ArtifactIconComponent =
  | 'presentation'
  | 'table'
  | 'document'
  | 'code'
  | 'image'
  | 'text'
  | 'audio'
  | 'video'
  | 'archive'
  | 'file';

const extensionIconMap: Record<string, ArtifactIconKey> = {
  pptx: 'slides',
  ppt: 'slides',
  key: 'slides',
  keynote: 'slides',
  xlsx: 'table',
  xls: 'table',
  csv: 'table',
  tsv: 'table',
  docx: 'doc',
  doc: 'doc',
  pdf: 'doc',
  md: 'code',
  markdown: 'code',
  js: 'code',
  jsx: 'code',
  ts: 'code',
  tsx: 'code',
  cts: 'code',
  mts: 'code',
  py: 'code',
  java: 'code',
  go: 'code',
  rs: 'code',
  c: 'code',
  cpp: 'code',
  h: 'code',
  hpp: 'code',
  css: 'code',
  scss: 'code',
  html: 'code',
  json: 'code',
  lock: 'code',
  yaml: 'code',
  yml: 'code',
  txt: 'text',
  log: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  mp4: 'video',
  mov: 'video',
  mkv: 'video',
  webm: 'video',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
};

export function getArtifactIconKey(filename: string): ArtifactIconKey {
  const normalized = filename.trim().toLowerCase();
  const lastDot = normalized.lastIndexOf('.');
  if (lastDot === -1 || lastDot === normalized.length - 1) {
    return 'file';
  }

  const ext = normalized.slice(lastDot + 1);
  return extensionIconMap[ext] ?? 'file';
}

export function getArtifactIconComponent(filename: string): ArtifactIconComponent {
  const key = getArtifactIconKey(filename);
  switch (key) {
    case 'slides':
      return 'presentation';
    case 'table':
      return 'table';
    case 'doc':
      return 'document';
    case 'code':
      return 'code';
    case 'image':
      return 'image';
    case 'audio':
      return 'audio';
    case 'video':
      return 'video';
    case 'archive':
      return 'archive';
    case 'text':
      return 'text';
    default:
      return 'file';
  }
}

function buildArtifactCandidateMap(
  steps: TraceStep[],
  messages?: Message[]
): Map<string, ArtifactCandidate> {
  const candidateMap = new Map<string, ArtifactCandidate>();

  const addCandidate = (path: string, source: ArtifactCandidate['source'], step?: TraceStep) => {
    const key = normalizeArtifactPathValue(path);
    if (!key) {
      return;
    }

    if (!candidateMap.has(key)) {
      candidateMap.set(key, { path: key, source, step });
    }
  };

  for (const step of steps) {
    if (step.status !== 'completed') {
      continue;
    }

    const pathFromOutput = extractFilePathFromToolOutput(step.toolOutput);
    const pathFromInput = extractFilePathFromToolInput(step.toolInput);

    if (isReliablePathToolName(step.toolName)) {
      if (pathFromOutput) {
        addCandidate(pathFromOutput, 'step', step);
      }
      if (pathFromInput) {
        addCandidate(pathFromInput, 'step', step);
      }
    }

    if (step.toolName === 'artifact' && step.toolOutput) {
      for (const candidate of extractFilePathCandidatesFromText(step.toolOutput)) {
        addCandidate(candidate, 'step', step);
      }
    }
  }

  // Last-resort scan of assistant messages embedded in trace-like text is intentionally
  // limited to concrete filename-like candidates to avoid false positives.
  if (messages && messages.length > 0) {
    for (const msg of messages) {
      if (msg.role !== 'assistant') {
        continue;
      }
      const text = getMessageText(msg);
      if (!text) {
        continue;
      }
      for (const candidate of extractFilePathCandidatesFromText(text)) {
        addCandidate(candidate, 'text');
      }
    }
  }

  return candidateMap;
}

export function collectArtifactPaths(steps: TraceStep[], messages?: Message[]): string[] {
  return Array.from(buildArtifactCandidateMap(steps, messages).values()).map((candidate) => candidate.path);
}

export function getArtifactSteps(
  steps: TraceStep[],
  messages?: Message[]
): ArtifactStepResult {
  const artifactSteps = steps.filter(
    (step) => step.type === 'tool_result' && step.toolName === 'artifact'
  );

  const candidateMap = buildArtifactCandidateMap(steps, messages);
  const fileSteps: TraceStep[] = [];
  const seenPaths = new Set<string>();

  for (const candidate of candidateMap.values()) {
    const key = candidate.path;
    if (seenPaths.has(key) || !shouldDisplayArtifactPath(key)) {
      continue;
    }
    seenPaths.add(key);
    if (candidate.step) {
      fileSteps.push(candidate.step);
    }
  }

  return {
    artifactSteps,
    fileSteps,
    displayArtifactSteps: fileSteps,
  };
}
