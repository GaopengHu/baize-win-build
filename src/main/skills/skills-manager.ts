/**
 * @module main/skills/skills-manager
 *
 * Skill lifecycle（全面安装制）.
 *
 * Responsibilities:
 * - 枚举全局技能目录（<userData>/claude/skills 或用户配置路径）中已安装的技能
 * - 技能只能通过公司技能市场安装或本地文件夹安装进入该目录——
 *   不预置任何技能、不自动发现任何其他目录（SDK 发现目录、~/.claude/skills、插件 skills）
 * - Parses SKILL.md front-matter for metadata (name, description)
 * - 安装/卸载/启停持久化（SQLite skills 表）+ sidecar 来源元数据
 * - Hot-reload via chokidar file watcher
 *
 * Dependencies: config-store, database, chokidar
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import { loadSkillsFromDir } from '@mariozechner/pi-coding-agent';
import type { Skill, PluginInstallResult, SkillLoadDiagnostic } from '../../renderer/types';
import type { DatabaseInstance } from '../db/database';
import { log, logError, logWarn } from '../utils/logger';
import { isPathWithinRoot } from '../tools/path-containment';
import type { SkillsAdapter } from './skills-adapter';

/**
 * Validate that a skill name is safe for use as a directory name.
 * Rejects names containing path separators or parent directory references.
 */
/**
 * 技能安装态元数据（`.nowlink-marketplace.json`，与技能目录同级存放）。
 *
 * 全面安装制下所有技能都来自「市场安装」或「本地文件夹安装」，sidecar 记录
 * 其来源，用于：市场列表标记「已安装」、版本比较提示「更新」、UI 来源徽标。
 * 无 sidecar 的存量目录（升级前的旧数据）按 'local' 展示。
 */
export interface SkillSidecar {
  /** 公司技能市场应用 id（本地安装无） */
  appId?: number;
  /** 市场中文展示名（内部名/目录名保持包内英文，模型调用不受影响） */
  displayName?: string;
  /** 安装时记录的市场版本号 */
  version?: string;
  installedAt?: number;
  source: 'marketplace' | 'local';
}

const SIDECAR_FILENAME = '.nowlink-marketplace.json';

export function skillSidecarPath(skillDir: string): string {
  return path.join(skillDir, SIDECAR_FILENAME);
}

/**
 * 读取技能 sidecar。兼容旧格式 `{ appId, displayName }`（视为 marketplace）。
 * 无文件或解析失败返回 null——调用方回退「本地」展示、显示内部名。
 */
export function readSkillSidecar(skillDir: string): SkillSidecar | null {
  try {
    const sidecar = skillSidecarPath(skillDir);
    if (!fs.existsSync(sidecar)) return null;
    const raw = JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as Partial<SkillSidecar> & {
      displayName?: unknown;
      appId?: unknown;
      version?: unknown;
      installedAt?: unknown;
      source?: unknown;
    };
    if (!raw || typeof raw !== 'object') return null;

    const source: SkillSidecar['source'] = raw.source === 'local' ? 'local' : 'marketplace';
    const result: SkillSidecar = { source };

    if (typeof raw.appId === 'number' && Number.isFinite(raw.appId)) result.appId = raw.appId;
    if (typeof raw.displayName === 'string' && raw.displayName.trim()) {
      result.displayName = raw.displayName.trim();
    }
    if (typeof raw.version === 'string' && raw.version.trim()) {
      result.version = raw.version.trim();
    }
    if (typeof raw.installedAt === 'number' && Number.isFinite(raw.installedAt)) {
      result.installedAt = raw.installedAt;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * 写入技能 sidecar（安装/更新成功后调用）。写入失败不影响安装结果，
 * 仅降级为「无来源信息」（UI 显示本地、市场列表不标记已安装）。
 */
export function writeSkillSidecar(
  skillDir: string,
  sidecar: Partial<SkillSidecar> & { source?: SkillSidecar['source'] }
): void {
  try {
    const payload: SkillSidecar = {
      ...sidecar,
      source: sidecar.source === 'marketplace' ? 'marketplace' : 'local',
      installedAt: sidecar.installedAt ?? Date.now(),
    };
    fs.writeFileSync(skillSidecarPath(skillDir), JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    logWarn(
      `[Skills] Failed to write sidecar for ${skillDir}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * 市场安装 sidecar（`.nowlink-marketplace.json`）读取：{ appId, displayName }。
 * 显示层用 displayName（中文），内部名/目录名保持包内英文，模型调用不受影响。
 * 无文件或解析失败返回 null，调用方回退显示内部名。
 */
export function readMarketplaceDisplayName(skillDir: string): string | null {
  return readSkillSidecar(skillDir)?.displayName ?? null;
}

function validateSkillName(name: string): void {
  if (!name || /[/\\]|\.\./.test(name)) {
    throw new Error(`Invalid skill name: ${name}`);
  }
}

/**
 * Check if a path is a dangling symlink (symlink whose target no longer exists).
 */
function isDanglingSymlink(filePath: string): boolean {
  try {
    const lstat = fs.lstatSync(filePath);
    if (!lstat.isSymbolicLink()) return false;
    // Symlink exists — check if the target is reachable
    try {
      fs.statSync(filePath);
      return false; // target exists, not dangling
    } catch {
      return true; // target unreachable
    }
  } catch {
    return false; // path itself doesn't exist
  }
}

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface SkillConfig {
  name: string;
  description?: string;
  type: 'mcp' | 'custom';
  mcp?: McpServerConfig;
  enabled?: boolean;
}

interface PluginManifest {
  name?: string;
  description?: string;
  version?: string;
}

interface SkillsManagerOptions {
  getConfiguredGlobalSkillsPath?: () => string | undefined;
  setConfiguredGlobalSkillsPath?: (nextPath: string) => void;
  watchStorage?: boolean;
}

/**
 * 一次技能枚举中的候选条目——菜单（getAvailableSkills）与展开
 * （getSkillPaths）共享的唯一中间表示。path 为 undefined 表示该候选
 * 只参与名字去重（如 legacy .json 条目），不会进入 skillPaths。
 */
interface SkillCandidate {
  /** 渲染层 Skill.id：global-<dir>（目录技能）/ user-<n>（legacy .json 条目） */
  id: string;
  name: string;
  description: string;
  displayName?: string;
  /** 技能目录（SDK Skill.baseDir）；undefined = 仅名字占位（SDK 自动加载，不进 skillPaths） */
  path?: string;
  enabled: boolean;
  createdAt: number;
  /** 安装态 sidecar 派生字段（版本/来源/市场 appId） */
  sidecar?: SkillSidecar | null;
}

/** 技能加载诊断（解析失败/缺 frontmatter/插件目录缺失等），供设置页展示。 */
export type { SkillLoadDiagnostic } from '../../renderer/types';

export interface SkillsStorageChangeEvent {
  path: string;
  reason: 'updated' | 'path_changed' | 'fallback' | 'watcher_error';
  message?: string;
}

export interface SetGlobalSkillsPathResult {
  path: string;
  migratedCount: number;
  skippedCount: number;
}

/**
 * SkillsManager - Manages skill loading and MCP server lifecycle
 *
 * Skills loading（全面安装制）:
 * - 仅枚举全局技能目录（<userData>/claude/skills 或用户配置路径）
 * - 技能只能通过公司技能市场安装或本地文件夹安装；不预置、不自动发现
 */
export class SkillsManager implements SkillsAdapter {
  private db: DatabaseInstance;
  private loadedSkills: Map<string, Skill> = new Map();
  private runningServers: Map<string, { process: unknown; skill: Skill }> = new Map();
  private getConfiguredGlobalSkillsPathFn?: () => string | undefined;
  private setConfiguredGlobalSkillsPathFn?: (nextPath: string) => void;
  private watchStorageEnabled: boolean;
  private storageWatcher: FSWatcher | null = null;
  private storagePollingTimer: NodeJS.Timeout | null = null;
  private lastStorageSignature = '';
  private loadedGlobalSkillsSignature = '';
  private globalSkillsLoaded = false;
  private storageCallbacks = new Set<(event: SkillsStorageChangeEvent) => void>();
  /** 最近一次枚举收集的加载诊断（枚举期，每次 collectSkillCandidates 重置） */
  private lastLoadDiagnostics: SkillLoadDiagnostic[] = [];
  /** 构造期记录的诊断（如迁移过程），跨枚举保留 */
  private pendingDiagnostics: SkillLoadDiagnostic[] = [];

  constructor(db: DatabaseInstance, options: SkillsManagerOptions = {}) {
    this.db = db;
    this.getConfiguredGlobalSkillsPathFn = options.getConfiguredGlobalSkillsPath;
    this.setConfiguredGlobalSkillsPathFn = options.setConfiguredGlobalSkillsPath;
    this.watchStorageEnabled = options.watchStorage === true;
    this.migrateLegacyBuiltinState();
    if (this.watchStorageEnabled) {
      this.startStorageWatcher();
    }
  }

  /**
   * 老版本升级迁移（幂等）：
   * 1. SQLite 中 `builtin-<name>` 行的 enabled 状态继承给同名 `global-<name>` 行
   *    （仅当全局目录存在同名技能目录且尚无 global 行时新建）；
   * 2. 删除所有 `builtin-%` 行。
   * 全新安装用户：无 builtin 行，本方法为空操作。
   */
  private migrateLegacyBuiltinState(): void {
    try {
      const rows = this.db
        .prepare("SELECT id, name, enabled FROM skills WHERE id LIKE 'builtin-%'")
        .all() as Array<{ id: string; name: string; enabled: number }>;
      if (!rows || rows.length === 0) return;

      let globalDir: string;
      try {
        globalDir = this.getGlobalSkillsPath();
      } catch {
        return;
      }

      let dirEntries: string[] = [];
      try {
        dirEntries = fs.readdirSync(globalDir);
      } catch {
        dirEntries = [];
      }
      const dirSet = new Set(dirEntries.map((entry) => entry.toLowerCase()));

      for (const row of rows) {
        const dirName = row.id.replace(/^builtin-/, '');
        const globalId = `global-${dirName}`;
        if (!dirSet.has(dirName.toLowerCase())) continue;
        const existing = this.db.prepare('SELECT id FROM skills WHERE id = ?').get(globalId) as
          | { id: string }
          | undefined;
        if (existing) continue;
        this.db
          .prepare(
            'INSERT INTO skills (id, name, description, type, enabled, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .run(globalId, row.name || dirName, '', 'custom', row.enabled ? 1 : 0, null, Date.now());
        log(`[Skills] Migrated builtin enabled state to ${globalId} (enabled=${!!row.enabled})`);
      }

      this.db.prepare("DELETE FROM skills WHERE id LIKE 'builtin-%'").run();
      log(`[Skills] Removed ${rows.length} legacy builtin skill row(s)`);
    } catch (error) {
      logWarn(`[Skills] Legacy builtin state migration failed: ${String(error)}`);
    }
  }

  private getDefaultGlobalSkillsPath(): string {
    return path.join(app.getPath('userData'), 'claude', 'skills');
  }

  getGlobalSkillsPath(): string {
    const fallbackPath = this.getDefaultGlobalSkillsPath();
    const configuredPath = (this.getConfiguredGlobalSkillsPathFn?.() || '').trim();
    const preferredPath = configuredPath ? path.resolve(configuredPath) : fallbackPath;

    // Validate resolved path is within expected directories
    if (configuredPath) {
      const resolved = path.resolve(configuredPath);
      const allowedBases = [app.getPath('userData'), app.getPath('home'), process.cwd()];
      const isWithinAllowed = allowedBases.some((base) => isPathWithinRoot(resolved, base));
      if (!isWithinAllowed) {
        throw new Error(`Skills path outside allowed directories: ${resolved}`);
      }
    }

    try {
      if (!fs.existsSync(preferredPath)) {
        fs.mkdirSync(preferredPath, { recursive: true });
      }
      if (!fs.statSync(preferredPath).isDirectory()) {
        throw new Error('Configured path is not a directory');
      }
      return preferredPath;
    } catch (error) {
      if (preferredPath !== fallbackPath) {
        logWarn(
          `[Skills] Configured skills path is unavailable, fallback to default: ${preferredPath}`
        );
        this.setConfiguredGlobalSkillsPathFn?.('');
        this.emitStorageEvent({
          path: fallbackPath,
          reason: 'fallback',
          message: 'Configured skills directory is unavailable, fallback to default directory.',
        });
      }
      if (!fs.existsSync(fallbackPath)) {
        fs.mkdirSync(fallbackPath, { recursive: true });
      }
      return fallbackPath;
    }
  }

  onStorageChanged(callback: (event: SkillsStorageChangeEvent) => void): () => void {
    this.storageCallbacks.add(callback);
    return () => {
      this.storageCallbacks.delete(callback);
    };
  }

  private emitStorageEvent(event: SkillsStorageChangeEvent): void {
    this.invalidateGlobalSkillsCache();
    for (const callback of this.storageCallbacks) {
      try {
        callback(event);
      } catch (error) {
        logError('[Skills] Storage change callback failed:', error);
      }
    }
  }

  private clearSkillsBySource(source: 'global'): void {
    const prefix = `${source}-`;
    for (const key of Array.from(this.loadedSkills.keys())) {
      if (key.startsWith(prefix)) {
        this.loadedSkills.delete(key);
      }
    }
  }

  private invalidateGlobalSkillsCache(): void {
    this.loadedGlobalSkillsSignature = '';
    this.globalSkillsLoaded = false;
  }

  private computeStorageSignature(storagePath: string): string {
    try {
      if (!fs.existsSync(storagePath) || !fs.statSync(storagePath).isDirectory()) {
        return '';
      }
      const entries = fs.readdirSync(storagePath, { withFileTypes: true });
      const parts = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => {
          const skillMdPath = path.join(storagePath, entry.name, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) {
            return null;
          }
          const stat = fs.statSync(skillMdPath);
          return `${entry.name}:${stat.mtimeMs}`;
        })
        .filter((value): value is string => Boolean(value))
        .sort();
      return parts.join('|');
    } catch {
      return '';
    }
  }

  private stopStorageWatcher(): void {
    if (this.storageWatcher) {
      this.storageWatcher.close().catch((error) => {
        logError('[Skills] Failed to close storage watcher:', error);
      });
      this.storageWatcher = null;
    }
    if (this.storagePollingTimer) {
      clearInterval(this.storagePollingTimer);
      this.storagePollingTimer = null;
    }
  }

  private startStoragePolling(storagePath: string): void {
    if (this.storagePollingTimer) {
      return;
    }
    this.storagePollingTimer = setInterval(() => {
      const nextSignature = this.computeStorageSignature(storagePath);
      if (nextSignature !== this.lastStorageSignature) {
        this.lastStorageSignature = nextSignature;
        this.emitStorageEvent({ path: storagePath, reason: 'updated' });
      }
    }, 3000);
  }

  private startStorageWatcher(): void {
    this.stopStorageWatcher();
    const storagePath = this.getGlobalSkillsPath();
    this.lastStorageSignature = this.computeStorageSignature(storagePath);

    try {
      this.storageWatcher = chokidar.watch(storagePath, {
        ignoreInitial: true,
        depth: 3,
        awaitWriteFinish: {
          stabilityThreshold: 200,
          pollInterval: 100,
        },
      });
      this.storageWatcher.on('all', () => {
        const nextSignature = this.computeStorageSignature(storagePath);
        if (nextSignature !== this.lastStorageSignature) {
          this.lastStorageSignature = nextSignature;
          this.emitStorageEvent({ path: storagePath, reason: 'updated' });
        }
      });
      this.storageWatcher.on('error', (error) => {
        logError('[Skills] Storage watcher failed:', error);
        this.emitStorageEvent({
          path: storagePath,
          reason: 'watcher_error',
          message: error instanceof Error ? error.message : String(error),
        });
        this.startStoragePolling(storagePath);
      });
    } catch (error) {
      logError('[Skills] Failed to start storage watcher:', error);
      this.emitStorageEvent({
        path: storagePath,
        reason: 'watcher_error',
        message: error instanceof Error ? error.message : String(error),
      });
      this.startStoragePolling(storagePath);
    }
  }

  /**
   * Remove dangling symlinks from a directory (e.g. leftover links to a
   * previous app bundle after an upgrade).
   */
  private cleanDanglingSymlinks(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return; // directory unreadable — nothing to clean
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry);
      if (isDanglingSymlink(entryPath)) {
        try {
          fs.unlinkSync(entryPath);
          log(`[Skills] Cleaned up dangling symlink: ${entryPath}`);
        } catch (err) {
          logWarn(`[Skills] Could not remove dangling symlink ${entryPath}: ${err}`);
        }
      }
    }
  }

  /**
   * Load global skills from user config directory
   */
  async loadGlobalSkills(): Promise<Skill[]> {
    const globalSkillsPath = this.getGlobalSkillsPath();

    if (!fs.existsSync(globalSkillsPath)) {
      fs.mkdirSync(globalSkillsPath, { recursive: true });
    }

    // Proactively clean up dangling symlinks left by previous app versions
    this.cleanDanglingSymlinks(globalSkillsPath);

    const signature = this.computeStorageSignature(globalSkillsPath);
    if (this.globalSkillsLoaded && signature === this.loadedGlobalSkillsSignature) {
      return Array.from(this.loadedSkills.values()).filter((skill) =>
        skill.id.startsWith('global-')
      );
    }

    this.clearSkillsBySource('global');
    const skills = await this.loadSkillsFromDirectory(globalSkillsPath, 'global');
    this.loadedGlobalSkillsSignature = signature;
    this.globalSkillsLoaded = true;
    return skills;
  }

  async setGlobalSkillsPath(newPath: string, migrate = true): Promise<SetGlobalSkillsPathResult> {
    const trimmed = newPath.trim();
    if (!trimmed) {
      throw new Error('Skills directory path cannot be empty');
    }

    const sourcePath = this.getGlobalSkillsPath();
    const targetPath = path.resolve(trimmed);

    if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) {
      throw new Error('Target path is not a directory');
    }
    if (!fs.existsSync(targetPath)) {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    let migratedCount = 0;
    let skippedCount = 0;
    if (migrate && sourcePath !== targetPath && fs.existsSync(sourcePath)) {
      const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        // Validate entry name does not contain path traversal characters
        if (/[/\\]|\.\./.test(entry.name)) {
          logWarn(`[Skills] Skipping migration of entry with unsafe name: ${entry.name}`);
          continue;
        }
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const targetEntryPath = path.join(targetPath, entry.name);
        if (fs.existsSync(targetEntryPath)) {
          skippedCount += 1;
          continue;
        }
        await this.copyDirectory(sourceEntryPath, targetEntryPath);
        migratedCount += 1;
      }
    }

    this.setConfiguredGlobalSkillsPathFn?.(targetPath);
    if (this.watchStorageEnabled) {
      this.startStorageWatcher();
    }
    this.invalidateGlobalSkillsCache();
    await this.loadGlobalSkills();
    this.emitStorageEvent({ path: targetPath, reason: 'path_changed' });

    return { path: targetPath, migratedCount, skippedCount };
  }

  /**
   * Load skills from the global storage directory
   */
  private async loadSkillsFromDirectory(dir: string, source: 'global'): Promise<Skill[]> {
    const skills: Skill[] = [];

    try {
      const entries = fs.readdirSync(dir);

      for (const entry of entries) {
        const entryPath = path.join(dir, entry);

        // Skip dangling symlinks (e.g. leftover links to a previous app bundle)
        if (isDanglingSymlink(entryPath)) {
          logWarn(`[Skills] Skipping dangling symlink: ${entryPath}`);
          continue;
        }

        let stat: fs.Stats;
        try {
          stat = fs.statSync(entryPath);
        } catch {
          continue; // skip entries that can't be stat'd
        }

        // Check if it's a directory with SKILL.md
        if (stat.isDirectory()) {
          const skillMdPath = path.join(entryPath, 'SKILL.md');
          if (fs.existsSync(skillMdPath)) {
            // Parse metadata from SKILL.md
            const metadata = this.getSkillMetadata(entryPath);
            if (!metadata) continue;

            // 安装态 sidecar：displayName（市场中文名）+ 版本/来源/appId。
            // 无 sidecar 的存量目录回退「本地」展示（source: 'local'）。
            const sidecar = readSkillSidecar(entryPath);

            const skill: Skill = {
              id: `${source}-${entry}`,
              name: metadata.name,
              displayName: sidecar?.displayName ?? undefined,
              description: metadata.description,
              type: 'custom',
              enabled: this.getPersistedEnabled(`${source}-${entry}`, true),
              createdAt: Date.now(),
              version: sidecar?.version,
              source: sidecar?.source ?? 'local',
              installedAt: sidecar?.installedAt,
              appId: sidecar?.appId,
            };

            skills.push(skill);
            this.loadedSkills.set(skill.id, skill);
          }
        }
        // Also support legacy .json config files
        else if (entry.endsWith('.json')) {
          try {
            const content = fs.readFileSync(entryPath, 'utf-8');
            const config: SkillConfig = JSON.parse(content);

            const skill: Skill = {
              id: `${source}-${path.basename(entry, '.json')}`,
              name: config.name,
              description: config.description,
              type: config.type === 'mcp' ? 'mcp' : 'custom',
              enabled:
                config.enabled !== undefined
                  ? config.enabled
                  : this.getPersistedEnabled(`${source}-${path.basename(entry, '.json')}`, true),
              config: config.mcp ? { mcp: config.mcp } : undefined,
              createdAt: Date.now(),
            };

            skills.push(skill);
            this.loadedSkills.set(skill.id, skill);
          } catch (error) {
            logError(`Failed to load skill from ${entryPath}:`, error);
          }
        }
      }
    } catch (error) {
      logError(`Failed to read skills directory ${dir}:`, error);
    }

    return skills;
  }

  /**
   * Get all active skills for a session
   *
   * 全面安装制：仅全局技能目录中已安装且启用的技能。
   */
  async getActiveSkills(_sessionId: string, _projectPath?: string): Promise<Skill[]> {
    const globalSkills = await this.loadGlobalSkills();
    return globalSkills.filter((s) => s.enabled);
  }

  /**
   * 技能宇宙的唯一枚举入口（单一真相源）。
   *
   * 全面安装制：仅枚举全局技能目录（<userData>/claude/skills 或用户配置路径）。
   * 不预置内置技能、不自动发现任何其他目录（SDK 发现目录、~/.claude/skills、
   * 插件 skills 一律不再扫描）。legacy .json 条目仅名字占位。
   *
   * frontmatter 解析统一走 SDK 的 loadSkillsFromDir（name 缺失时回退目录名、
   * description 必填、SKILL.md 目录不递归），保证菜单与展开的解析语义完全一致。
   *
   * 名字去重（小写）：先注册者优先。
   * 解析失败/告警写入 lastLoadDiagnostics 供设置页展示。
   */
  private async collectSkillCandidates(_cwd?: string): Promise<SkillCandidate[]> {
    const diagnostics: SkillLoadDiagnostic[] = [];
    const byName = new Map<string, SkillCandidate>();

    const addCandidate = (candidate: SkillCandidate): void => {
      const key = candidate.name.toLowerCase();
      if (byName.has(key)) {
        return; // 先注册者优先
      }
      byName.set(key, candidate);
    };

    /** 用 SDK 解析器枚举一个技能根目录，返回解析出的技能列表 */
    const enumerateDir = (dir: string, source: string) => {
      try {
        const result = loadSkillsFromDir({ dir, source });
        for (const d of result.diagnostics) {
          diagnostics.push({
            path: d.path ?? dir,
            reason: `${d.type}: ${d.message}`,
          });
        }
        return result.skills;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logWarn(`[Skills] Failed to enumerate skill dir ${dir}: ${reason}`);
        diagnostics.push({ path: dir, reason });
        return [];
      }
    };

    // 全局技能：先走 loadGlobalSkills（缓存 / legacy .json 注册），
    // 再以 SDK 解析器枚举目录本身，enabled 取 loadedSkills 中的实时状态。
    const globalSkills = await this.loadGlobalSkills();
    const globalRoot = this.getGlobalSkillsPath();
    const seenGlobalIds = new Set<string>();
    for (const skill of enumerateDir(globalRoot, 'global')) {
      const dir = path.basename(skill.baseDir);
      const id = `global-${dir}`;
      seenGlobalIds.add(id);
      const loaded = this.loadedSkills.get(id);
      const sidecar = readSkillSidecar(skill.baseDir);
      addCandidate({
        id,
        name: skill.name,
        description: skill.description,
        displayName: sidecar?.displayName ?? undefined,
        path: skill.baseDir,
        enabled: loaded?.enabled ?? this.getPersistedEnabled(id, true),
        createdAt: loaded?.createdAt ?? Date.now(),
        sidecar,
      });
    }
    // legacy .json 条目（SDK 不识别）：仅名字占位，不进入 skillPaths
    for (const skill of globalSkills) {
      if (seenGlobalIds.has(skill.id)) continue;
      if (
        skill.id.startsWith('global-') &&
        fs.existsSync(path.join(globalRoot, skill.id.slice('global-'.length), 'SKILL.md'))
      ) {
        continue; // 目录形态但 SDK 解析失败——已在 diagnostics 中体现，不重复占位
      }
      addCandidate({
        id: skill.id,
        name: skill.name,
        description: skill.description ?? '',
        displayName: skill.displayName,
        path: undefined,
        enabled: skill.enabled,
        createdAt: skill.createdAt,
      });
    }

    this.lastLoadDiagnostics = diagnostics;
    // 并入构造期记录的诊断（如迁移过程），并清空
    if (this.pendingDiagnostics.length > 0) {
      this.lastLoadDiagnostics.push(...this.pendingDiagnostics);
      this.pendingDiagnostics = [];
    }
    return Array.from(byName.values());
  }

  /**
   * 菜单数据源：返回全部已安装技能（仅全局目录），
   * 与 /skill:<name> 展开时 SDK 实际可解析的技能集合保持一致。
   */
  async getAvailableSkills(cwd?: string): Promise<Skill[]> {
    const candidates = await this.collectSkillCandidates(cwd);
    return candidates.map((candidate) => {
      const sidecar =
        candidate.sidecar ?? (candidate.path ? readSkillSidecar(candidate.path) : null);
      const skill: Skill = {
        id: candidate.id,
        name: candidate.name,
        displayName: candidate.displayName,
        description: candidate.description,
        type: 'custom',
        enabled: candidate.enabled,
        createdAt: candidate.createdAt,
        version: sidecar?.version,
        source: sidecar?.source ?? 'local',
        installedAt: sidecar?.installedAt,
        appId: sidecar?.appId,
      };
      return skill;
    });
  }

  /** 最近一次枚举收集的加载诊断（解析失败/告警），供设置页展示。 */
  getLoadDiagnostics(): SkillLoadDiagnostic[] {
    return [...this.lastLoadDiagnostics];
  }

  /**
   * Implement SkillsAdapter: return skill directories for enabled skills only.
   * Used by the agent runner to feed the SDK's resource loader, so disabled
   * skills are never exposed to the model.
   *
   * 与 getAvailableSkills 共享 collectSkillCandidates（单一真相源）：
   * 菜单里可见且启用的技能，展开时一定能被 SDK 加载。
   * path 为 undefined 的候选（legacy .json 条目）不进入 skillPaths——非 SKILL.md 形态。
   */
  async getSkillPaths(): Promise<string[]> {
    const candidates = await this.collectSkillCandidates();
    return candidates
      .filter((candidate) => candidate.enabled && candidate.path)
      .map((candidate) => candidate.path as string);
  }

  /**
   * Start an MCP server for a skill
   */
  async startMcpServer(skill: Skill): Promise<void> {
    if (skill.type !== 'mcp' || !skill.config?.mcp) {
      throw new Error('Skill is not an MCP skill');
    }

    if (this.runningServers.has(skill.id)) {
      log(`MCP server for ${skill.name} is already running`);
      return;
    }

    // TODO: Implement actual MCP server startup
    // const { spawn } = await import('child_process');
    // const mcpConfig = skill.config.mcp as McpServerConfig;
    //
    // const proc = spawn(mcpConfig.command, mcpConfig.args || [], {
    //   env: { ...process.env, ...mcpConfig.env },
    // });
    //
    // this.runningServers.set(skill.id, { process: proc, skill });

    log(`MCP server started for skill: ${skill.name}`);
  }

  /**
   * Stop an MCP server
   */
  async stopMcpServer(skillId: string): Promise<void> {
    const server = this.runningServers.get(skillId);
    if (!server) {
      return;
    }

    // TODO: Implement graceful shutdown
    // server.process.kill();

    this.runningServers.delete(skillId);
    log(`MCP server stopped for skill: ${server.skill.name}`);
  }

  /**
   * Stop all running MCP servers
   */
  async stopAllServers(): Promise<void> {
    for (const skillId of this.runningServers.keys()) {
      await this.stopMcpServer(skillId);
    }
  }

  stopStorageMonitoring(): void {
    this.stopStorageWatcher();
  }

  /**
   * Enable or disable a skill
   *
   * 对不在 loadedSkills 中的 id（如 legacy user- 前缀条目）也要持久化
   * 开关状态——collectSkillCandidates 枚举时通过 getPersistedEnabled 读回。
   */
  setSkillEnabled(skillId: string, enabled: boolean): void {
    const skill = this.loadedSkills.get(skillId);
    if (skill) {
      skill.enabled = enabled;

      // Stop server if disabling an MCP skill
      if (!enabled && skill.type === 'mcp') {
        this.stopMcpServer(skillId);
      }

      // Persist toggle state so installed skills survive restarts.
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO skills (id, name, description, type, enabled, config, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        skill.id,
        skill.name,
        skill.description || null,
        skill.type,
        skill.enabled ? 1 : 0,
        skill.config ? JSON.stringify(skill.config) : null,
        skill.createdAt
      );
      return;
    }

    // 不在 loadedSkills 的 id：仅持久化开关（名字/描述留空，枚举时以磁盘为准）
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO skills (id, name, description, type, enabled, config, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(skillId, skillId, null, 'custom', enabled ? 1 : 0, null, Date.now());
  }

  /**
   * Get all loaded skills
   */
  getAllSkills(): Skill[] {
    return this.deduplicateSkills(Array.from(this.loadedSkills.values()));
  }

  /**
   * Save skill to database
   */
  saveSkill(skill: Skill): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO skills (id, name, description, type, enabled, config, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      skill.id,
      skill.name,
      skill.description || null,
      skill.type,
      skill.enabled ? 1 : 0,
      skill.config ? JSON.stringify(skill.config) : null,
      skill.createdAt
    );
  }

  /**
   * Delete a skill (remove DB row + in-memory entry).
   * 全面安装制：所有已安装技能均可删除，无内置守卫。
   */
  deleteSkill(skillId: string): void {
    this.stopMcpServer(skillId);
    this.loadedSkills.delete(skillId);

    const stmt = this.db.prepare('DELETE FROM skills WHERE id = ?');
    stmt.run(skillId);
  }

  /**
   * List all skills with optional filters
   */
  async listSkills(filter?: { type?: 'mcp' | 'custom'; enabled?: boolean }): Promise<Skill[]> {
    // Load global skills first to ensure they're in loadedSkills
    await this.loadGlobalSkills();

    let skills = this.deduplicateSkills(Array.from(this.loadedSkills.values()));

    if (filter) {
      if (filter.type !== undefined) {
        skills = skills.filter((s) => s.type === filter.type);
      }
      if (filter.enabled !== undefined) {
        skills = skills.filter((s) => s.enabled === filter.enabled);
      }
    }

    return skills;
  }

  /**
   * Validate skill folder structure and SKILL.md
   */
  async validateSkillFolder(skillPath: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Check if path exists
    if (!fs.existsSync(skillPath)) {
      return { valid: false, errors: ['Path does not exist'] };
    }

    // Check if it's a directory
    const stat = fs.statSync(skillPath);
    if (!stat.isDirectory()) {
      return { valid: false, errors: ['Path is not a directory'] };
    }

    // Check for SKILL.md
    const skillMdPath = path.join(skillPath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      return { valid: false, errors: ['SKILL.md not found'] };
    }

    // Parse SKILL.md frontmatter
    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');
      const frontMatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const frontMatter = frontMatterMatch ? frontMatterMatch[1] : content;

      const nameMatch = frontMatter.match(/name:\s*["']?([^"'\r\n]+)["']?/);
      const descMatch = frontMatter.match(/description:\s*["']?([^"'\r\n]+)["']?/);

      if (!nameMatch) {
        errors.push('SKILL.md missing "name" in frontmatter');
      }
      if (!descMatch) {
        errors.push('SKILL.md missing "description" in frontmatter');
      }
    } catch (err) {
      errors.push('Failed to parse SKILL.md');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get skill metadata from SKILL.md file
   *
   * 解析失败时记录诊断（lastLoadDiagnostics + logWarn），
   * 供设置页"技能加载问题"区展示，不再静默跳过。
   */
  getSkillMetadata(skillPath: string): { name: string; description: string } | null {
    const skillMdPath = path.join(skillPath, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(skillMdPath, 'utf-8');

      // Limit regex matching to the YAML front-matter block (between --- markers)
      const frontMatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const frontMatter = frontMatterMatch ? frontMatterMatch[1] : content;

      const nameMatch = frontMatter.match(/name:\s*["']?([^"'\r\n]+)["']?/);
      const descMatch = frontMatter.match(/description:\s*["']?([^"'\r\n]+)["']?/);

      if (!nameMatch || !descMatch) {
        const missing = [!nameMatch ? 'name' : null, !descMatch ? 'description' : null]
          .filter(Boolean)
          .join('、');
        this.recordDiagnostic(skillPath, `SKILL.md frontmatter 缺少 ${missing} 字段`);
        return null;
      }

      const name = nameMatch[1].trim();
      validateSkillName(name);

      return {
        name,
        description: descMatch[1].trim(),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logError(`Failed to parse SKILL.md from ${skillPath}:`, error);
      this.recordDiagnostic(skillPath, `SKILL.md 解析失败: ${reason}`);
      return null;
    }
  }

  /** 记录一条加载诊断（logWarn + pendingDiagnostics，下次枚举时并入 lastLoadDiagnostics） */
  private recordDiagnostic(diagPath: string, reason: string): void {
    logWarn(`[Skills] ${diagPath}: ${reason}`);
    this.pendingDiagnostics.push({ path: diagPath, reason });
  }

  /**
   * Read a skill's persisted enabled state from the DB.
   * Returns the provided default when no row exists (first run).
   */
  private getPersistedEnabled(skillId: string, fallback: boolean): boolean {
    try {
      const row = this.db.prepare('SELECT enabled FROM skills WHERE id = ?').get(skillId) as
        | { enabled?: number }
        | undefined;
      return row?.enabled !== undefined ? Boolean(row.enabled) : fallback;
    } catch (error) {
      logError(`Failed to read persisted enabled state for ${skillId}:`, error);
      return fallback;
    }
  }

  /**
   * Copy skill folder to global skills directory
   */
  private async copySkillToGlobal(sourcePath: string, skillName: string): Promise<string> {
    // Use app-specific skills directory to avoid conflicts with user settings
    const globalSkillsPath = this.getGlobalSkillsPath();

    // Ensure global skills directory exists
    if (!fs.existsSync(globalSkillsPath)) {
      fs.mkdirSync(globalSkillsPath, { recursive: true });
    }

    const targetPath = path.join(globalSkillsPath, skillName);

    // Copy directory recursively (caller should handle existing files)
    await this.copyDirectory(sourcePath, targetPath);

    log(`Copied skill from ${sourcePath} to ${targetPath}`);
    return targetPath;
  }

  /**
   * Recursively copy directory
   */
  private async copyDirectory(source: string, target: string): Promise<void> {
    // Remove dangling symlink at target before creating directory
    if (isDanglingSymlink(target)) {
      try {
        fs.unlinkSync(target);
      } catch {
        if (isDanglingSymlink(target)) throw new Error(`Cannot remove dangling symlink: ${target}`);
      }
    }
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    const files = fs.readdirSync(source);

    for (const file of files) {
      const sourcePath = path.join(source, file);
      const targetPath = path.join(target, file);
      const lstat = fs.lstatSync(sourcePath);

      if (lstat.isSymbolicLink()) {
        // Resolve symlink and check it stays within source directory
        let realTarget: string;
        try {
          realTarget = fs.realpathSync(sourcePath);
        } catch {
          logWarn(`[Skills] Skipping unresolvable symlink: ${sourcePath}`);
          continue;
        }
        if (!isPathWithinRoot(realTarget, source)) {
          logWarn(
            `[Skills] Skipping symlink escaping source directory: ${sourcePath} -> ${realTarget}`
          );
          continue;
        }
        // Copy the target content instead of recreating the symlink
        const realStat = fs.statSync(sourcePath);
        if (realStat.isDirectory()) {
          await this.copyDirectory(realTarget, targetPath);
        } else {
          fs.copyFileSync(sourcePath, targetPath);
        }
      } else if (lstat.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }

  /**
   * Install a skill from a directory
   *
   * options.sidecar：市场安装传入 `{appId, displayName, version, source:'marketplace'}`；
   * 本地安装省略时写入 `{source:'local'}`。同名覆盖安装（更新）保留旧的 enabled 状态
   * （loadGlobalSkills 经 getPersistedEnabled 从 DB 读回）。
   */
  async installSkill(
    skillPath: string,
    options?: { enabled?: boolean; sidecar?: Partial<SkillSidecar> }
  ): Promise<Skill> {
    // Validate skill folder
    const validation = await this.validateSkillFolder(skillPath);
    if (!validation.valid) {
      throw new Error(`Invalid skill folder: ${validation.errors.join(', ')}`);
    }

    // Get skill metadata
    const metadata = this.getSkillMetadata(skillPath);
    if (!metadata) {
      throw new Error('Failed to read skill metadata from SKILL.md');
    }

    // Validate skill name is safe for filesystem operations
    validateSkillName(metadata.name);

    // Load global skills to check for existing
    await this.loadGlobalSkills();

    // Check if skill with same name already exists in global directory
    // Use app-specific skills directory to avoid conflicts with user settings
    const globalSkillsPath = this.getGlobalSkillsPath();
    const targetPath = path.join(globalSkillsPath, metadata.name);

    const normalizedSkillName = metadata.name.toLowerCase();
    for (const [skillId, skill] of this.loadedSkills.entries()) {
      if (skill.name.toLowerCase() === normalizedSkillName) {
        this.loadedSkills.delete(skillId);
        log(`Removing existing skill: ${skill.name} (${skillId})`);
      }
    }

    if (isDanglingSymlink(targetPath)) {
      try {
        fs.unlinkSync(targetPath);
        log(`Removed dangling symlink at: ${targetPath}`);
      } catch {
        if (isDanglingSymlink(targetPath))
          throw new Error(`Cannot remove dangling symlink: ${targetPath}`);
      }
    } else if (fs.existsSync(targetPath)) {
      // Delete existing directory
      fs.rmSync(targetPath, { recursive: true, force: true });
      log(`Deleted existing skill directory: ${targetPath}`);
    }

    // Copy skill to global directory
    await this.copySkillToGlobal(skillPath, metadata.name);

    // 写入安装态 sidecar（市场安装携带 appId/version；本地安装记录来源与时间）。
    // 注意：源目录若自带旧 sidecar，copyDirectory 已将其复制过来，这里覆盖写入。
    writeSkillSidecar(targetPath, options?.sidecar ?? { source: 'local' });

    // Reload from global directory and return canonical global skill entry.
    this.invalidateGlobalSkillsCache();
    const globalSkills = await this.loadGlobalSkills();
    const installedSkill = globalSkills.find(
      (skill) => skill.name.toLowerCase() === normalizedSkillName
    );

    if (!installedSkill) {
      throw new Error(`Installed skill not found after reload: ${metadata.name}`);
    }

    // Save canonical skill entry (stable id: global-<folderName>).
    // 安装即启用（用户决策）：enabled 默认 true；调用方仅可显式关闭。
    // 同名覆盖安装（更新）时保留此前的 enabled 状态——DB 行在覆盖前已存在，
    // getPersistedEnabled 读回旧值；首次安装无 DB 行，按默认启用。
    const previousEnabled = this.getPersistedEnabled(installedSkill.id, options?.enabled !== false);
    installedSkill.enabled = previousEnabled;
    this.loadedSkills.set(installedSkill.id, installedSkill);
    this.saveSkill(installedSkill);

    log(`Installed skill: ${installedSkill.name} (${installedSkill.id})`);
    return installedSkill;
  }

  private deduplicateSkills(skills: Skill[]): Skill[] {
    const byName = new Map<string, Skill>();

    for (const skill of skills) {
      const key = skill.name.toLowerCase();
      const existing = byName.get(key);

      if (!existing) {
        byName.set(key, skill);
        continue;
      }

      // Prefer canonical global/custom entries over transient custom entries.
      if (existing.id.startsWith('custom-') && !skill.id.startsWith('custom-')) {
        byName.set(key, skill);
      }
    }

    return Array.from(byName.values());
  }

  async validatePluginFolder(
    pluginRootPath: string
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    if (!fs.existsSync(pluginRootPath)) {
      return { valid: false, errors: ['Path does not exist'] };
    }

    const stat = fs.statSync(pluginRootPath);
    if (!stat.isDirectory()) {
      return { valid: false, errors: ['Path is not a directory'] };
    }

    const skillsRootPath = path.join(pluginRootPath, 'skills');
    if (!fs.existsSync(skillsRootPath) || !fs.statSync(skillsRootPath).isDirectory()) {
      errors.push('Plugin has no installable skills');
      return { valid: false, errors };
    }

    const entries = fs.readdirSync(skillsRootPath, { withFileTypes: true });
    const hasInstallableSkill = entries.some((entry) => {
      if (!entry.isDirectory()) return false;
      const skillMdPath = path.join(skillsRootPath, entry.name, 'SKILL.md');
      return fs.existsSync(skillMdPath);
    });

    if (!hasInstallableSkill) {
      errors.push('Plugin has no installable skills');
    }

    return { valid: errors.length === 0, errors };
  }

  async installPluginFromDirectory(pluginRootPath: string): Promise<PluginInstallResult> {
    const validation = await this.validatePluginFolder(pluginRootPath);
    if (!validation.valid) {
      throw new Error(`Invalid plugin folder: ${validation.errors.join(', ')}`);
    }

    const pluginJsonPath = path.join(pluginRootPath, '.claude-plugin', 'plugin.json');
    let pluginName = path.basename(pluginRootPath);
    try {
      const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8')) as PluginManifest;
      pluginName = manifest.name?.trim() || pluginName;
    } catch {
      // ignore, fallback to directory name
    }

    const skillsRootPath = path.join(pluginRootPath, 'skills');
    if (!fs.existsSync(skillsRootPath) || !fs.statSync(skillsRootPath).isDirectory()) {
      throw new Error('Plugin has no installable skills');
    }

    const entries = fs.readdirSync(skillsRootPath, { withFileTypes: true });
    const skillDirs = entries.filter((entry) => entry.isDirectory());
    if (skillDirs.length === 0) {
      throw new Error('Plugin has no installable skills');
    }

    const result: PluginInstallResult = {
      pluginName,
      installedSkills: [],
      skippedSkills: [],
      errors: [],
    };

    for (const skillDir of skillDirs) {
      const skillFolderPath = path.join(skillsRootPath, skillDir.name);
      const skillMdPath = path.join(skillFolderPath, 'SKILL.md');

      if (!fs.existsSync(skillMdPath)) {
        result.skippedSkills.push(skillDir.name);
        continue;
      }

      try {
        const installedSkill = await this.installSkill(skillFolderPath);
        result.installedSkills.push(installedSkill.name);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push(`${skillDir.name}: ${message}`);
      }
    }

    if (result.installedSkills.length === 0 && result.errors.length > 0) {
      throw new Error(`Failed to install plugin skills: ${result.errors.join('; ')}`);
    }

    if (result.installedSkills.length === 0) {
      throw new Error('Plugin has no installable skills');
    }

    log(`Installed plugin skills: ${pluginName} (${result.installedSkills.length} skills)`);
    return result;
  }

  /**
   * Uninstall a skill (delete from filesystem and database).
   * 全面安装制：所有已安装技能均可卸载，无内置守卫。
   */
  async uninstallSkill(skillId: string): Promise<void> {
    const skill = this.loadedSkills.get(skillId);

    if (!skill) {
      throw new Error('Skill not found');
    }

    // 防御性守卫：插件前缀 id 不属于全局目录管理范围，避免按名字误删同名技能
    if (skillId.startsWith('plugin-')) {
      throw new Error('Cannot delete plugin skills; manage them in plugin settings');
    }

    // Stop MCP server if running
    await this.stopMcpServer(skillId);

    // Remove from filesystem (only for custom skills in global directory)
    if (skill.type === 'custom') {
      // Validate skill name before using it in path construction
      validateSkillName(skill.name);

      // Use app-specific skills directory to avoid conflicts with user settings
      const globalSkillsPath = this.getGlobalSkillsPath();
      const skillDir = path.join(globalSkillsPath, skill.name);

      if (fs.existsSync(skillDir)) {
        fs.rmSync(skillDir, { recursive: true, force: true });
        log(`Deleted skill directory: ${skillDir}`);
      }
    }

    // Remove from loaded skills
    this.loadedSkills.delete(skillId);
    this.invalidateGlobalSkillsCache();

    // Delete from database
    const stmt = this.db.prepare('DELETE FROM skills WHERE id = ?');
    stmt.run(skillId);

    log(`Uninstalled skill: ${skill.name} (${skillId})`);
  }
}
