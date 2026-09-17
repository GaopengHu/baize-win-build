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

vi.mock('../../../src/main/config/config-store', () => ({
  configStore: {
    get: vi.fn(() => ''),
  },
}));

import { SkillsRuntime } from '../../../src/main/claude/skills-runtime';
import type { ServerEvent } from '../../../src/renderer/types';

function makeSkillDir(root: string, name: string): string {
  const skillRoot = path.join(root, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `# ${name}`, 'utf8');
  return skillRoot;
}

describe('SkillsRuntime (Phase 2, AGENT-RUNNER-REFACTOR-PLAN.md §3.7)', () => {
  let builtinRoot: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-runtime-test-'));
    fs.mkdirSync(path.join(testRoot, 'userData'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'home'), { recursive: true });
    builtinRoot = path.join(testRoot, 'builtin-skills');
    fs.mkdirSync(builtinRoot, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  function createRuntime(overrides?: {
    sendToRenderer?: (event: ServerEvent) => void;
    skillsAdapter?: { getSkillPaths: () => string[] | Promise<string[]> };
    pluginRuntimeService?: unknown;
  }): SkillsRuntime {
    const runtime = new SkillsRuntime({
      sendToRenderer: overrides?.sendToRenderer ?? vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pluginRuntimeService: overrides?.pluginRuntimeService as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skillsAdapter: overrides?.skillsAdapter as any,
    });
    // 固定 built-in 路径，隔离 __dirname/asar 探测逻辑（那部分依赖真实打包布局）
    vi.spyOn(runtime, 'getBuiltinSkillsPath').mockReturnValue(builtinRoot);
    return runtime;
  }

  describe('ensureSetup / invalidate', () => {
    it('runs setup only once until invalidated', () => {
      makeSkillDir(builtinRoot, 'alpha');
      const runtime = createRuntime();
      const spy = vi.spyOn(runtime, 'getBuiltinSkillsPath');

      runtime.ensureSetup();
      runtime.ensureSetup();
      const callsAfterTwo = spy.mock.calls.length;

      runtime.invalidate();
      runtime.ensureSetup();
      expect(spy.mock.calls.length).toBeGreaterThan(callsAfterTwo);
    });

    it('creates app claude dirs and links built-in skills into runtime dir', () => {
      makeSkillDir(builtinRoot, 'alpha');
      const runtime = createRuntime();

      runtime.ensureSetup();

      const appClaudeDir = path.join(testRoot, 'userData', 'claude');
      const appSkillsDir = path.join(appClaudeDir, 'skills');
      expect(fs.existsSync(appClaudeDir)).toBe(true);
      expect(fs.existsSync(appSkillsDir)).toBe(true);

      const linked = path.join(appSkillsDir, 'alpha');
      expect(fs.existsSync(linked)).toBe(true);
      // 非 asar 源应为 symlink（空间效率），与迁移前行为一致
      expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    });

    it('does not overwrite an existing real directory skill', () => {
      makeSkillDir(builtinRoot, 'alpha');
      const runtime = createRuntime();
      const appSkillsDir = path.join(testRoot, 'userData', 'claude', 'skills');
      fs.mkdirSync(appSkillsDir, { recursive: true });
      const existing = path.join(appSkillsDir, 'alpha');
      fs.mkdirSync(existing, { recursive: true });
      fs.writeFileSync(path.join(existing, 'KEEP.md'), 'mine', 'utf8');

      runtime.ensureSetup();

      expect(fs.lstatSync(existing).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(existing, 'KEEP.md'))).toBe(true);
    });

    it('removes broken asar symlinks left by previous versions', () => {
      makeSkillDir(builtinRoot, 'alpha');
      const runtime = createRuntime();
      const appSkillsDir = path.join(testRoot, 'userData', 'claude', 'skills');
      fs.mkdirSync(appSkillsDir, { recursive: true });
      const stale = path.join(appSkillsDir, 'alpha');
      fs.symlinkSync(path.join(testRoot, 'app.asar', '.claude', 'skills', 'alpha'), stale, 'dir');

      runtime.ensureSetup();

      // 旧 asar symlink 被清掉，替换为指向真实 builtin 目录的新链接
      expect(fs.lstatSync(stale).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(stale)).toBe(path.join(builtinRoot, 'alpha'));
    });
  });

  describe('syncUserSkillsToAppDir', () => {
    it('imports user ~/.claude/skills entries as symlinks', () => {
      const runtime = createRuntime();
      const userSkills = path.join(testRoot, 'home', '.claude', 'skills');
      makeSkillDir(userSkills, 'beta');
      const appSkillsDir = path.join(testRoot, 'userData', 'claude', 'skills');
      fs.mkdirSync(appSkillsDir, { recursive: true });

      runtime.syncUserSkillsToAppDir(appSkillsDir);

      const target = path.join(appSkillsDir, 'beta');
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(target)).toBe(path.join(userSkills, 'beta'));
    });

    it('leaves existing real directories untouched', () => {
      const runtime = createRuntime();
      const userSkills = path.join(testRoot, 'home', '.claude', 'skills');
      makeSkillDir(userSkills, 'beta');
      const appSkillsDir = path.join(testRoot, 'userData', 'claude', 'skills');
      const target = path.join(appSkillsDir, 'beta');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'KEEP.md'), 'mine', 'utf8');

      runtime.syncUserSkillsToAppDir(appSkillsDir);

      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(target, 'KEEP.md'))).toBe(true);
    });

    it('is a no-op when the user skills dir does not exist', () => {
      const runtime = createRuntime();
      const appSkillsDir = path.join(testRoot, 'userData', 'claude', 'skills');
      fs.mkdirSync(appSkillsDir, { recursive: true });

      expect(() => runtime.syncUserSkillsToAppDir(appSkillsDir)).not.toThrow();
      expect(fs.readdirSync(appSkillsDir)).toEqual([]);
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

    it('falls back to legacy builtin + configured global paths without an adapter', async () => {
      makeSkillDir(builtinRoot, 'alpha');
      const runtime = createRuntime();
      runtime.ensureSetup();

      const paths = await runtime.resolveSkillPaths();

      // legacy = builtin（存在）+ getConfiguredGlobalSkillsDir()（未配置 → runtime skills dir）
      expect(paths).toContain(builtinRoot);
      expect(paths).toContain(runtime.getRuntimeSkillsDir());
    });

    it('merges enabled runtime plugin skills and notifies the renderer', async () => {
      const adapterDir = makeSkillDir(testRoot, 'adapter-skill');
      const pluginSkills = path.join(testRoot, 'plugin-runtime', 'skills');
      makeSkillDir(pluginSkills, 'plugin-skill');
      const events: ServerEvent[] = [];
      const runtime = createRuntime({
        sendToRenderer: (event) => events.push(event),
        skillsAdapter: { getSkillPaths: () => [adapterDir] },
        pluginRuntimeService: {
          getEnabledRuntimePlugins: async () => [
            {
              name: 'test-plugin',
              runtimePath: path.join(testRoot, 'plugin-runtime'),
              componentsEnabled: { skills: true },
              componentCounts: { skills: 1 },
            },
          ],
        },
      });

      const paths = await runtime.resolveSkillPaths('session-1');

      expect(paths).toContain(adapterDir);
      expect(paths).toContain(pluginSkills);
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('plugins.runtimeApplied');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload = (events[0] as any).payload;
      expect(payload.sessionId).toBe('session-1');
      expect(payload.plugins).toEqual([{ name: 'test-plugin', path: pluginSkills }]);
    });

    it('skips plugins without skills and survives plugin service errors', async () => {
      const adapterDir = makeSkillDir(testRoot, 'adapter-skill');
      const runtime = createRuntime({
        skillsAdapter: { getSkillPaths: () => [adapterDir] },
        pluginRuntimeService: {
          getEnabledRuntimePlugins: async () => {
            throw new Error('boom');
          },
        },
      });

      const paths = await runtime.resolveSkillPaths('session-1');

      expect(paths).toEqual([adapterDir]);
    });

    it('does not emit runtimeApplied without a sessionId', async () => {
      const pluginSkills = path.join(testRoot, 'plugin-runtime', 'skills');
      makeSkillDir(pluginSkills, 'plugin-skill');
      const events: ServerEvent[] = [];
      const runtime = createRuntime({
        sendToRenderer: (event) => events.push(event),
        skillsAdapter: { getSkillPaths: () => [] },
        pluginRuntimeService: {
          getEnabledRuntimePlugins: async () => [
            {
              name: 'test-plugin',
              runtimePath: path.join(testRoot, 'plugin-runtime'),
              componentsEnabled: { skills: true },
              componentCounts: { skills: 1 },
            },
          ],
        },
      });

      const paths = await runtime.resolveSkillPaths();

      expect(paths).toContain(pluginSkills);
      expect(events).toHaveLength(0);
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
