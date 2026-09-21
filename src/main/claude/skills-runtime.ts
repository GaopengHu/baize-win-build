/**
 * @module main/claude/skills-runtime
 *
 * Runner 侧 Skills 运行时（AGENT-RUNNER-REFACTOR-PLAN.md §3.7 / Phase 2）：
 * 目录同步、软链接、asar 兼容、skillPaths 解析——与查询执行解耦的资源准备。
 *
 * 命名冲突警示：项目已存在 src/main/skills/skills-manager.ts（配置层，导出
 * SkillsManager）。本文件是 Runner 侧运行时，类名 SkillsRuntime，不建
 * claude/skills/ 目录。边界：SkillsRuntime 通过构造注入的 SkillsAdapter
 * 拿到配置好的 skillPaths，不反向依赖 SkillsManager 内部实现。
 *
 * 注意 __dirname 语义：主进程被 vite 打包为单 chunk（inlineDynamicImports），
 * 运行时 __dirname 恒为 dist-electron/main，与源码所在目录无关，因此
 * getBuiltinSkillsPath() 的相对路径解析行为与迁移前（agent-runner.ts 内）一致。
 */
import * as path from 'path';
import * as fs from 'fs';
import { app } from 'electron';
import { configStore } from '../config/config-store';
import { log, logWarn } from '../utils/logger';
import type { PluginRuntimeService } from '../skills/plugin-runtime-service';
import type { SkillsAdapter } from '../skills/skills-adapter';
import type { ServerEvent } from '../../renderer/types';

export interface SkillsRuntimeDeps {
  sendToRenderer: (event: ServerEvent) => void;
  pluginRuntimeService?: PluginRuntimeService;
  skillsAdapter?: SkillsAdapter;
}

export class SkillsRuntime {
  private setupDone = false;

  private readonly sendToRenderer: (event: ServerEvent) => void;
  private readonly pluginRuntimeService?: PluginRuntimeService;
  private readonly skillsAdapter?: SkillsAdapter;

  constructor(deps: SkillsRuntimeDeps) {
    this.sendToRenderer = deps.sendToRenderer;
    this.pluginRuntimeService = deps.pluginRuntimeService;
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

    // Copy built-in skills to app Claude skills directory if they don't exist
    const builtinSkillsPath = this.getBuiltinSkillsPath();
    if (builtinSkillsPath && fs.existsSync(builtinSkillsPath)) {
      // Symlinks into .asar archives don't work at the OS level (ENOTDIR),
      // so always copy when the source is inside an asar archive.
      // Use regex to match .asar/ but NOT .asar.unpacked/ (which is a real directory).
      const sourceInsideAsar = /\.asar[/\\]/.test(builtinSkillsPath);
      const builtinSkills = fs.readdirSync(builtinSkillsPath);
      for (const skillName of builtinSkills) {
        const builtinSkillPath = path.join(builtinSkillsPath, skillName);
        const userSkillPath = path.join(appSkillsDir, skillName);

        // Clean up broken symlinks pointing into .asar from previous versions
        try {
          const lstat = fs.lstatSync(userSkillPath);
          if (lstat.isSymbolicLink()) {
            const linkTarget = fs.readlinkSync(userSkillPath);
            if (/\.asar[/\\]/.test(linkTarget)) {
              fs.unlinkSync(userSkillPath);
              log(`[ClaudeAgentRunner] Removed broken asar symlink: ${userSkillPath}`);
            }
          }
        } catch {
          // Path doesn't exist — fine, we'll create it below
        }

        // Only set up if it's a directory and doesn't exist in app directory
        if (fs.statSync(builtinSkillPath).isDirectory() && !fs.existsSync(userSkillPath)) {
          if (sourceInsideAsar) {
            // Source is inside .asar — must copy (symlinks to asar paths fail at OS level)
            this.copyDirectorySync(builtinSkillPath, userSkillPath);
            log(`[ClaudeAgentRunner] Copied built-in skill from asar: ${skillName}`);
          } else {
            // Source is a real directory — symlink for space efficiency
            try {
              fs.symlinkSync(builtinSkillPath, userSkillPath, 'dir');
              log(`[ClaudeAgentRunner] Linked built-in skill: ${skillName}`);
            } catch (err) {
              logWarn(`[ClaudeAgentRunner] Failed to symlink ${skillName}, copying instead:`, err);
              this.copyDirectorySync(builtinSkillPath, userSkillPath);
            }
          }
        }
      }
    }

    this.syncUserSkillsToAppDir(appSkillsDir);
    this.syncConfiguredSkillsToRuntimeDir(appSkillsDir);
  }

  /** Fallback skill path resolution when SkillsAdapter is not provided. */
  private legacySkillPaths(): string[] {
    const paths: string[] = [];
    const builtin = this.getBuiltinSkillsPath();
    if (builtin && fs.existsSync(builtin)) paths.push(builtin);
    const global = this.getConfiguredGlobalSkillsDir();
    if (global && fs.existsSync(global)) paths.push(global);
    return paths;
  }

  async resolveSkillPaths(sessionId?: string): Promise<string[]> {
    const basePaths = this.skillsAdapter
      ? await this.skillsAdapter.getSkillPaths()
      : this.legacySkillPaths();
    const mergedPaths = new Set(
      basePaths.filter((item): item is string => Boolean(item && fs.existsSync(item)))
    );
    const appliedPlugins: Array<{ name: string; path: string }> = [];

    if (this.pluginRuntimeService) {
      try {
        const runtimePlugins = await this.pluginRuntimeService.getEnabledRuntimePlugins();
        for (const plugin of runtimePlugins) {
          if (!plugin.componentsEnabled.skills || plugin.componentCounts.skills <= 0) {
            continue;
          }
          const runtimeSkillsPath = path.join(plugin.runtimePath, 'skills');
          if (!fs.existsSync(runtimeSkillsPath)) {
            continue;
          }
          mergedPaths.add(runtimeSkillsPath);
          appliedPlugins.push({ name: plugin.name, path: runtimeSkillsPath });
        }
      } catch (error) {
        logWarn('[ClaudeAgentRunner] Failed to resolve runtime plugin skill paths:', error);
      }
    }

    if (sessionId && appliedPlugins.length > 0) {
      this.sendToRenderer({
        type: 'plugins.runtimeApplied',
        payload: { sessionId, plugins: appliedPlugins },
      });
    }

    return Array.from(mergedPaths);
  }

  /**
   * Get the built-in skills directory (shipped with the app)
   */
  getBuiltinSkillsPath(): string {
    // In development, skills are in the project's .claude/skills directory
    // In production, they're extracted via extraResources to resources/skills
    const appPath = app.getAppPath();
    const unpackedPath = appPath.replace(/\.asar$/, '.asar.unpacked');

    const possiblePaths = [
      // Development: relative to this file
      path.join(__dirname, '..', '..', '..', '.claude', 'skills'),
      // Production: extraResources extracts .claude/skills → resources/skills
      // This is the preferred production path (real directory, no asar issues)
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
        log('[ClaudeAgentRunner] Found built-in skills at:', p);
        return p;
      }
    }

    logWarn('[ClaudeAgentRunner] No built-in skills directory found');
    return '';
  }

  /**
   * Check if a directory physically exists on disk, bypassing Electron's
   * asar interception.
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

  private getUserClaudeSkillsDir(): string {
    return path.join(app.getPath('home'), '.claude', 'skills');
  }

  syncUserSkillsToAppDir(appSkillsDir: string): void {
    const userSkillsDir = this.getUserClaudeSkillsDir();
    if (!fs.existsSync(userSkillsDir)) {
      return;
    }

    const entries = fs.readdirSync(userSkillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sourcePath = path.join(userSkillsDir, entry.name);
      const targetPath = path.join(appSkillsDir, entry.name);

      if (fs.existsSync(targetPath)) {
        try {
          const stat = fs.lstatSync(targetPath);
          if (!stat.isSymbolicLink()) {
            continue;
          }
          fs.unlinkSync(targetPath);
        } catch {
          continue;
        }
      }

      try {
        fs.symlinkSync(sourcePath, targetPath, 'dir');
      } catch (err) {
        try {
          this.copyDirectorySync(sourcePath, targetPath);
        } catch (copyErr) {
          logWarn('[ClaudeAgentRunner] Failed to import user skill:', entry.name, copyErr);
        }
      }
    }
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
