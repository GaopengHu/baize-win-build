import { describe, it, expect } from 'vitest';
import type { TraceStep, Message } from '../src/renderer/types';
import {
  shouldDisplayArtifactPath,
  extractRequestedFormats,
} from '../src/renderer/utils/artifact-steps';
import { computeConsumedPaths, pathToConsumedKey } from '../src/shared/consumed-paths';

const step = (over: Partial<TraceStep>): TraceStep => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  type: over.type ?? 'tool_call',
  status: over.status ?? 'completed',
  title: over.title ?? over.toolName ?? 'unknown',
  toolName: over.toolName,
  toolInput: over.toolInput,
  toolOutput: over.toolOutput,
  timestamp: over.timestamp ?? 0,
});

const userMsg = (text: string): Message => ({
  id: 'm',
  sessionId: 's',
  role: 'user',
  content: [{ type: 'text', text }],
  timestamp: 0,
});

describe('regression: 《》 and full-width brackets no longer killed', () => {
  it('《年度报告》.docx is displayable', () => {
    expect(shouldDisplayArtifactPath('/home/user/《年度报告》.docx')).toBe(true);
  });

  it('【要点】.md is displayable', () => {
    expect(shouldDisplayArtifactPath('/home/user/【要点】.md')).toBe(true);
  });

  it('（文件）.docx is displayable (full-width parens unwrapped)', () => {
    expect(shouldDisplayArtifactPath('（文件）.docx')).toBe(true);
  });

  it('「内文」.txt is displayable', () => {
    expect(shouldDisplayArtifactPath('/home/user/「内文」.txt')).toBe(true);
  });

  it('总结。docx still hidden (sentence punctuation kept)', () => {
    expect(shouldDisplayArtifactPath('总结。docx')).toBe(false);
  });
});

describe('regression: html/htm/json are now deliverable extensions', () => {
  it('report.html is displayable', () => {
    expect(shouldDisplayArtifactPath('/home/user/report.html')).toBe(true);
  });

  it('report.json is displayable', () => {
    expect(shouldDisplayArtifactPath('/home/user/report.json')).toBe(true);
  });

  it('page.htm is displayable', () => {
    expect(shouldDisplayArtifactPath('/home/user/page.htm')).toBe(true);
  });

  it('data.json is displayable when not consumed', () => {
    expect(shouldDisplayArtifactPath('/home/user/data.json')).toBe(true);
  });
});

describe('regression: html sidecar stem heuristic', () => {
  it('slide-1.html is hidden by default (sidecar)', () => {
    expect(shouldDisplayArtifactPath('/home/user/slide-1.html')).toBe(false);
  });

  it('chart.html is hidden by default (sidecar)', () => {
    expect(shouldDisplayArtifactPath('/home/user/chart.html')).toBe(false);
  });

  it('index.html is hidden by default (sidecar)', () => {
    expect(shouldDisplayArtifactPath('/home/user/index.html')).toBe(false);
  });

  it('index.html becomes displayable when user explicitly requested html', () => {
    const requested = new Set(['html', 'htm']);
    expect(
      shouldDisplayArtifactPath('/home/user/index.html', { requestedFormats: requested })
    ).toBe(true);
  });
});

describe('regression: consumption gate (L2)', () => {
  it('data.json produced then read by later bash is consumed', () => {
    const steps: TraceStep[] = [
      step({ toolName: 'Write', toolInput: { path: '/cwd/data.json', content: '{}' } }),
      step({
        toolName: 'Bash',
        toolInput: { command: 'python3 process.py /cwd/data.json > out.json' },
      }),
    ];
    const consumed = computeConsumedPaths(steps);
    expect(consumed.has(pathToConsumedKey('/cwd/data.json'))).toBe(true);
  });

  it('data.json produced and never referenced is NOT consumed', () => {
    const steps: TraceStep[] = [
      step({ toolName: 'Write', toolInput: { path: '/cwd/data.json', content: '{}' } }),
      step({ toolName: 'Bash', toolInput: { command: 'ls /cwd' } }),
    ];
    const consumed = computeConsumedPaths(steps);
    expect(consumed.has(pathToConsumedKey('/cwd/data.json'))).toBe(false);
  });

  it('data.json consumed → shouldDisplayArtifactPath returns false', () => {
    const consumed = new Set([pathToConsumedKey('/cwd/data.json')]);
    expect(shouldDisplayArtifactPath('/cwd/data.json', { consumedPaths: consumed })).toBe(false);
  });

  it('asymmetric rule: Write→Edit on same path is NOT consumption', () => {
    const steps: TraceStep[] = [
      step({ toolName: 'Write', toolInput: { path: '/cwd/note.md', content: 'a' } }),
      step({
        toolName: 'Edit',
        toolInput: { path: '/cwd/note.md', old_string: 'a', new_string: 'b' },
      }),
    ];
    const consumed = computeConsumedPaths(steps);
    expect(consumed.has(pathToConsumedKey('/cwd/note.md'))).toBe(false);
  });

  it('relative-path reference in bash command still counts as consumption', () => {
    const steps: TraceStep[] = [
      step({ toolName: 'Write', toolInput: { path: '/cwd/data.json', content: '{}' } }),
      step({ toolName: 'Bash', toolInput: { command: 'cat data.json | jq .' } }),
    ];
    const consumed = computeConsumedPaths(steps);
    expect(consumed.has(pathToConsumedKey('/cwd/data.json'))).toBe(true);
  });

  it('my_input.txt does NOT match input.txt (word boundary)', () => {
    const steps: TraceStep[] = [
      step({ toolName: 'Write', toolInput: { path: '/cwd/input.txt', content: '' } }),
      step({ toolName: 'Bash', toolInput: { command: 'cat my_input.txt' } }),
    ];
    const consumed = computeConsumedPaths(steps);
    expect(consumed.has(pathToConsumedKey('/cwd/input.txt'))).toBe(false);
  });

  it('input.txt does NOT match input.txt.bak (word boundary)', () => {
    const steps: TraceStep[] = [
      step({ toolName: 'Write', toolInput: { path: '/cwd/input.txt', content: '' } }),
      step({ toolName: 'Bash', toolInput: { command: 'cp input.txt.bak /tmp/' } }),
    ];
    const consumed = computeConsumedPaths(steps);
    expect(consumed.has(pathToConsumedKey('/cwd/input.txt'))).toBe(false);
  });

  it('case-insensitive absolute match', () => {
    const steps: TraceStep[] = [
      step({ toolName: 'Write', toolInput: { path: '/home/JDJT/Report.Docx' } }),
      step({ toolName: 'Bash', toolInput: { command: 'cp /home/jdjt/report.docx /tmp/' } }),
    ];
    const consumed = computeConsumedPaths(steps);
    expect(consumed.has(pathToConsumedKey('/home/JDJT/Report.Docx'))).toBe(true);
  });

  it('failed step is ignored', () => {
    const steps: TraceStep[] = [
      step({ toolName: 'Write', toolInput: { path: '/cwd/data.json', content: '{}' } }),
      step({ toolName: 'Bash', status: 'error', toolInput: { command: 'cat /cwd/data.json' } }),
    ];
    const consumed = computeConsumedPaths(steps);
    expect(consumed.has(pathToConsumedKey('/cwd/data.json'))).toBe(false);
  });
});

describe('regression: requested formats (L4 intent gate)', () => {
  it('"导出为 json" makes json a requested format', () => {
    const formats = extractRequestedFormats([userMsg('请把这份配置导出为 json 文件')]);
    expect(formats.has('json')).toBe(true);
  });

  it('"生成 html 报告" makes html a requested format', () => {
    const formats = extractRequestedFormats([userMsg('请帮我生成一个 html 报告')]);
    expect(formats.has('html')).toBe(true);
  });

  it('"docx" still works (regression guard)', () => {
    const formats = extractRequestedFormats([userMsg('请输出 docx 格式')]);
    expect(formats.has('docx')).toBe(true);
  });
});
