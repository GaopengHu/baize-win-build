import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Skill } from '@mariozechner/pi-coding-agent';
import { expandSkillCommand } from '../../main/claude/pipeline/skill-command';

/**
 * expandSkillCommand 单测（斜杠技能选择器主进程侧）。
 *
 * 格式一致性断言（case 8）的期望串逐字抄自 pi-coding-agent 0.60
 * agent-session.js:790（_expandSkillCommand）——SDK 升级导致格式漂移时
 * 该测试即红，提示同步修订 skill-command.ts。
 */

function makeSkill(name: string, dir: string, body: string, frontmatter?: string): Skill {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, 'SKILL.md');
  const content = frontmatter ? `---\n${frontmatter}\n---\n${body}` : body;
  fs.writeFileSync(filePath, content, 'utf-8');
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: skillDir,
    source: dir,
    disableModelInvocation: false,
  };
}

describe('expandSkillCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nowlink-skill-command-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns text unchanged when it does not start with /skill:', () => {
    const skills = [makeSkill('foo', tmpDir, 'body')];
    expect(expandSkillCommand('hello /skill:foo', skills)).toBe('hello /skill:foo');
    expect(expandSkillCommand('', skills)).toBe('');
    expect(expandSkillCommand('/skills:foo', skills)).toBe('/skills:foo');
  });

  it('expands /skill:foo without args, stripping frontmatter and trimming body', () => {
    const foo = makeSkill(
      'foo',
      tmpDir,
      '\n\nDo the foo thing.\n\n',
      'name: foo\ndescription: Foo skill'
    );
    const result = expandSkillCommand('/skill:foo', [foo]);
    expect(result).toBe(
      `<skill name="foo" location="${foo.filePath}">\n` +
        `References are relative to ${foo.baseDir}.\n\n` +
        'Do the foo thing.\n' +
        '</skill>'
    );
    expect(result).not.toContain('description: Foo skill');
  });

  it('appends trimmed args after the skill block', () => {
    const foo = makeSkill('foo', tmpDir, 'body');
    expect(expandSkillCommand('/skill:foo arg1 arg2', [foo])).toBe(
      `<skill name="foo" location="${foo.filePath}">\n` +
        `References are relative to ${foo.baseDir}.\n\n` +
        'body\n' +
        '</skill>\n\n' +
        'arg1 arg2'
    );
    // 多余空白 trim；args 内部空白保留
    const result = expandSkillCommand('/skill:foo   spaced  out  ', [foo]);
    expect(result.endsWith('</skill>\n\nspaced  out')).toBe(true);
  });

  it('passes unknown skill names through unchanged', () => {
    const foo = makeSkill('foo', tmpDir, 'body');
    expect(expandSkillCommand('/skill:unknown args', [foo])).toBe('/skill:unknown args');
    expect(expandSkillCommand('/skill:unknown', [])).toBe('/skill:unknown');
  });

  it('passes through without throwing when the skill file is unreadable', () => {
    const dangling: Skill = {
      name: 'ghost',
      description: 'gone',
      filePath: path.join(tmpDir, 'nonexistent', 'SKILL.md'),
      baseDir: path.join(tmpDir, 'nonexistent'),
      source: tmpDir,
      disableModelInvocation: false,
    };
    expect(expandSkillCommand('/skill:ghost args', [dangling])).toBe('/skill:ghost args');
  });

  it('uses first match when duplicate skill names exist', () => {
    const dirA = path.join(tmpDir, 'a');
    const dirB = path.join(tmpDir, 'b');
    const first = makeSkill('dup', dirA, 'first body');
    const second = makeSkill('dup', dirB, 'second body');
    const result = expandSkillCommand('/skill:dup', [first, second]);
    expect(result).toContain('first body');
    expect(result).toContain(`location="${first.filePath}"`);
    expect(result).not.toContain('second body');
  });

  it('treats newline as NOT a name/args separator (SDK parity)', () => {
    const foo = makeSkill('foo', tmpDir, 'body');
    // SDK 只按第一个空格分界：'/skill:foo\nargs' 的技能名是 'foo\nargs' → 未知 → 透传
    expect(expandSkillCommand('/skill:foo\nargs', [foo])).toBe('/skill:foo\nargs');
  });

  it('matches the exact SDK 0.60 output format (parity pin)', () => {
    // 期望串硬编码自 agent-session.js:790 —— SDK 格式漂移时此测试失败。
    const foo = makeSkill('parity', tmpDir, 'PARITY BODY');
    const result = expandSkillCommand('/skill:parity extra args', [foo]);
    const expected =
      `<skill name="parity" location="${foo.filePath}">\n` +
      `References are relative to ${foo.baseDir}.\n\n` +
      `PARITY BODY\n` +
      `</skill>\n\nextra args`;
    expect(result).toBe(expected);
  });

  it('does not filter on disableModelInvocation (explicit invocation is sanctioned)', () => {
    const restricted = makeSkill('restricted', tmpDir, 'restricted body');
    restricted.disableModelInvocation = true;
    const result = expandSkillCommand('/skill:restricted', [restricted]);
    expect(result).toContain('restricted body');
  });
});
