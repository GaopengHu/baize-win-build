/**
 * @module main/claude/skills-runtime
 *
 * Runner 侧 Skills 运行时（AGENT-RUNNER-REFACTOR-PLAN.md §3.7 / Phase 2）：
 * 目录同步、软链接、asar 兼容、skillPaths 解析——与查询执行解耦的资源准备。
 *
 * 全面安装制：技能只能来自全局技能目录（用户配置路径，或默认的运行时目录）。
 * 不再播种内置技能、不再导入 ~/.claude/skills、不再合并插件自带 skills 目录。
 * 老版本升级时通过 cleanupLegacyDiscoveryLinks() 清理自动发现产物（symlink）。
 *
 * 命名冲突警示：项目已存在 src/main/skills/skills-manager.ts（配置层，导出
 * SkillsManager）。本文件是 Runner 侧运行时，类名 SkillsRuntime，不建
 * claude/skills/ 目录。边界：SkillsRuntime 通过构造注入的 SkillsAdapter
 * 拿到配置好的 skillPaths，不反向依赖 SkillsManager 内部实现。
 */
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { configStore } from '../config/config-store';
import { log, logWarn } from '../utils/logger';
import type { SkillsAdapter } from '../skills/skills-adapter';

export interface SkillsRuntimeDeps {
  skillsAdapter?: SkillsAdapter;
}

export class SkillsRuntime {
  private setupDone = false;

  private readonly skillsAdapter?: SkillsAdapter;

  constructor(deps: SkillsRuntimeDeps) {
    this.skillsAdapter = deps.skillsAdapter;
  }

  /** Call after the user installs / removes a skill so the next query re-links everything. */
  invalidate(): void {
    this.setupDone = false;
  }

  /**
   * Skills directory setup: only runs on the first query per runner instance.
   * Symlinks and directories are stable across queries; re-running every time
   * wastes ~10-30 syscalls per query for no benefit. Call invalidate()
   * to force a re-run after the user installs or removes a skill.
   */
  ensureSetup(): void {
    // Set flag at start to prevent re-entrant calls from concurrent queries
    if (this.setupDone) return;
    this.setupDone = true;

    const userClaudeDir = this.getAppClaudeDir();

    // Ensure app Claude config directory exists
    if (!fs.existsSync(userClaudeDir)) {
      fs.mkdirSync(userClaudeDir, { recursive: true });
    }

    // Ensure app Claude skills directory exists
    const appSkillsDir = this.getRuntimeSkillsDir();
    if (!fs.existsSync(appSkillsDir)) {
      fs.mkdirSync(appSkillsDir, { recursive: true });
    }

    // 一次性清理老版本自动发现留下的 symlink（指向捆绑技能目录 / ~/.claude/skills）。
    // 真实目录副本（老版本播种的内置技能）保留为普通「本地」技能。
    this.cleanupLegacyDiscoveryLinks(appSkillsDir);

    this.syncConfiguredSkillsToRuntimeDir(appSkillsDir);
  }

  /**
   * 清理全局技能目录中由旧版本自动发现机制创建的 symlink：
   * - 指向捆绑技能目录（.claude/skills → resources/skills 等）的链接
   * - 指向 ~/.claude/skills 下条目的链接
   * 其余条目（真实目录副本、指向用户自定义存储目录的链接）一律保留。
   * 幂等：无匹配 symlink 时为空操作。
   */
  private cleanupLegacyDiscoveryLinks(appSkillsDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(appSkillsDir, { withFileTypes: true });
    } catch {
      return;
    }

    const legacyRoots = this.getLegacyDiscoveryRoots();
    if (legacyRoots.length === 0) return;

    for (const entry of entries) {
      if (!entry.isSymbolicLink()) continue;
      const entryPath = path.join(appSkillsDir, entry.name);
      try {
        const target = fs.readlinkSync(entryPath);
        const resolved = path.resolve(path.dirname(entryPath), target);
        const realpath = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
        const isLegacy = legacyRoots.some(
          (root) =>
            resolved === root ||
            realpath === root ||
            resolved.startsWith(root + path.sep) ||
            realpath.startsWith(root + path.sep)
        );
        if (isLegacy) {
          fs.unlinkSync(entryPath);
          log(`[ClaudeAgentRunner] Removed legacy auto-discovery symlink: ${entryPath}`);
        }
      } catch (err) {
        logWarn(`[ClaudeAgentRunner] Failed to inspect legacy symlink ${entryPath}:`, err);
      }
    }
  }

  /**
   * 旧版本自动发现/播种的源目录集合（仅用于 symlink 清理判定，不用于加载技能）：
   * - 捆绑技能目录：开发态 <repo>/.claude/skills、生产态 resources/skills、
   *   app.asar(.unpacked)/.claude/skills
   * - ~/.claude/skills（旧版本 syncUserSkillsToAppDir 的导入源）
   */
  private getLegacyDiscoveryRoots(): string[] {
    const roots: string[] = [];
    try {
      const appPath = app.getAppPath();
      const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked');
      roots.push(
        path.resolve(path.join(__dirname, '..', '..', '..', '.claude', 'skills')),
        path.resolve(path.join(process.resourcesPath || '', 'skills')),
        path.resolve(path.join(unpackedPath, '.claude', 'skills')),
        path.resolve(path.join(appPath, '.claude', 'skills'))
      );
    } catch {
      // app 未就绪时跳过捆绑目录判定
    }
    try {
      roots.push(path.resolve(path.join(app.getPath('home'), '.claude', 'skills')));
    } catch {
      // home 不可解析时跳过
    }
    return roots;
  }

  /** Fallback skill path resolution when SkillsAdapter is not provided. */
  private legacySkillPaths(): string[] {
    const paths: string[] = [];
    const global = this.getConfiguredGlobalSkillsDir();
    if (global && fs.existsSync(global)) paths.push(global);
    return paths;
  }

  /**
   * 运行时技能路径 = 仅全局目录中启用的技能路径。
   * 插件自带 skills 目录不再合并（插件工具/扩展能力不受影响）。
   */
  async resolveSkillPaths(_sessionId?: string): Promise<string[]> {
    const basePaths = this.skillsAdapter
      ? await this.skillsAdapter.getSkillPaths()
      : this.legacySkillPaths();
    const mergedPaths = new Set(
      basePaths.filter((item): item is string => Boolean(item && fs.existsSync(item)))
    );
    return Array.from(mergedPaths);
  }

  getAppClaudeDir(): string {
    return path.join(app.getPath('userData'), 'claude');
  }

  getRuntimeSkillsDir(): string {
    return path.join(this.getAppClaudeDir(), 'skills');
  }

  private getConfiguredGlobalSkillsDir(): string {
    const configuredPath = (configStore.get('globalSkillsPath') || '').trim();
    if (!configuredPath) {
      return this.getRuntimeSkillsDir();
    }

    const resolvedPath = path.resolve(configuredPath);
    try {
      if (!fs.existsSync(resolvedPath)) {
        fs.mkdirSync(resolvedPath, { recursive: true });
      }
      if (fs.statSync(resolvedPath).isDirectory()) {
        return resolvedPath;
      }
      logWarn(
        '[ClaudeAgentRunner] Configured skills path is not a directory, fallback to runtime path:',
        resolvedPath
      );
    } catch (error) {
      logWarn(
        '[ClaudeAgentRunner] Configured skills path is unavailable, fallback to runtime path:',
        resolvedPath,
        error
      );
    }

    return this.getRuntimeSkillsDir();
  }

  syncConfiguredSkillsToRuntimeDir(runtimeSkillsDir: string): void {
    const configuredSkillsDir = this.getConfiguredGlobalSkillsDir();
    if (configuredSkillsDir === runtimeSkillsDir) {
      return;
    }
    if (!fs.existsSync(configuredSkillsDir) || !fs.statSync(configuredSkillsDir).isDirectory()) {
      return;
    }

    const entries = fs.readdirSync(configuredSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sourcePath = path.join(configuredSkillsDir, entry.name);
      const targetPath = path.join(runtimeSkillsDir, entry.name);
      try {
        if (fs.existsSync(targetPath)) {
          // Use lstatSync so we don't follow symlinks — check the entry itself
          const stat = fs.lstatSync(targetPath);
          if (stat.isSymbolicLink()) {
            fs.unlinkSync(targetPath);
          } else {
            fs.rmSync(targetPath, { recursive: true, force: true });
          }
        }
        fs.symlinkSync(sourcePath, targetPath, 'dir');
      } catch (err) {
        try {
          this.copyDirectorySync(sourcePath, targetPath);
        } catch (copyErr) {
          logWarn('[ClaudeAgentRunner] Failed to sync configured skill:', entry.name, copyErr);
        }
      }
    }
  }

  private copyDirectorySync(source: string, target: string): void {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
    }

    const entries = fs.readdirSync(source);
    for (const entry of entries) {
      const sourcePath = path.join(source, entry);
      const targetPath = path.join(target, entry);
      const stat = fs.statSync(sourcePath);

      if (stat.isDirectory()) {
        this.copyDirectorySync(sourcePath, targetPath);
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }
}
