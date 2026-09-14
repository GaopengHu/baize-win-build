/**
 * Regression tests for the artifact-link regex construction.
 *
 * Reproduced live: opening the "Idenote MCP验证" history session rendered a
 * blank pane. The panel error boundary had caught
 *   SyntaxError: Invalid regular expression:
 *   /[microservice-arch\.png]([^)]+)/: Range out of order in character class
 * thrown from `appendFolderOpenLinks`, which runs on every assistant text
 * block.
 *
 * Cause: the patterns were written inside template literals, where `\[` and
 * `\]` collapse to plain `[` `]` and `\b` is U+0008 (backspace). The intended
 * "literal [name](url)" pattern therefore compiled into a CHARACTER CLASS, and
 * any generated filename containing `-` formed an invalid range.
 */
import { describe, it, expect } from 'vitest';
import {
  appendFolderOpenLinks,
  extractGeneratedFilePaths,
} from '../../renderer/utils/artifact-links';

const CWD = '/tmp/workspace';

describe('appendFolderOpenLinks — regex safety', () => {
  it('does not throw for a generated filename containing a dash', () => {
    const text = '已生成 microservice-arch.png';
    expect(() => appendFolderOpenLinks(text, CWD)).not.toThrow();
  });

  it('links a dash-containing filename instead of crashing', () => {
    const out = appendFolderOpenLinks('已生成 microservice-arch.png', CWD);
    expect(out).toContain('[microservice-arch.png](file:///');
  });

  it('does not throw for other regex-special characters in filenames', () => {
    const names = [
      'report-final(v2).docx',
      'data+summary.xlsx',
      'a-b-c_d.e.png',
      '价格-明细-2026.pdf',
      'config{old}.txt',
      'slide^1.pptx',
    ];
    for (const name of names) {
      expect(() => appendFolderOpenLinks(`已生成 ${name}`, CWD), name).not.toThrow();
    }
  });

  it('treats [name](url) as a markdown link, not a character class', () => {
    const text = [
      '架构图如下：',
      '[microservice-arch.png](file:///tmp/workspace/microservice-arch.png)',
    ].join('\n');
    const out = appendFolderOpenLinks(text, CWD);
    // The prose line survives; the link line is normalised to the folder link.
    expect(out).toContain('架构图如下：');
    expect(out).toContain('[microservice-arch.png](file:///');
    expect(out.split('[microservice-arch.png](').length - 1).toBe(1);
  });

  it('keeps prose that merely mentions the filename', () => {
    // The replacement overwrites the WHOLE line, so a bare word-boundary match
    // would delete sentences. Only a line that is nothing but the filename is
    // converted.
    const text = '已生成 /tmp/workspace/report-final.docx\n这份 report-final.docx 包含三章内容。';
    const out = appendFolderOpenLinks(text, CWD);
    expect(out).toContain('这份 report-final.docx 包含三章内容。');
  });

  it('converts a standalone filename line into a folder link', () => {
    const text = '已生成 /tmp/workspace/report-final.docx\nreport-final.docx';
    const out = appendFolderOpenLinks(text, CWD);
    expect(out.split('[report-final.docx](file:///').length - 1).toBe(1);
  });

  it('returns text untouched when nothing was generated', () => {
    const text = '这段文字没有提到任何文件。';
    expect(appendFolderOpenLinks(text, CWD)).toBe(text);
  });
});

describe('extractGeneratedFilePaths', () => {
  it('finds dash-containing generated files', () => {
    const paths = extractGeneratedFilePaths('已生成 microservice-arch.png');
    expect(paths.some((p) => p.endsWith('microservice-arch.png'))).toBe(true);
  });
});
