/**
 * Regression tests for the artifacts pipeline path extraction.
 *
 * Root cause fixed here: the old pathLikeRegex in tool-output-path.ts was
 * built as a per-segment alternation that consumed the NEXT segment's leading
 * separator, so multi-segment paths like
 * C:\Users\x\asr-output\meeting.srt only ever matched their tail
 * (\asr-output\meeting.srt). The artifacts panel resolved the truncated path,
 * fs.existsSync failed, and the panel stayed empty (no clickable links).
 *
 * The fixed pattern chains segments so the full path matches in one go;
 * .srt/.vtt (ASR deliverables) were also added to all extension allowlists.
 */
import { describe, expect, it } from 'vitest';
import { extractFilePathCandidatesFromText } from '../../renderer/utils/tool-output-path';

describe('extractFilePathCandidatesFromText (artifact pipeline)', () => {
  it('captures full multi-segment Windows absolute path (srt)', () => {
    const abs =
      'C:\\Users\\lenovo\\AppData\\Roaming\\今点通\\default_working_dir\\asr-output\\录音-20260805-1630.srt';
    const got = extractFilePathCandidatesFromText(`[asr] 已生成：${abs}`);
    expect(got.map((g) => g.toLowerCase())).toContain(abs.toLowerCase());
  });

  it('captures full multi-segment POSIX absolute path (txt)', () => {
    const abs = '/home/user/ws/asr-output/meeting.txt';
    const got = extractFilePathCandidatesFromText(`已生成：${abs}`);
    expect(got).toContain(abs);
  });

  it('captures relative output paths', () => {
    const got = extractFilePathCandidatesFromText('写入到 outputs\\a.srt');
    expect(got.map((g) => g.toLowerCase())).toContain('outputs\\a.srt');
  });

  it('captures vtt deliverables', () => {
    const abs = 'C:\\ws\\out\\字幕.vtt';
    const got = extractFilePathCandidatesFromText(`已生成：${abs}`);
    expect(got.map((g) => g.toLowerCase())).toContain(abs.toLowerCase());
  });

  it('does not capture URLs', () => {
    const got = extractFilePathCandidatesFromText('见 https://example.com/README.md 说明');
    expect(got).toHaveLength(0);
  });

  it('does not capture URLs even when the match starts at the scheme slashes', () => {
    const got = extractFilePathCandidatesFromText('配置见 https://example.com/path/to/config.json 文档');
    expect(got).toHaveLength(0);
  });

  it('captures real files that appear after a URL in the same text', () => {
    const abs = 'D:\\workspace\\report.docx';
    const got = extractFilePathCandidatesFromText(`参考 https://example.com/guide.md，报告在 ${abs}`);
    expect(got.map((g) => g.toLowerCase())).toContain(abs.toLowerCase());
  });
});
