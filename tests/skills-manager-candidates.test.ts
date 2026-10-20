import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let testRoot = '';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => testRoot,
    getVersion: () => '0.0.0-test',
    getPath: (name: string) => {
      if (name === 'userData') return path.join(testRoot, 'userData');
      if (name === 'home') return path.join(testRoot, 'home');
      return testRoot;
    },
  },
}));

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { SkillsManager } from '../src/main/skills/skills-manager';
import type { DatabaseInstance } from '../src/main/db/database';

/** 带内存 skills 表的 db mock：getPersistedEnabled/setSkillEnabled 走真实读写路径 */
function createDbMock(): DatabaseInstance {
  const rows = new Map<string, { enabled: number }>();
  const statement = {
    all: vi.fn(() => []),
    run: vi.fn((...args: unknown[]) => {
      // INSERT OR INTO skills (id, name, description, type, enabled, ...)
      rows.set(String(args[0]), { enabled: Number(args[4]) });
    }),
    get: vi.fn((...args: unknown[]) => rows.get(String(args[0]))),
  };
  return {
    raw: {},
    sessions: {},
    messages: {},
    traceSteps: {},
    scheduledTasks: {},
    prepare: vi.fn(() => statement),
    exec: vi.fn(),
    pragma: vi.fn(),
    close: vi.fn(),
  } as unknown as DatabaseInstance;
}

function writeSkill(rootPath: string, name: string, description = `${name} skill`): void {
  const skillRoot = path.join(rootPath, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(
    path.join(skillRoot, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name}.`,
    'utf8'
  );
}

/** 缺 description 的 SKILL.md —— SDK 会拒绝加载并产出诊断 */
function writeBrokenSkill(rootPath: string, name: string): void {
  const skillRoot = path.join(rootPath, name);
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), `---\nname: ${name}\n---\n\nBody.`, 'utf8');
}

function readSkillName(skillDir: string): string {
  const content = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  const match = content.match(/^name:\s*(.+)$/m);
  return match ? match[1].trim() : '';
}

/**
 * 全面安装制：SkillsManager 枚举只覆盖全局技能目录。
 * 插件 skills、项目 .pi/skills、用户 ~/.agents/skills 等自动发现目录一律不可见。
 */
describe('SkillsManager install-only enumeration', () => {
  let manager: SkillsManager;
  let globalRoot: string;
  let projectCwd: string;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'open-cowork-skills-candidates-test-'));
    fs.mkdirSync(path.join(testRoot, 'userData'), { recursive: true });
    fs.mkdirSync(path.join(testRoot, 'home'), { recursive: true });

    manager = new SkillsManager(createDbMock());

    // 全局技能：1 个正常 + 1 个缺 description
    globalRoot = manager.getGlobalSkillsPath();
    writeSkill(globalRoot, 'fixture-alpha');
    writeBrokenSkill(globalRoot, 'fixture-broken');

    // 项目级自动发现目录（应被忽略）
    projectCwd = path.join(testRoot, 'project');
    fs.mkdirSync(path.join(projectCwd, '.git'), { recursive: true });
    writeSkill(path.join(projectCwd, '.pi', 'skills'), 'fixture-proj');

    // 用户级自动发现目录（应被忽略）
    writeSkill(path.join(testRoot, 'home', '.agents', 'skills'), 'fixture-home-skill');
    writeSkill(path.join(testRoot, 'home', '.claude', 'skills'), 'fixture-claude-skill');
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('menu covers only installed global skills (no auto-discovery)', async () => {
    const menu = await manager.getAvailableSkills(projectCwd);
    const names = new Set(menu.map((s) => s.name));

    expect(names.has('fixture-alpha')).toBe(true);
    // 缺 description 的技能被 SDK 拒绝，不进菜单
    expect(names.has('fixture-broken')).toBe(false);
    // 自动发现目录一律不可见
    expect(names.has('fixture-proj')).toBe(false);
    expect(names.has('fixture-home-skill')).toBe(false);
    expect(names.has('fixture-claude-skill')).toBe(false);
  });

  it('every expanded skill path corresponds to a menu entry (equivalence)', async () => {
    const menu = await manager.getAvailableSkills(projectCwd);
    const menuNames = new Set(menu.map((s) => s.name));

    const paths = await manager.getSkillPaths();
    expect(paths.length).toBeGreaterThan(0);

    const expandedNames = paths.map((p) => readSkillName(p));
    // 菜单 ⊇ 展开集合：展开时 SDK 能加载的每个技能，菜单里都可见
    for (const name of expandedNames) {
      expect(menuNames.has(name), `expanded skill "${name}" missing from menu`).toBe(true);
    }

    // 全局技能（enabled 且有目录）必须进入展开集合
    expect(expandedNames).toContain('fixture-alpha');
    // 解析失败的技能不进入展开集合
    expect(expandedNames).not.toContain('fixture-broken');
  });

  it('disabled global skill disappears from expansion but stays visible in menu', async () => {
    // 先枚举一次，让候选注册进 loadedSkills
    await manager.getAvailableSkills(projectCwd);
    manager.setSkillEnabled('global-fixture-alpha', false);

    const paths = await manager.getSkillPaths();
    const expandedNames = paths.map((p) => readSkillName(p));
    expect(expandedNames).not.toContain('fixture-alpha');

    const menu = await manager.getAvailableSkills(projectCwd);
    const entry = menu.find((s) => s.name === 'fixture-alpha');
    expect(entry).toBeDefined();
    expect(entry!.enabled).toBe(false);
  });

  it('installed skills carry sidecar-derived metadata (default local)', async () => {
    const menu = await manager.getAvailableSkills(projectCwd);
    const entry = menu.find((s) => s.name === 'fixture-alpha');
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('custom');
    // 无 sidecar 的存量目录按本地展示
    expect(entry!.source).toBe('local');
  });

  it('surfaces parse failures via getLoadDiagnostics', async () => {
    await manager.getAvailableSkills(projectCwd);
    const diagnostics = manager.getLoadDiagnostics();

    const brokenDiag = diagnostics.find((d) => d.path.includes('fixture-broken'));
    expect(brokenDiag).toBeDefined();
    expect(brokenDiag!.reason.length).toBeGreaterThan(0);
  });
});
