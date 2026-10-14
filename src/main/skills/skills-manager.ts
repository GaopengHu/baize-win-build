/**
 * @module main/skills/skills-manager
 *
 * Skill discovery and lifecycle (999 lines).
 *
 * Responsibilities:
 * - Discovers built-in skills from .claude/skills/ directories
 * - Parses SKILL.md front-matter for metadata (name, description, triggers)
 * - Hot-reload via chokidar file watcher
 * - Plugin install/uninstall from npm-style package specs
 *
 * Dependencies: config-store, database, chokidar
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import { getAgentDir, loadSkillsFromDir } from '@mariozechner/pi-coding-agent';
import type { Skill, PluginInstallResult, SkillLoadDiagnostic } from '../../renderer/types';
import type { DatabaseInstance } from '../db/database';
import { log, logError, logWarn } from '../utils/logger';
import { isPathWithinRoot } from '../tools/path-containment';
import type { SkillsAdapter } from './skills-adapter';

/**
 * Built-in skills that are enabled by default on first run.
 * Any other skill dropped into the built-in skills directory
 * (e.g. `.claude/skills/<name>/SKILL.md`) defaults to disabled
 * until the user flips its power toggle in settings.
 */
const DEFAULT_ENABLED_BUILTIN_SKILLS = new Set([
  'docx',
  'pdf',
  'pptx',
  'xlsx',
  'skill-creator',
  'gov-procurement-review',
]);

/**
 * Validate that a skill name is safe for use as a directory name.
 * Rejects names containing path separators or parent directory references.
 */
/**
 * 市场安装 sidecar（`.nowlink-marketplace.json`）读取：{ appId, displayName }。
 * 显示层用 displayName（中文），内部名/目录名保持包内英文，模型调用不受影响。
 * 无文件或解析失败返回 null，调用方回退显示内部名。
 */
export function readMarketplaceDisplayName(skillDir: string): string | null {
  try {
    const sidecar = path.join(skillDir, '.nowlink-marketplace.json');
    if (!fs.existsSync(sidecar)) return null;
    const raw = JSON.parse(fs.readFileSync(sidecar, 'utf-8')) as {
      displayName?: unknown;
    };
    const name = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
    return name || null;
  } catch {
    return null;
  }
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
  /**
   * 插件运行时提供者（结构性 duck-type，避免与 PluginRuntimeService 的模块级
   * 循环 import——与 setSkillsManager 相同的 late-binding 思路）。
   */
  pluginProvider?: RuntimePluginSkillsProvider;
}

/**
 * getEnabledRuntimePlugins() 的最小结构化视图（InstalledPlugin 的子集），
 * 只要求枚举插件技能目录所需的字段。
 */
export interface RuntimePluginSkillsProvider {
  getEnabledRuntimePlugins(): Promise<
    Array<{
      name: string;
      runtimePath: string;
      componentsEnabled: { skills?: boolean };
      componentCounts: { skills?: number };
    }>
  >;
}

/**
 * 一次技能枚举中的候选条目——菜单（getAvailableSkills）与展开
 * （getSkillPaths）共享的唯一中间表示。path 为 undefined 表示该候选
 * 只参与名字去重（如 legacy .json 条目），不会进入 skillPaths。
 */
interface SkillCandidate {
  /** 渲染层 Skill.id：builtin-<dir> / global-<dir> / plugin-<plugin>-<name> / project-<name> / user-<name> */
  id: string;
  name: string;
  description: string;
  displayName?: string;
  origin: 'builtin' | 'global' | 'plugin' | 'project' | 'user';
  /** 技能目录（SDK Skill.baseDir）；undefined = 仅名字占位（SDK 自动加载，不进 skillPaths） */
  path?: string;
  enabled: boolean;
  createdAt: number;
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
 * Skills loading priority:
 * 1. Project-level: <project>/.skills/ or <project>/skills/
 * 2. Global: <userData>/claude/skills/ (includes ~/.claude/skills read-only)
 * 3. Built-in skills
 */
export class SkillsManager implements SkillsAdapter {
  private db: DatabaseInstance;
  private loadedSkills: Map<string, Skill> = new Map();
  private runningServers: Map<string, { process: unknown; skill: Skill }> = new Map();
  private getConfiguredGlobalSkillsPathFn?: () => string | undefined;
  private setConfiguredGlobalSkillsPathFn?: (nextPath: string) => void;
  private pluginProvider?: RuntimePluginSkillsProvider;
  private watchStorageEnabled: boolean;
  private storageWatcher: FSWatcher | null = null;
  private storagePollingTimer: NodeJS.Timeout | null = null;
  private lastStorageSignature = '';
  private loadedGlobalSkillsSignature = '';
  private globalSkillsLoaded = false;
  private storageCallbacks = new Set<(event: SkillsStorageChangeEvent) => void>();
  /** 最近一次枚举收集的加载诊断（枚举期，每次 collectSkillCandidates 重置） */
  private lastLoadDiagnostics: SkillLoadDiagnostic[] = [];
  /** 构造期/持久化加载路径记录的诊断（loadBuiltinSkills 等），跨枚举保留 */
  private pendingDiagnostics: SkillLoadDiagnostic[] = [];

  constructor(db: DatabaseInstance, options: SkillsManagerOptions = {}) {
    this.db = db;
    this.getConfiguredGlobalSkillsPathFn = options.getConfiguredGlobalSkillsPath;
    this.setConfiguredGlobalSkillsPathFn = options.setConfiguredGlobalSkillsPath;
    this.pluginProvider = options.pluginProvider;
    this.watchStorageEnabled = options.watchStorage === true;
    this.loadBuiltinSkills();
    if (this.watchStorageEnabled) {
      this.startStorageWatcher();
    }
  }

  /** PluginRuntimeService 的晚绑定入口（与 setSkillsManager 对称，避免循环依赖）。 */
  setPluginProvider(provider: RuntimePluginSkillsProvider): void {
    this.pluginProvider = provider;
  }

  /**
   * Load built-in skills
   */
  private loadBuiltinSkills(): void {
    // Load skills from .claude/skills directory (like pdf, xlsx, docx, pptx)
    const builtinSkillsPath = this.getBuiltinSkillsPath();
    if (builtinSkillsPath) {
      try {
        const skillDirs = fs.readdirSync(builtinSkillsPath);

        for (const dir of skillDirs) {
          const skillPath = path.join(builtinSkillsPath, dir);

          if (isDanglingSymlink(skillPath)) {
            logWarn(`[Skills] Skipping dangling symlink in built-in skills: ${skillPath}`);
            continue;
          }

          let stat: fs.Stats;
          try {
            stat = fs.statSync(skillPath);
          } catch {
            continue;
          }

          if (!stat.isDirectory()) continue;

          // Look for SKILL.md
          const skillMdPath = path.join(skillPath, 'SKILL.md');
          if (!fs.existsSync(skillMdPath)) continue;

          // Parse metadata
          const metadata = this.getSkillMetadata(skillPath);
          if (!metadata) continue;

          const existing = this.loadedSkills.get(`builtin-${dir}`);
          const enabled = this.getPersistedEnabled(
            `builtin-${dir}`,
            DEFAULT_ENABLED_BUILTIN_SKILLS.has(dir.toLowerCase())
          );

          const skill: Skill = {
            id: `builtin-${dir}`,
            name: metadata.name,
            description: metadata.description,
            type: 'builtin',
            enabled,
            createdAt: existing?.createdAt ?? Date.now(),
          };

          this.loadedSkills.set(skill.id, skill);
          log(`Loaded built-in skill: ${skill.name} (enabled=${enabled})`);
        }
      } catch (error) {
        logError('Failed to load built-in skills from .claude/skills:', error);
      }
    }
  }

  /**
   * Get the built-in skills directory path
   */
  private getBuiltinSkillsPath(): string {
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked');

    const possiblePaths = [
      // Development
      path.join(__dirname, '..', '..', '..', '.claude', 'skills'),
      // Production: extraResources extracts .claude/skills → resources/skills
      path.join(process.resourcesPath || '', 'skills'),
      // Legacy: in app.asar.unpacked (for older builds with asarUnpack)
      ...(this.physicalDirExists(path.join(unpackedPath, '.claude', 'skills'))
        ? [path.join(unpackedPath, '.claude', 'skills')]
        : []),
      // Last resort: read from inside the asar archive (Electron intercepts this)
      path.join(appPath, '.claude', 'skills'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return '';
  }

  /**
   * Check if a directory physically exists on disk, bypassing Electron's
   * asar interception. Uses try/catch with lstatSync on the real filesystem.
   */
  private physicalDirExists(dirPath: string): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const originalFs = require('original-fs') as typeof import('fs');
      return originalFs.existsSync(dirPath) && originalFs.statSync(dirPath).isDirectory();
    } catch {
      return false;
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

  private clearSkillsBySource(source: 'project' | 'global'): void {
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

  private getUserSkillsPath(): string {
    return path.join(app.getPath('home'), '.claude', 'skills');
  }

  private async importUserSkills(globalSkillsPath: string): Promise<void> {
    const userSkillsPath = this.getUserSkillsPath();
    if (!fs.existsSync(userSkillsPath)) {
      return;
    }

    const entries = fs.readdirSync(userSkillsPath, { withFileTypes: true });
    for (const entry of entries) {
      // Dirent.isDirectory() returns false for symlinks; check symlinks separately
      const sourcePath = path.join(userSkillsPath, entry.name);
      if (entry.isSymbolicLink()) {
        if (isDanglingSymlink(sourcePath)) {
          logWarn(`[Skills] Skipping dangling symlink in user skills: ${sourcePath}`);
          continue;
        }
        // Valid symlink — resolve to check if it's a directory
        try {
          if (!fs.statSync(sourcePath).isDirectory()) continue;
        } catch {
          continue;
        }
      } else if (!entry.isDirectory()) {
        continue;
      }

      const targetPath = path.join(globalSkillsPath, entry.name);

      // Clean up dangling symlinks at the target before re-importing
      if (isDanglingSymlink(targetPath)) {
        try {
          fs.unlinkSync(targetPath);
          logWarn(`[Skills] Removed dangling symlink at target: ${targetPath}`);
        } catch (unlinkErr) {
          logError(`[Skills] Failed to remove dangling symlink: ${targetPath}`, unlinkErr);
          continue;
        }
      } else if (fs.existsSync(targetPath)) {
        continue;
      }

      try {
        fs.symlinkSync(sourcePath, targetPath, 'dir');
      } catch (err) {
        try {
          await this.copyDirectory(sourcePath, targetPath);
        } catch (copyErr) {
          logError(`Failed to import user skill from ${sourcePath}:`, copyErr);
        }
      }
    }
  }

  /**
   * Load skills from a project directory
   */
  async loadProjectSkills(projectPath: string): Promise<Skill[]> {
    const skills: Skill[] = [];
    this.clearSkillsBySource('project');

    // Check for .skills/ or skills/ directory
    const skillsDirs = [path.join(projectPath, '.skills'), path.join(projectPath, 'skills')];

    for (const skillsDir of skillsDirs) {
      if (fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory()) {
        const loadedSkills = await this.loadSkillsFromDirectory(skillsDir, 'project');
        skills.push(...loadedSkills);
      }
    }

    return skills;
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

    await this.importUserSkills(globalSkillsPath);
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
   * Load skills from a directory
   */
  private async loadSkillsFromDirectory(
    dir: string,
    source: 'project' | 'global'
  ): Promise<Skill[]> {
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

            const skill: Skill = {
              id: `${source}-${entry}`,
              name: metadata.name,
              // 市场安装时写入的中文展示名（内部名保持包内英文，模型调用不受影响）
              displayName: readMarketplaceDisplayName(entryPath) ?? undefined,
              description: metadata.description,
              type: 'custom',
              enabled: this.getPersistedEnabled(`${source}-${entry}`, true),
              createdAt: Date.now(),
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
   */
  async getActiveSkills(_sessionId: string, projectPath?: string): Promise<Skill[]> {
    const skills: Skill[] = [];

    // 1. Add built-in skills
    for (const skill of this.loadedSkills.values()) {
      if (skill.type === 'builtin' && skill.enabled) {
        skills.push(skill);
      }
    }

    // 2. Add global skills
    const globalSkills = await this.loadGlobalSkills();
    skills.push(...globalSkills.filter((s) => s.enabled));

    // 3. Add project skills (highest priority, can override)
    if (projectPath) {
      const projectSkills = await this.loadProjectSkills(projectPath);

      // Project skills can override global/builtin by name
      for (const projectSkill of projectSkills) {
        if (!projectSkill.enabled) continue;

        const existingIndex = skills.findIndex((s) => s.name === projectSkill.name);
        if (existingIndex >= 0) {
          skills[existingIndex] = projectSkill;
        } else {
          skills.push(projectSkill);
        }
      }
    }

    return skills;
  }

  /**
   * 技能宇宙的唯一枚举入口（单一真相源）。
   *
   * 覆盖四类来源，与 /skill:<name> 展开时 SDK 实际加载的集合对齐：
   * - builtin：<.claude/skills> 根目录（本管理器存储）
   * - global：<userData>/claude/skills（含 ~/.claude/skills 符号链接导入 + legacy .json）
   * - plugin：插件运行时 <runtimePath>/skills（过滤条件与 skills-runtime.resolveSkillPaths 一致）
   * - project/user：SDK 按会话 cwd 自动发现的目录（<cwd>/.pi/skills、祖先 .agents/skills、
   *   getAgentDir()/skills、~/.agents/skills）——由 SDK packageManager 自行加载，
   *   不经过 getSkillPaths，因此 path 为 undefined（仅名字占位，供菜单展示）。
   *
   * frontmatter 解析统一走 SDK 的 loadSkillsFromDir（name 缺失时回退目录名、
   * description 必填、SKILL.md 目录不递归），保证菜单与展开的解析语义完全一致。
   *
   * 名字去重（小写）：builtin 优先；其余先注册者优先——与原 getSkillPaths 语义一致。
   * 解析失败/告警写入 lastLoadDiagnostics 供设置页展示。
   */
  private async collectSkillCandidates(cwd?: string): Promise<SkillCandidate[]> {
    const diagnostics: SkillLoadDiagnostic[] = [];
    const byName = new Map<string, SkillCandidate>();

    const addCandidate = (candidate: SkillCandidate): void => {
      const key = candidate.name.toLowerCase();
      const existing = byName.get(key);
      if (existing && existing.origin === 'builtin') {
        return; // builtin 已决定该名字
      }
      if (!existing || candidate.origin === 'builtin') {
        byName.set(key, candidate);
      }
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

    // 1. 内置技能：以 SDK 解析为准（含 getSkillMetadata 会漏掉的宽松命名条目），
    //    enabled 状态优先取内存中的 loadedSkills（反映本次运行内的开关操作）。
    const builtinRoot = this.getBuiltinSkillsPath();
    if (builtinRoot) {
      for (const skill of enumerateDir(builtinRoot, 'builtin')) {
        const dir = path.basename(skill.baseDir);
        const id = `builtin-${dir}`;
        const loaded = this.loadedSkills.get(id);
        addCandidate({
          id,
          name: skill.name,
          description: skill.description,
          displayName: readMarketplaceDisplayName(skill.baseDir) ?? undefined,
          origin: 'builtin',
          path: skill.baseDir,
          enabled:
            loaded?.enabled ??
            this.getPersistedEnabled(id, DEFAULT_ENABLED_BUILTIN_SKILLS.has(dir.toLowerCase())),
          createdAt: loaded?.createdAt ?? Date.now(),
        });
      }
    }

    // 2. 全局技能：先走 loadGlobalSkills（符号链接导入 / 缓存 / legacy .json 注册），
    //    再以 SDK 解析器枚举目录本身，enabled 取 loadedSkills 中的实时状态。
    const globalSkills = await this.loadGlobalSkills();
    const globalRoot = this.getGlobalSkillsPath();
    const seenGlobalIds = new Set<string>();
    for (const skill of enumerateDir(globalRoot, 'global')) {
      const dir = path.basename(skill.baseDir);
      const id = `global-${dir}`;
      seenGlobalIds.add(id);
      const loaded = this.loadedSkills.get(id);
      addCandidate({
        id,
        name: skill.name,
        description: skill.description,
        displayName: readMarketplaceDisplayName(skill.baseDir) ?? undefined,
        origin: 'global',
        path: skill.baseDir,
        enabled: loaded?.enabled ?? this.getPersistedEnabled(id, true),
        createdAt: loaded?.createdAt ?? Date.now(),
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
        origin: 'global',
        path: undefined,
        enabled: skill.enabled,
        createdAt: skill.createdAt,
      });
    }

    // 3. 插件技能：过滤条件与 skills-runtime.resolveSkillPaths 保持一致
    if (this.pluginProvider) {
      try {
        const plugins = await this.pluginProvider.getEnabledRuntimePlugins();
        for (const plugin of plugins) {
          if (!plugin.componentsEnabled.skills || (plugin.componentCounts.skills ?? 0) <= 0) {
            continue;
          }
          const pluginSkillsDir = path.join(plugin.runtimePath, 'skills');
          if (!fs.existsSync(pluginSkillsDir)) continue;
          for (const skill of enumerateDir(pluginSkillsDir, `plugin:${plugin.name}`)) {
            const id = `plugin-${plugin.name}-${skill.name}`;
            addCandidate({
              id,
              name: skill.name,
              description: skill.description,
              displayName: readMarketplaceDisplayName(skill.baseDir) ?? undefined,
              origin: 'plugin',
              path: skill.baseDir,
              enabled: this.getPersistedEnabled(id, true),
              createdAt: Date.now(),
            });
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        logWarn(`[Skills] Failed to enumerate plugin skills: ${reason}`);
        diagnostics.push({ path: 'plugins', reason });
      }
    }

    // 4. SDK 自动发现目录（project/user）：仅名字占位。
    //    展开时由 SDK packageManager 按会话 cwd 自行加载（includeDefaults:false 时
    //    resource-loader 将自动发现结果与 additionalSkillPaths 合并）。
    const autoDirs: Array<{ dir: string; origin: 'project' | 'user' }> = [];
    const userAgentsSkillsDir = path.join(process.env.HOME || os.homedir(), '.agents', 'skills');
    if (cwd) {
      // <cwd>/.pi/skills（CONFIG_DIR_NAME='.pi'，SDK 未导出该常量）
      autoDirs.push({ dir: path.join(cwd, '.pi', 'skills'), origin: 'project' });
      // 祖先 .agents/skills（向上直到 git 根或文件系统根，排除用户级目录）
      // ——镜像 SDK collectAncestorAgentsSkillDirs/findGitRepoRoot
      let dir = path.resolve(cwd);
      const gitRoot = this.findGitRepoRoot(dir);
      for (;;) {
        const agentsDir = path.join(dir, '.agents', 'skills');
        if (path.resolve(agentsDir) !== path.resolve(userAgentsSkillsDir)) {
          autoDirs.push({ dir: agentsDir, origin: 'project' });
        }
        if (gitRoot && dir === gitRoot) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    // getAgentDir()/skills（尊重 PI_CODING_AGENT_DIR）+ ~/.agents/skills
    autoDirs.push({ dir: path.join(getAgentDir(), 'skills'), origin: 'user' });
    autoDirs.push({ dir: userAgentsSkillsDir, origin: 'user' });

    for (const { dir, origin } of autoDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const skill of enumerateDir(dir, origin)) {
        addCandidate({
          id: `${origin}-${skill.name}`,
          name: skill.name,
          description: skill.description,
          origin,
          path: undefined,
          enabled: true,
          createdAt: Date.now(),
        });
      }
    }

    this.lastLoadDiagnostics = diagnostics;
    // 并入构造期/持久化加载路径记录的诊断（如 loadBuiltinSkills 的解析失败），并清空
    if (this.pendingDiagnostics.length > 0) {
      this.lastLoadDiagnostics.push(...this.pendingDiagnostics);
      this.pendingDiagnostics = [];
    }
    return Array.from(byName.values());
  }

  /** 向上查找 git 仓库根（镜像 SDK findGitRepoRoot：检查 <dir>/.git 是否存在） */
  private findGitRepoRoot(startDir: string): string | null {
    let dir = path.resolve(startDir);
    for (;;) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }

  /**
   * 菜单数据源：返回全部可用技能（builtin + global + plugin + project/user），
   * 与 /skill:<name> 展开时 SDK 实际可解析的技能集合保持一致。
   * cwd 为会话工作目录时包含项目级/用户级自动发现技能。
   */
  async getAvailableSkills(cwd?: string): Promise<Skill[]> {
    const candidates = await this.collectSkillCandidates(cwd);
    return candidates.map((candidate) => {
      const skill: Skill = {
        id: candidate.id,
        name: candidate.name,
        displayName: candidate.displayName,
        description: candidate.description,
        type: candidate.origin === 'builtin' ? ('builtin' as const) : ('custom' as const),
        enabled: candidate.enabled,
        createdAt: candidate.createdAt,
      };
      // 插件候选同步注册进 loadedSkills，使 setEnabled/uninstallSkill 能找到它
      // （builtin/global 本就由 loadBuiltinSkills/loadGlobalSkills 注册）。
      if (candidate.origin === 'plugin' && !this.loadedSkills.has(candidate.id)) {
        this.loadedSkills.set(candidate.id, skill);
      }
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
   * path 为 undefined 的候选（SDK 自动发现目录 / legacy .json）不进入
   * skillPaths——前者由 SDK packageManager 自行加载，后者非 SKILL.md 形态。
   *
   * When the same skill name exists as both a builtin and a global entry
   * (e.g. the app copies builtins into the global dir, or the user installed
   * it before adding the builtin), the builtin entry takes precedence: its
   * enabled state decides whether the skill is exposed at all.
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
   * 对不在 loadedSkills 中的 id（plugin-/project-/user- 前缀，来自
   * getAvailableSkills 的插件/SDK 自动发现候选）也要持久化开关状态——
   * collectSkillCandidates 枚举时通过 getPersistedEnabled 读回。
   */
  setSkillEnabled(skillId: string, enabled: boolean): void {
    const skill = this.loadedSkills.get(skillId);
    if (skill) {
      skill.enabled = enabled;

      // Stop server if disabling an MCP skill
      if (!enabled && skill.type === 'mcp') {
        this.stopMcpServer(skillId);
      }

      // Persist toggle state so builtin/custom skills survive restarts.
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

    // 插件/项目/用户级候选：仅持久化开关（名字/描述留空，枚举时以磁盘为准）
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
   * Delete a skill
   */
  deleteSkill(skillId: string): void {
    // Can't delete built-in skills
    const skill = this.loadedSkills.get(skillId);
    if (skill?.type === 'builtin') {
      throw new Error('Cannot delete built-in skills');
    }

    this.stopMcpServer(skillId);
    this.loadedSkills.delete(skillId);

    const stmt = this.db.prepare('DELETE FROM skills WHERE id = ?');
    stmt.run(skillId);
  }

  /**
   * List all skills with optional filters
   */
  async listSkills(filter?: {
    type?: 'builtin' | 'mcp' | 'custom';
    enabled?: boolean;
  }): Promise<Skill[]> {
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
   */
  async installSkill(skillPath: string, options?: { enabled?: boolean }): Promise<Skill> {
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
    // Callers (e.g. company marketplace installs) can request the skill to
    // start disabled so the user explicitly opts in before it takes effect.
    if (options?.enabled === false) {
      installedSkill.enabled = false;
      this.loadedSkills.set(installedSkill.id, installedSkill);
    }
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
   * Uninstall a skill (delete from filesystem and database)
   */
  async uninstallSkill(skillId: string): Promise<void> {
    const skill = this.loadedSkills.get(skillId);

    if (!skill) {
      throw new Error('Skill not found');
    }

    // Can't delete built-in skills
    if (skill.type === 'builtin') {
      throw new Error('Cannot delete built-in skills');
    }

    // 插件技能随插件生命周期管理（插件设置页卸载/禁用），不支持单独删除——
    // 否则会按名字误删全局目录中的同名技能。
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
