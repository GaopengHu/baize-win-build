/**
 * Regression tests for SKILL.md frontmatter description parsing.
 *
 * Root cause fixed here: getSkillMetadata used a single-line regex
 * (description:\s*["']?([^"'\r\n]+)["']?) which captured only `>` for skills
 * whose SKILL.md declared the description as a YAML folded block scalar
 * (description: > followed by indented lines). The Skills settings panel then
 * showed an empty description for asr-transcribe while single-line skills
 * (data-visualization, contract-reviewer-zh) displayed fine.
 *
 * parseSkillDescription (in skills-manager.ts) now supports both forms. This
 * file mirrors its logic for unit testing — keep in sync with the source.
 */
import { describe, expect, it } from 'vitest';

function parseSkillDescription(frontMatter: string): string | null {
  const block = frontMatter.match(/description:\s*[>|][-+]*\s*\r?\n((?:[ \t]+.+\r?\n?)+)/);
  if (block?.[1]) {
    const folded = block[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ');
    if (folded) return folded;
  }
  const single = frontMatter.match(/description:\s*["']?([^"'\r\n]+)["']?/);
  if (single?.[1]) {
    const value = single[1].trim();
    if (value && value !== '>' && value !== '|') return value;
  }
  return null;
}

describe('parseSkillDescription', () => {
  it('parses YAML folded block scalar (> with indented lines)', () => {
    const fm = [
      'name: asr-transcribe',
      'description: >',
      '  录音/语音文件转写（ASR）skill，本地优先 + 云端兜底。把 m4a/mp3/wav',
      '  音轨等转写为带时间戳的文字稿（.srt/.vtt/.txt）。',
      'category: 通用办公',
    ].join('\n');
    expect(parseSkillDescription(fm)).toBe(
      '录音/语音文件转写（ASR）skill，本地优先 + 云端兜底。把 m4a/mp3/wav 音轨等转写为带时间戳的文字稿（.srt/.vtt/.txt）。'
    );
  });

  it('parses literal block scalar (| with indented lines)', () => {
    const fm = ['name: x', 'description: |', '  line one', '  line two'].join('\n');
    expect(parseSkillDescription(fm)).toBe('line one line two');
  });

  it('parses single-line description', () => {
    const fm =
      'description: 当用户要求绘制热力图/heatmap/数据可视化时，必须使用此技能。支持 matplotlib、seaborn 等库。';
    expect(parseSkillDescription(fm)).toBe(
      '当用户要求绘制热力图/heatmap/数据可视化时，必须使用此技能。支持 matplotlib、seaborn 等库。'
    );
  });

  it('parses quoted single-line description', () => {
    const fm = 'description: "Comprehensive document creation and editing."';
    expect(parseSkillDescription(fm)).toBe('Comprehensive document creation and editing.');
  });

  it('returns null when description is only the block marker (old bug)', () => {
    const fm = 'name: x\ndescription: >\n';
    expect(parseSkillDescription(fm)).toBeNull();
  });

  it('returns null when description is missing', () => {
    expect(parseSkillDescription('name: x\nversion: 1.0.0')).toBeNull();
  });
});
