import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => testRoot,
    isPackaged: false,
    getPath: (name: string) => {
      if (name === 'userData') return path.join(testRoot, 'userData');
      if (name === 'home') return path.join(testRoot, 'home');
      return testRoot;
    },
  },
}));

vi.mock('../../../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

const mockConfig = vi.hoisted(() => ({ globalSkillsPath: '' }));

vi.mock('../../../src/main/config/config-store', () => ({
  configStore: {
    get: vi.fn((key: string) => (key === 'globalSkillsPath' ? mockConfig.globalSkillsPath : '')),
  },
}));

import { SkillsRuntime } from '../../../src/main/claude/skills-runtime';

function makeSkillDir(root: string, name: string): string {
  const skillRoot = path.join(root, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `# ${name}`, 'utf8');
  return skillRoot;
}

/**
 * 全面安装制：SkillsRuntime 只准备目录并解析「全局技能目录启用项」路径。
 * 不再播种内置技能、不再导入 ~/.claude/skills、不再合并插件 skills 目录。
 */
describe('SkillsRuntime (全面安装制)', () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-runtime-test-'));
    fs.mkdirSync(path.join(testRoot, 'userData'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'home'), { recursive: true });
    mockConfig.globalSkillsPath = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  function createRuntime(overrides?: {
    skillsAdapter?: { getSkillPaths: () => string[] | Promise<string[]> };
  }): SkillsRuntime {
    return new SkillsRuntime({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsAdapter: overrides?.skillsAdapter as any,
    });
  }

  describe('ensureSetup / invalidate', () => {
    it('runs setup only once until invalidated', () => {
      const runtime = createRuntime();
      const spy = vi.spyOn(runtime, 'syncConfiguredSkillsToRuntimeDir');

      runtime.ensureSetup();
      runtime.ensureSetup();
      const callsAfterTwo = spy.mock.calls.length;
      expect(callsAfterTwo).toBe(1);

      runtime.invalidate();
      runtime.ensureSetup();
      expect(spy.mock.calls.length).toBeGreaterThan(callsAfterTwo);
    });

    it('creates app claude dirs without seeding any skill', () => {
      const runtime = createRuntime();

      runtime.ensureSetup();

      const appClaudeDir = path.join(testRoot, 'userData', 'claude');
      const appSkillsDir = path.join(appClaudeDir, 'skills');
      expect(fs.existsSync(appClaudeDir)).toBe(true);
      expect(fs.existsSync(appSkillsDir)).toBe(true);
      // 不预置任何技能：全新安装的运行时目录为空
      expect(fs.readdirSync(appSkillsDir)).toEqual([]);
    });

    it('does not seed skills from the bundled resources dir', () => {
      // 老版本会把捆绑技能 symlink 进运行时目录；全面安装制下不得发生
      const bundled = path.join(testRoot, 'app', '.claude', 'skills');
      makeSkillDir(bundled, 'alpha');
      const runtime = createRuntime();

      runtime.ensureSetup();

      const appSkillsDir = path.join(testRoot, 'userData', 'claude', 'skills');
      expect(fs.readdirSync(appSkillsDir)).toEqual([]);
    });

    it('does not import entries from ~/.claude/skills', () => {
      const userSkills = path.join(testRoot, 'home', '.claude', 'skills');
      makeSkillDir(userSkills, 'beta');
      const runtime = createRuntime();

      runtime.ensureSetup();

      const appSkillsDir = path.join(testRoot, 'userData', 'claude', 'skills');
      expect(fs.readdirSync(appSkillsDir)).toEqual([]);
    });

    it('preserves already-installed real directories', () => {
      const appSkillsDir = path.join(testRoot, 'userData', 'claude', 'skills');
      const existing = path.join(appSkillsDir, 'alpha');
      fs.mkdirSync(existing, { recursive: true });
      fs.writeFileSync(path.join(existing, 'KEEP.md'), 'mine', 'utf8');
      const runtime = createRuntime();

      runtime.ensureSetup();

      expect(fs.lstatSync(existing).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(existing, 'KEEP.md'))).toBe(true);
    });
  });

  describe('resolveSkillPaths', () => {
    it('uses the SkillsAdapter when provided and filters nonexistent paths', async () => {
      const realDir = makeSkillDir(testRoot, 'adapter-skill');
      const missingDir = path.join(testRoot, 'nope');
      const runtime = createRuntime({
        skillsAdapter: { getSkillPaths: () => [realDir, missingDir, ''] },
      });

      const paths = await runtime.resolveSkillPaths();

      expect(paths).toEqual([realDir]);
    });

    it('falls back to the configured global dir without an adapter', async () => {
      const configured = makeSkillDir(path.join(testRoot, 'configured-skills'), 'alpha');
      mockConfig.globalSkillsPath = path.dirname(configured);
      const runtime = createRuntime();

      const paths = await runtime.resolveSkillPaths();

      expect(paths).toEqual([path.dirname(configured)]);
    });

    it('never includes plugin runtime skills directories', async () => {
      const adapterDir = makeSkillDir(testRoot, 'adapter-skill');
      const pluginSkills = path.join(testRoot, 'plugin-runtime', 'skills');
      makeSkillDir(pluginSkills, 'plugin-skill');
      const runtime = createRuntime({
        skillsAdapter: { getSkillPaths: () => [adapterDir] },
      });

      const paths = await runtime.resolveSkillPaths('session-1');

      expect(paths).toEqual([adapterDir]);
      expect(paths).not.toContain(pluginSkills);
    });

    it('deduplicates repeated adapter paths', async () => {
      const realDir = makeSkillDir(testRoot, 'adapter-skill');
      const runtime = createRuntime({
        skillsAdapter: { getSkillPaths: () => [realDir, realDir] },
      });

      expect(await runtime.resolveSkillPaths()).toEqual([realDir]);
    });
  });

  describe('module boundaries (locked decision §3.7)', () => {
    it('is a single file, does not import SkillsManager internals', () => {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), 'src/main/claude/skills-runtime.ts'),
        'utf8'
      );
      expect(source).toContain('export class SkillsRuntime');
      // 不反向依赖配置层 SkillsManager；只通过 SkillsAdapter 接口拿路径
      expect(source).not.toContain("from '../skills/skills-manager'");
      expect(source).toContain("import type { SkillsAdapter } from '../skills/skills-adapter'");
      // 不建 claude/skills/ 目录
      expect(fs.existsSync(path.resolve(process.cwd(), 'src/main/claude/skills'))).toBe(false);
    });
  });
});
