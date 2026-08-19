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
  return value
    .trim()
    .replace(/^[\s>*\-•`"']+/, '')
    .replace(/^[\[](.+)[\]]$/, '$1')
    .replace(/^\((.+)\)$/, '$1')
    .replace(/^\*\*(.+)\*\*$/, '$1')
    .replace(/[.,;:!?]+$/, '');
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
  while ((match = markdownLinkRegex.exec(trimmed)) !== null) {
    const href = match[2]?.trim();
    if (href) {
      candidates.add(normalizeArtifactPathValue(href));
    }
  }

  // Match file paths with Chinese filenames support.
  // Captures: optional drive letter + path separators + filename with known extension
  const pathLikeRegex = /(?:[A-Za-z]:[\\/]|[\\/][\w\u4e00-\u9fff\u3000-\u303f.\-_]+[\\/])*([\w\u4e00-\u9fff\u3000-\u303f.\-_]+\.(?:docx?|pptx?|xlsx?|pdf|txt|md|markdown|rtf|odt|ods|odp|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/giu;
  for (const found of trimmed.matchAll(pathLikeRegex)) {
    const value = found[0].trim();
    if (value) {
      candidates.add(normalizeArtifactPathValue(value));
    }
  }

  return Array.from(candidates);
}

export function extractFilePathFromToolInput(
  toolInput?: Record<string, unknown>
): string | null {
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
  const match = text.match(/File (?:written|edited):\s*(.+)$/i)
    || text.match(/File created successfully at:?\s*(.+)$/i)
    || text.match(/Successfully wrote \d+ bytes to ([^\r\n]+)/i)
    || text.match(/The file (.+?) has been updated(?: successfully)?(?:\.|$)/i)
    || text.match(/Saved screenshot to ([^\r\n]+)/i)
    // Chinese patterns: 文件已生成/已创建/已保存/已写入/路径
    || text.match(/(?:已生成|已创建|已保存|已写入|已导出|路径|保存到|生成到|输出到|写入到|创建到)[:：\s]*(.+?\.(?:docx?|pptx?|xlsx?|pdf|txt|md|markdown|rtf|odt|ods|odp|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i)
    || text.match(/(?:文件|报告|文档|演示文稿|表格|幻灯片)[:：\s]*(.+?\.(?:docx?|pptx?|xlsx?|pdf|txt|md|markdown|rtf|odt|ods|odp|png|jpe?g|gif|webp|svg|mp3|wav|m4a|ogg|mp4|mov|mkv|webm|zip|rar|7z|tar|gz))/i);
  if (!match || !match[1]) {
    return null;
  }

  return normalizeArtifactPathValue(match[1]);
}


