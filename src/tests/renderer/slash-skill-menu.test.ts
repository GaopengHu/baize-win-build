/**
 * "/" 斜杠技能选择器纯逻辑测试（renderer）。
 *
 * 仓库惯例为逻辑级 vitest（无 @testing-library）——只覆盖
 * src/renderer/utils/slash-menu.ts 的三个纯函数；
 * hook / 组件行为由 Step 10 手动验证矩阵兜底。
 */
import { describe, expect, it } from 'vitest';
import { parseSlashQuery, filterSkills, buildSkillCommand } from '../../renderer/utils/slash-menu';
import type { Skill } from '../../renderer/types';

function makeSkill(name: string, description?: string): Skill {
  return {
    id: name,
    name,
    description,
    type: 'custom',
    enabled: true,
    createdAt: 0,
  };
}

describe('parseSlashQuery', () => {
  it('is inactive for empty input', () => {
    expect(parseSlashQuery('')).toEqual({ active: false, query: '' });
  });

  it('is active with empty query right after typing "/"', () => {
    expect(parseSlashQuery('/')).toEqual({ active: true, query: '' });
  });

  it('is active and strips the leading slash while typing the command token', () => {
    expect(parseSlashQuery('/sk')).toEqual({ active: true, query: 'sk' });
    expect(parseSlashQuery('/skill:foo')).toEqual({ active: true, query: 'skill:foo' });
  });

  it('deactivates once a space appears (rest is args)', () => {
    expect(parseSlashQuery('/skill:foo bar').active).toBe(false);
    expect(parseSlashQuery('/skill:foo ').active).toBe(false);
  });

  it('is inactive when "/" is not at position 0', () => {
    expect(parseSlashQuery('hello /sk')).toEqual({ active: false, query: '' });
    expect(parseSlashQuery('a /')).toEqual({ active: false, query: '' });
  });

  it('deactivates on newline (whitespace ends the command token)', () => {
    expect(parseSlashQuery('/a\nb').active).toBe(false);
    expect(parseSlashQuery('/a\tb').active).toBe(false);
  });
});

describe('filterSkills', () => {
  const skills = [
    makeSkill('pdf-summary', 'Summarize PDF documents'),
    makeSkill('translator', 'Translate text between languages'),
    makeSkill('deep-pdf-tools', 'Advanced pdf manipulation'),
    makeSkill('asr-transcribe', 'Speech to text'),
  ];

  it('returns all skills in order for an empty query (limit optional)', () => {
    expect(filterSkills(skills, '').map((s) => s.name)).toEqual([
      'pdf-summary',
      'translator',
      'deep-pdf-tools',
      'asr-transcribe',
    ]);
    expect(filterSkills(skills, '', 2)).toHaveLength(2);
  });

  it('ranks name-prefix above name-substring above description-substring', () => {
    // 'pdf': pdf-summary (prefix) > deep-pdf-tools (substring) — no desc matches left
    expect(filterSkills(skills, 'pdf').map((s) => s.name)).toEqual([
      'pdf-summary',
      'deep-pdf-tools',
    ]);
  });

  it('falls back to description matching', () => {
    expect(filterSkills(skills, 'speech').map((s) => s.name)).toEqual(['asr-transcribe']);
  });

  it('is case-insensitive', () => {
    expect(filterSkills(skills, 'PDF').map((s) => s.name)).toEqual([
      'pdf-summary',
      'deep-pdf-tools',
    ]);
    expect(filterSkills(skills, 'Translate TEXT').map((s) => s.name)).toEqual(['translator']);
  });

  it('keeps stable order within the same tier', () => {
    const many = [makeSkill('aa-one'), makeSkill('aa-two'), makeSkill('aa-three')];
    expect(filterSkills(many, 'aa').map((s) => s.name)).toEqual(['aa-one', 'aa-two', 'aa-three']);
  });

  it('returns ALL matches by default (no data-layer truncation)', () => {
    const many = Array.from({ length: 20 }, (_, i) => makeSkill(`skill-${i}`));
    expect(filterSkills(many, 'skill')).toHaveLength(20);
    expect(filterSkills(many, '')).toHaveLength(20);
  });

  it('honors an explicit limit when provided', () => {
    const many = Array.from({ length: 20 }, (_, i) => makeSkill(`skill-${i}`));
    expect(filterSkills(many, 'skill', 3)).toHaveLength(3);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterSkills(skills, 'zzz')).toEqual([]);
  });
});

describe('buildSkillCommand', () => {
  it('wraps the name with the /skill: prefix and a trailing space for args', () => {
    expect(buildSkillCommand('pdf-summary')).toBe('/skill:pdf-summary ');
  });
});
