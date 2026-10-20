/**
 * 老版本升级迁移测试（全面安装制）：
 * - SQLite：`builtin-<name>` 行的 enabled 状态迁移到 `global-<name>` 行；
 *   `builtin-*` 行清空；幂等重跑。
 * - 文件系统：SkillsRuntime.ensureSetup 的 cleanupLegacyDiscoveryLinks
 *   只删除指向捆绑技能根 / ~/.claude/skills 的 symlink，保留真实目录与
 *   指向其他位置的链接。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  userData: '',
  home: '',
  appPath: '',
  globalSkillsPath: '',
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => {
      if (name === 'home') return mockState.home;
      return mockState.userData;
    },
    getVersion: () => '0.0.0-test',
    getAppPath: () => mockState.appPath,
  },
}));

vi.mock('../../main/utils/logger', () => ({
  log: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../main/config/config-store', () => ({
  configStore: {
    get: (key: string) => (key === 'globalSkillsPath' ? mockState.globalSkillsPath : undefined),
    getAll: () => ({}),
    set: vi.fn(),
    update: vi.fn(),
  },
  PROVIDER_PRESETS: {},
}));

vi.mock('@mariozechner/pi-coding-agent', () => ({
  loadSkillsFromDir: vi.fn(() => []),
}));

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseInstance } from '../../main/db/database';
import { SkillsManager } from '../../main/skills/skills-manager';
import { SkillsRuntime } from '../../main/claude/skills-runtime';

function createSkillsDb(): { raw: Database.Database; db: DatabaseInstance } {
  const raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  const db = { raw, prepare: (sql: string) => raw.prepare(sql) } as unknown as DatabaseInstance;
  return { raw, db };
}

function insertSkillRow(
  raw: Database.Database,
  row: { id: string; name: string; enabled: number; type?: string }
): void {
  raw
    .prepare(
      'INSERT INTO skills (id, name, description, type, enabled, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(row.id, row.name, '', row.type ?? 'custom', row.enabled, null, Date.now());
}

function getSkillRow(
  raw: Database.Database,
  id: string
): { id: string; name: string; enabled: number } | undefined {
  return raw.prepare('SELECT id, name, enabled FROM skills WHERE id = ?').get(id) as
    | { id: string; name: string; enabled: number }
    | undefined;
}

let tmpRoot: string;
let globalSkillsDir: string;
let homeDir: string;
let appPathDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nowlink-migrate-'));
  homeDir = path.join(tmpRoot, 'home');
  appPathDir = path.join(tmpRoot, 'app');
  mockState.userData = tmpRoot;
  mockState.home = homeDir;
  mockState.appPath = appPathDir;
  mockState.globalSkillsPath = '';
  globalSkillsDir = path.join(tmpRoot, 'claude', 'skills');
  fs.mkdirSync(globalSkillsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('migrateLegacyBuiltinState (SQLite)', () => {
  it('migrates enabled state from builtin row to matching global directory', () => {
    const { raw, db } = createSkillsDb();
    fs.mkdirSync(path.join(globalSkillsDir, 'docx'), { recursive: true });
    insertSkillRow(raw, { id: 'builtin-docx', name: 'docx', enabled: 1 });

    new SkillsManager(db);

    const migrated = getSkillRow(raw, 'global-docx');
    expect(migrated).toBeDefined();
    expect(migrated?.enabled).toBe(1);
    expect(getSkillRow(raw, 'builtin-docx')).toBeUndefined();
  });

  it('preserves disabled state', () => {
    const { raw, db } = createSkillsDb();
    fs.mkdirSync(path.join(globalSkillsDir, 'pdf'), { recursive: true });
    insertSkillRow(raw, { id: 'builtin-pdf', name: 'pdf', enabled: 0 });

    new SkillsManager(db);

    expect(getSkillRow(raw, 'global-pdf')?.enabled).toBe(0);
  });

  it('matches directories case-insensitively', () => {
    const { raw, db } = createSkillsDb();
    fs.mkdirSync(path.join(globalSkillsDir, 'DocX'), { recursive: true });
    insertSkillRow(raw, { id: 'builtin-docx', name: 'docx', enabled: 1 });

    new SkillsManager(db);

    expect(getSkillRow(raw, 'global-docx')?.enabled).toBe(1);
  });

  it('skips builtin rows without a matching global directory but still deletes them', () => {
    const { raw, db } = createSkillsDb();
    insertSkillRow(raw, { id: 'builtin-ghost', name: 'ghost', enabled: 1 });

    new SkillsManager(db);

    expect(getSkillRow(raw, 'global-ghost')).toBeUndefined();
    expect(getSkillRow(raw, 'builtin-ghost')).toBeUndefined();
  });

  it('does not overwrite an existing global row', () => {
    const { raw, db } = createSkillsDb();
    fs.mkdirSync(path.join(globalSkillsDir, 'docx'), { recursive: true });
    insertSkillRow(raw, { id: 'global-docx', name: 'docx', enabled: 0 });
    insertSkillRow(raw, { id: 'builtin-docx', name: 'docx', enabled: 1 });

    new SkillsManager(db);

    // 已有 global 行保留自身 enabled（不继承 builtin 的 1）
    expect(getSkillRow(raw, 'global-docx')?.enabled).toBe(0);
    expect(getSkillRow(raw, 'builtin-docx')).toBeUndefined();
  });

  it('is idempotent across repeated constructions', () => {
    const { raw, db } = createSkillsDb();
    fs.mkdirSync(path.join(globalSkillsDir, 'docx'), { recursive: true });
    insertSkillRow(raw, { id: 'builtin-docx', name: 'docx', enabled: 1 });

    new SkillsManager(db);
    // 用户随后停用，重跑迁移不得覆盖
    raw.prepare('UPDATE skills SET enabled = 0 WHERE id = ?').run('global-docx');
    new SkillsManager(db);
    new SkillsManager(db);

    expect(getSkillRow(raw, 'global-docx')?.enabled).toBe(0);
    const builtinCount = raw
      .prepare("SELECT COUNT(*) AS n FROM skills WHERE id LIKE 'builtin-%'")
      .get() as { n: number };
    expect(builtinCount.n).toBe(0);
  });

  it('is a no-op for fresh installs with no builtin rows', () => {
    const { raw, db } = createSkillsDb();
    expect(() => new SkillsManager(db)).not.toThrow();
    const count = raw.prepare('SELECT COUNT(*) AS n FROM skills').get() as { n: number };
    expect(count.n).toBe(0);
  });
});

describe('cleanupLegacyDiscoveryLinks (via SkillsRuntime.ensureSetup)', () => {
  function makeSkillDir(dir: string, name: string): string {
    const target = path.join(dir, name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: test\n---\n', 'utf-8');
    return target;
  }

  it('removes symlinks pointing into ~/.claude/skills and keeps real directories', () => {
    const userClaudeSkills = path.join(homeDir, '.claude', 'skills');
    makeSkillDir(userClaudeSkills, 'legacy-import');
    makeSkillDir(globalSkillsDir, 'real-skill');

    fs.symlinkSync(
      path.join(userClaudeSkills, 'legacy-import'),
      path.join(globalSkillsDir, 'legacy-import'),
      'dir'
    );

    const runtime = new SkillsRuntime({});
    runtime.ensureSetup();

    // symlink 被删除，但目标本体（~/.claude/skills/legacy-import）保留
    expect(fs.existsSync(path.join(userClaudeSkills, 'legacy-import'))).toBe(true);
    const entries = fs.readdirSync(globalSkillsDir);
    expect(entries).not.toContain('legacy-import');
    expect(entries).toContain('real-skill');
  });

  it('removes dangling symlinks pointing under ~/.claude/skills', () => {
    const userClaudeSkills = path.join(homeDir, '.claude', 'skills');
    fs.mkdirSync(userClaudeSkills, { recursive: true });
    fs.symlinkSync(
      path.join(userClaudeSkills, 'gone'),
      path.join(globalSkillsDir, 'dangling-link'),
      'dir'
    );

    const runtime = new SkillsRuntime({});
    runtime.ensureSetup();

    const entries = fs.readdirSync(globalSkillsDir);
    expect(entries).not.toContain('dangling-link');
  });

  it('keeps symlinks pointing outside the legacy roots', () => {
    const elsewhere = makeSkillDir(path.join(tmpRoot, 'elsewhere'), 'custom-store-skill');
    fs.symlinkSync(elsewhere, path.join(globalSkillsDir, 'custom-link'), 'dir');

    const runtime = new SkillsRuntime({});
    runtime.ensureSetup();

    const linkPath = path.join(globalSkillsDir, 'custom-link');
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(linkPath)).toBe(true);
  });
});
