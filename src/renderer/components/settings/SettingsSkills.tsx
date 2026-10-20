import { useState, useEffect, useCallback, useMemo, useRef, useDeferredValue } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle,
  CheckSquare,
  ChevronLeft,
  Package,
  Power,
  PowerOff,
  Search,
  Square,
  Trash2,
  Plus,
  Globe,
  RefreshCw,
  Store,
  X,
} from 'lucide-react';
import type { MarketplaceSkillApp, Skill, SkillLoadDiagnostic } from '../../types';
import { useAppStore } from '../../store';
import { SettingsContentSection } from './shared';
import type { LocalizedBanner } from './shared';
import { MARKETPLACE_CATEGORIES, MarketplaceBrowser } from './MarketplaceBrowser';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

/** 统一技能页的视图（首页默认 = 技能市场；'已安装' 为第二视图） */
export type SkillsView = 'installed' | 'market';

/**
 * 统一「技能」页（全面安装制）：技能市场 / 已安装双视图，类似 VSCode 扩展面板。
 *
 * - 首页（默认视图）= 技能市场：MarketplaceBrowser（服务端目录 + 已安装态 join +
 *   按钮状态机 + 卡片点击进详情）。
 * - 已安装视图：全局目录技能的市场同款卡片网格（点击进详情），
 *   详情页仅展示元数据（用户决策，不读 SKILL.md 正文）。
 * - 「从文件夹安装」按钮在顶部 header 行，两个视图均可见。
 * - 不再区分内置/自定义，不存在预置与自动发现。
 */
export function SettingsSkills({
  isActive,
  initialView = 'market',
}: {
  isActive: boolean;
  initialView?: SkillsView;
}) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const skillsStorageChangedAt = useAppStore((state) => state.skillsStorageChangedAt);
  const skillsStorageChangeEvent = useAppStore((state) => state.skillsStorageChangeEvent);
  const [view, setView] = useState<SkillsView>(initialView);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [storagePath, setStoragePath] = useState('');
  const [diagnostics, setDiagnostics] = useState<SkillLoadDiagnostic[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<LocalizedBanner | null>(null);
  const [success, setSuccess] = useState<LocalizedBanner | null>(null);
  // 已安装技能详情页（组件内 state；null = 列表视图）。
  // 技能被卸载/外部删除后 find 落空 → 自动回列表。
  const [detailSkillId, setDetailSkillId] = useState<string | null>(null);
  // 市场目录（用于已安装视图按 appId/name join 出 tags，做分类筛选）。
  // 只在首次进入已安装视图时拉一次；失败时退化为仅名称/描述搜索。
  const [marketplaceApps, setMarketplaceApps] = useState<MarketplaceSkillApp[]>([]);
  // 已安装技能图标缓存（appId → dataURL/null），与市场视图同款懒加载策略。
  const [installedIconCache, setInstalledIconCache] = useState<Record<number, string | null>>({});
  // 已安装视图的搜索 / 分类筛选（与市场视图口径一致）
  const [searchKeywordRaw, setSearchKeywordRaw] = useState('');
  const searchKeyword = useDeferredValue(searchKeywordRaw);
  const [activeCategory, setActiveCategory] = useState<string>('');
  // 批量管理：开启后卡片改为多选，工具栏提供批量启停/卸载
  const [batchMode, setBatchMode] = useState(false);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const marketplaceLoadedRef = useRef(false);

  // 外部深链（settingsTab==='marketplace' 别名）进入时切到市场视图
  useEffect(() => {
    setView(initialView);
  }, [initialView]);

  useEffect(() => {
    if (!skillsStorageChangeEvent) {
      return;
    }
    if (skillsStorageChangeEvent.reason === 'fallback') {
      setError({ text: t('skills.storagePathFallback') });
      return;
    }
    if (skillsStorageChangeEvent.reason === 'watcher_error') {
      setError({
        text: t('skills.storageWatcherError', {
          message: skillsStorageChangeEvent.message || '',
        }),
      });
    }
  }, [skillsStorageChangeEvent, t]);

  // 已安装技能图标懒加载：仅对有 appId（来自市场）的技能请求，缺失/失败回落默认 Package 图标
  const loadInstalledIcons = useCallback(async (list: Skill[]) => {
    const marketplaceApi =
      typeof window !== 'undefined' ? window.electronAPI?.marketplace : undefined;
    const appIds = list
      .map((skill) => skill.appId)
      .filter((appId): appId is number => typeof appId === 'number');
    if (!marketplaceApi || appIds.length === 0) {
      return;
    }
    const iconResults = await Promise.allSettled(
      appIds.map((appId) => marketplaceApi.getIcon(appId))
    );
    const iconMap: Record<number, string | null> = {};
    appIds.forEach((appId, index) => {
      const result = iconResults[index];
      iconMap[appId] = result.status === 'fulfilled' ? result.value : null;
    });
    setInstalledIconCache((prev) => ({ ...prev, ...iconMap }));
  }, []);

  const loadSkills = useCallback(
    async (silent = false) => {
      try {
        const [skillsResult, storagePathResult, diagnosticsResult] = await Promise.allSettled([
          window.electronAPI.skills.getAll(),
          window.electronAPI.skills.getStoragePath(),
          window.electronAPI.skills.getDiagnostics(),
        ]);
        const errors: string[] = [];

        if (skillsResult.status === 'fulfilled') {
          const list = skillsResult.value || [];
          setSkills(list);
          void loadInstalledIcons(list);
        } else {
          errors.push(
            skillsResult.reason instanceof Error
              ? skillsResult.reason.message
              : tRef.current('skills.failedToLoad')
          );
        }
        if (storagePathResult.status === 'fulfilled') {
          setStoragePath(storagePathResult.value || '');
        } else {
          errors.push(
            storagePathResult.reason instanceof Error
              ? storagePathResult.reason.message
              : tRef.current('skills.storagePathUnavailable')
          );
        }
        // 诊断获取失败不算错误（旧主进程无此 handler 时静默降级）
        if (diagnosticsResult.status === 'fulfilled') {
          setDiagnostics(diagnosticsResult.value || []);
        } else {
          setDiagnostics([]);
        }

        if (errors.length > 0) {
          throw new Error(errors.join(' | '));
        }

        if (!silent) {
          setError(null);
        }
      } catch (err) {
        console.error('Failed to load skills:', err);
        if (!silent) {
          setError({
            text:
              err instanceof Error && err.message
                ? `${tRef.current('skills.failedToLoad')}: ${err.message}`
                : tRef.current('skills.failedToLoad'),
          });
        }
      }
    },
    [loadInstalledIcons]
  );

  useEffect(() => {
    if (!isElectron || !isActive) {
      return;
    }

    void loadSkills();
  }, [isActive, loadSkills]);

  // 存储目录被外部修改（watcher/轮询广播）→ 静默刷新已安装列表
  useEffect(() => {
    if (isElectron && isActive && skillsStorageChangedAt > 0) {
      void loadSkills(true);
    }
  }, [isActive, loadSkills, skillsStorageChangedAt]);

  const handleInstalledFromMarket = useCallback(() => {
    void loadSkills(true);
  }, [loadSkills]);

  // 已安装视图首次进入时懒加载市场目录：仅为拿 tags 做分类 join，
  // 主进程缺 handler / 网络失败都静默降级（不影响已安装列表展示）。
  useEffect(() => {
    if (!isElectron || !isActive || view !== 'installed' || marketplaceLoadedRef.current) {
      return;
    }
    if (!window.electronAPI?.marketplace) {
      return;
    }
    marketplaceLoadedRef.current = true;
    void (async () => {
      try {
        const apps = await window.electronAPI.marketplace.listSkillApps();
        setMarketplaceApps(apps || []);
      } catch {
        setMarketplaceApps([]);
      }
    })();
  }, [isActive, view]);

  // 技能列表变化后清理已失效的多选（外部删除 / 卸载后不再残留选中项）
  useEffect(() => {
    setSelectedSkillIds((prev) => prev.filter((id) => skills.some((skill) => skill.id === id)));
  }, [skills]);

  async function handleInstall() {
    try {
      const folderPath = await window.electronAPI.invoke<string | null>({
        type: 'folder.select',
        payload: {},
      });
      if (!folderPath) return;

      setIsLoading(true);
      const validation = await window.electronAPI.skills.validate(folderPath);

      if (!validation.valid) {
        setError({
          text: t('skills.invalidSkillFolder', { errors: validation.errors.join(', ') }),
        });
        return;
      }

      const result = await window.electronAPI.skills.install(folderPath);
      if (result.success) {
        await loadSkills();
        setError(null);
        // 安装即启用（用户决策）：成功提示明确说明默认启用
        setSuccess({ text: tRef.current('skills.installSuccessToast') });
        setTimeout(() => setSuccess(null), 4000);
      }
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : t('skills.failedToInstall') });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleOpenStoragePath() {
    setIsLoading(true);
    try {
      const result = await window.electronAPI.skills.openStoragePath();
      if (!result.success) {
        setError({ text: result.error || t('skills.storagePathOpenFailed') });
        return;
      }
      setStoragePath(result.path);
      setError(null);
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : t('skills.storagePathOpenFailed') });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRefreshSkills() {
    setIsLoading(true);
    try {
      await loadSkills();
    } finally {
      setIsLoading(false);
    }
  }

  async function handleUninstall(skillId: string, skillName: string) {
    if (!confirm(t('skills.uninstallConfirm', { name: skillName }))) return;

    setIsLoading(true);
    try {
      await window.electronAPI.skills.delete(skillId);
      await loadSkills();
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : t('skills.failedToDelete') });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleToggleEnabled(skill: Skill) {
    setIsLoading(true);
    try {
      await window.electronAPI.skills.setEnabled(skill.id, !skill.enabled);
      await loadSkills();
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : t('skills.failedToToggle') });
    } finally {
      setIsLoading(false);
    }
  }

  // 批量管理：串行复用现有单条 IPC，保证与单条操作完全一致的副作用（含 watcher 广播）
  async function handleBatchToggleEnabled(enable: boolean) {
    const targets = skills.filter(
      (skill) => selectedSkillIds.includes(skill.id) && skill.enabled !== enable
    );
    if (targets.length === 0) return;

    setIsLoading(true);
    try {
      for (const skill of targets) {
        await window.electronAPI.skills.setEnabled(skill.id, enable);
      }
      await loadSkills();
      setSelectedSkillIds([]);
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : t('skills.batchActionFailed') });
    } finally {
      setIsLoading(false);
    }
  }

  async function handleBatchUninstall() {
    const targets = skills.filter((skill) => selectedSkillIds.includes(skill.id));
    if (targets.length === 0) return;
    if (!confirm(t('skills.batchUninstallConfirm', { count: targets.length }))) return;

    setIsLoading(true);
    try {
      for (const skill of targets) {
        await window.electronAPI.skills.delete(skill.id);
      }
      await loadSkills();
      setSelectedSkillIds([]);
    } catch (err) {
      setError({ text: err instanceof Error ? err.message : t('skills.batchActionFailed') });
    } finally {
      setIsLoading(false);
    }
  }

  function exitBatchMode() {
    setBatchMode(false);
    setSelectedSkillIds([]);
  }

  function toggleSelectSkill(skillId: string) {
    setSelectedSkillIds((prev) =>
      prev.includes(skillId) ? prev.filter((id) => id !== skillId) : [...prev, skillId]
    );
  }

  // 默认排序：displayName/name 字母序（§2.4，第一版不做排序控件）
  const installedSkills = [...skills].sort((a, b) =>
    (a.displayName || a.name).localeCompare(b.displayName || b.name)
  );

  // 已安装技能 market 元数据 join：优先 appId，其次 name（小写），与市场视图判定一致
  const installedSkillMeta = useMemo(
    () =>
      installedSkills.map((skill) => {
        const catalogApp = marketplaceApps.find(
          (app) =>
            (typeof skill.appId === 'number' && app.appId === skill.appId) ||
            app.name.trim().toLowerCase() === skill.name.trim().toLowerCase()
        );
        return { skill, tags: catalogApp?.tags ?? [] };
      }),
    [installedSkills, marketplaceApps]
  );

  // 已安装视图筛选：分类（精确 tags 命中）+ 关键词（名称/描述/标签子串，不区分大小写）
  const filteredInstalledSkills = useMemo(() => {
    const kw = searchKeyword.trim().toLowerCase();
    return installedSkillMeta.filter(({ skill, tags }) => {
      if (activeCategory && !tags.includes(activeCategory)) {
        return false;
      }
      if (!kw) {
        return true;
      }
      const haystack = [skill.displayName || '', skill.name, skill.description || '']
        .join('\n')
        .toLowerCase();
      return haystack.includes(kw) || tags.some((tag) => tag.toLowerCase().includes(kw));
    });
  }, [installedSkillMeta, searchKeyword, activeCategory]);

  const allVisibleSelected =
    filteredInstalledSkills.length > 0 &&
    filteredInstalledSkills.every(({ skill }) => selectedSkillIds.includes(skill.id));

  function toggleSelectAllVisible() {
    if (allVisibleSelected) {
      setSelectedSkillIds([]);
      return;
    }
    setSelectedSkillIds(filteredInstalledSkills.map(({ skill }) => skill.id));
  }

  // 详情页数据：列表刷新/卸载后 id 不存在 → detailSkill 落空自动回列表
  const detailSkill = detailSkillId
    ? (installedSkills.find((skill) => skill.id === detailSkillId) ?? null)
    : null;

  const detailIconSrc =
    detailSkill && typeof detailSkill.appId === 'number'
      ? (installedIconCache[detailSkill.appId] ?? null)
      : null;

  return (
    <div className="space-y-4">
      {/* 顶部 header 行：视图切换（市场在前 = 首页）+ 从文件夹安装（两视图均可见） */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="inline-flex rounded-lg border border-border bg-surface-hover p-0.5">
          <button
            type="button"
            onClick={() => setView('market')}
            className={`px-4 py-1.5 text-sm rounded-md transition-colors inline-flex items-center gap-1.5 ${
              view === 'market'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <Store className="w-3.5 h-3.5" />
            {t('skills.viewMarket')}
          </button>
          <button
            type="button"
            onClick={() => setView('installed')}
            className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
              view === 'installed'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t('skills.viewInstalled')}
            {skills.length > 0 ? ` (${skills.length})` : ''}
          </button>
        </div>
        <button
          type="button"
          onClick={handleInstall}
          disabled={isLoading}
          className="px-3 py-1.5 rounded-lg border border-dashed border-border hover:border-accent hover:bg-accent/5 hover:text-accent transition-all inline-flex items-center gap-1.5 text-sm text-text-secondary disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {t('skills.installSkillFromFolder')}
        </button>
      </div>

      {view === 'market' ? (
        <MarketplaceBrowser
          isActive={isActive && view === 'market'}
          onInstalled={handleInstalledFromMarket}
        />
      ) : detailSkill ? (
        <InstalledSkillDetail
          skill={detailSkill}
          iconSrc={detailIconSrc}
          onBack={() => setDetailSkillId(null)}
          onToggleEnabled={() => handleToggleEnabled(detailSkill)}
          onUninstall={() =>
            handleUninstall(detailSkill.id, detailSkill.displayName || detailSkill.name)
          }
          isLoading={isLoading}
        />
      ) : (
        <div className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-error/10 text-error text-sm">
              <AlertCircle className="w-4 h-4" />
              {error.key ? t(error.key) : error.text}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-success/10 text-success text-sm">
              <CheckCircle className="w-4 h-4" />
              {success.key ? t(success.key) : success.text}
            </div>
          )}

          <SettingsContentSection
            title={t('skills.storagePathTitle')}
            description={t('skills.storagePathHint')}
          >
            <div className="text-xs text-text-muted break-all">
              {storagePath || t('skills.storagePathUnavailable')}
            </div>
            <div className="flex flex-wrap gap-2 justify-start">
              <button
                onClick={handleOpenStoragePath}
                disabled={isLoading}
                className="py-2.5 px-4 rounded-lg border border-border hover:border-accent hover:bg-accent/5 transition-all flex items-center justify-center gap-2 text-text-secondary hover:text-accent disabled:opacity-50"
              >
                <Globe className="w-4 h-4" />
                {t('skills.openStoragePath')}
              </button>
              <button
                onClick={handleRefreshSkills}
                disabled={isLoading}
                className="py-2.5 px-4 rounded-lg border border-border hover:border-accent hover:bg-accent/5 transition-all flex items-center justify-center gap-2 text-text-secondary hover:text-accent disabled:opacity-50"
              >
                <RefreshCw className="w-4 h-4" />
                {t('skills.refreshSkills')}
              </button>
            </div>
          </SettingsContentSection>

          {/* 已安装技能：与市场视图同款响应式卡片网格，点击卡片进详情 */}
          <SettingsContentSection title={t('skills.installedSkills')}>
            {/* 工具栏：搜索 + 批量管理开关（仅有已安装技能时展示） */}
            {installedSkills.length > 0 && (
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted pointer-events-none" />
                  <input
                    value={searchKeywordRaw}
                    onChange={(e) => setSearchKeywordRaw(e.target.value)}
                    spellCheck={false}
                    placeholder={t('skills.marketplaceSearchPlaceholder')}
                    className="w-full pl-8 pr-8 py-1.5 text-xs rounded border border-border bg-surface-hover text-text-secondary focus:text-text-primary focus:border-accent focus:outline-none"
                  />
{searchKeywordRaw && (
                    <button
                      type="button"
                      onClick={() => setSearchKeywordRaw('')}
                                title={t('skills.marketplaceClearSearch')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-surface text-text-muted hover:text-text-primary"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => (batchMode ? exitBatchMode() : setBatchMode(true))}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors inline-flex items-center gap-1.5 shrink-0 ${
                    batchMode
                      ? 'bg-accent text-white border-accent'
                      : 'border-border text-text-secondary hover:border-accent hover:text-accent'
                  }`}
                >
                  <CheckSquare className="w-3.5 h-3.5" />
                  {batchMode ? t('skills.batchDone') : t('skills.batchManage')}
                </button>
              </div>
            )}

            {/* 分类筛选 chip 行：与市场视图同款，口径一致（tags 精确命中） */}
            {installedSkills.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => setActiveCategory('')}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    activeCategory === ''
                      ? 'bg-accent text-white border-accent'
                      : 'border-border text-text-secondary hover:border-accent hover:text-accent'
                  }`}
                >
                  {t('skills.marketplaceAllCategory')}
                </button>
                {MARKETPLACE_CATEGORIES.map((category) => {
                  const isActiveCategory = activeCategory === category;
                  return (
                    <button
                      key={category}
                      type="button"
                      onClick={() => setActiveCategory(isActiveCategory ? '' : category)}
                      className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                        isActiveCategory
                          ? 'bg-accent text-white border-accent'
                          : 'border-border text-text-secondary hover:border-accent hover:text-accent'
                      }`}
                    >
                      {category}
                    </button>
                  );
                })}
              </div>
            )}

            {/* 批量操作栏：多选计数 + 全选 + 批量启停/卸载 */}
            {batchMode && (
              <div className="flex flex-wrap items-center gap-2 px-3 py-2 rounded-lg border border-accent/30 bg-accent/5 text-xs">
                <span className="text-text-secondary">
                  {t('skills.batchSelected', { count: selectedSkillIds.length })}
                </span>
                <button
                  type="button"
                  onClick={toggleSelectAllVisible}
                  className="px-2.5 py-1 rounded border border-border text-text-secondary hover:border-accent hover:text-accent transition-colors"
                >
                  {allVisibleSelected
                    ? t('skills.batchClearSelection')
                    : t('skills.batchSelectAll')}
                </button>
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => handleBatchToggleEnabled(true)}
                  disabled={isLoading || selectedSkillIds.length === 0}
                  className="px-2.5 py-1 rounded bg-success/10 text-success hover:bg-success/20 transition-colors disabled:opacity-50"
                >
                  {t('skills.batchEnable')}
                </button>
                <button
                  type="button"
                  onClick={() => handleBatchToggleEnabled(false)}
                  disabled={isLoading || selectedSkillIds.length === 0}
                  className="px-2.5 py-1 rounded bg-surface text-text-secondary hover:bg-surface-active transition-colors disabled:opacity-50"
                >
                  {t('skills.batchDisable')}
                </button>
                <button
                  type="button"
                  onClick={handleBatchUninstall}
                  disabled={isLoading || selectedSkillIds.length === 0}
                  className="px-2.5 py-1 rounded bg-error/10 text-error hover:bg-error/20 transition-colors disabled:opacity-50"
                >
                  {t('skills.batchUninstall')}
                </button>
              </div>
            )}

            {installedSkills.length === 0 ? (
              <div className="text-center py-8 text-text-muted">
                <Package className="w-10 h-10 mx-auto mb-3 opacity-50" />
                <p>{t('skills.noInstalledSkills')}</p>
                <button
                  type="button"
                  onClick={() => setView('market')}
                  className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover transition-all text-sm"
                >
                  <Store className="w-4 h-4" />
                  {t('skills.goToMarket')}
                </button>
              </div>
            ) : filteredInstalledSkills.length === 0 ? (
              <div className="py-8 text-center text-text-muted space-y-2">
                <div>{t('skills.marketplaceNoMatch')}</div>
                <button
                  type="button"
                  onClick={() => {
                    setSearchKeywordRaw('');
                    setActiveCategory('');
                  }}
                  className="text-xs text-accent hover:text-accent-hover hover:underline"
                >
                  {t('skills.marketplaceClearSearch')}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {filteredInstalledSkills.map(({ skill }) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    iconSrc={
                      typeof skill.appId === 'number'
                        ? (installedIconCache[skill.appId] ?? null)
                        : null
                    }
                    selectable={batchMode}
                    selected={selectedSkillIds.includes(skill.id)}
                    onToggleSelect={() => toggleSelectSkill(skill.id)}
                    onOpenDetail={() => setDetailSkillId(skill.id)}
                    onToggleEnabled={() => handleToggleEnabled(skill)}
                    onUninstall={() => handleUninstall(skill.id, skill.displayName || skill.name)}
                    isLoading={isLoading}
                  />
                ))}
              </div>
            )}
          </SettingsContentSection>

          {/* 技能加载诊断：解析失败/缺 frontmatter 的技能目录不再静默跳过 */}
          {diagnostics.length > 0 && (
            <SettingsContentSection
              title={t('skills.diagnosticsTitle')}
              description={t('skills.diagnosticsDesc')}
            >
              <div className="space-y-2">
                {diagnostics.map((diag, index) => (
                  <div
                    key={`${diag.path}-${index}`}
                    className="flex items-start gap-2 px-3 py-2 rounded-lg bg-error/5 border border-error/20 text-sm"
                  >
                    <AlertCircle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-text-primary break-all font-mono text-xs">
                        {diag.path}
                      </div>
                      <div className="text-text-muted text-xs mt-0.5">{diag.reason}</div>
                    </div>
                  </div>
                ))}
              </div>
            </SettingsContentSection>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 已安装技能卡片：结构与市场卡片（MarketplaceBrowser）一致——
 * 图标块 + 名称 + 版本/来源徽标 + 描述 line-clamp-2 + 底部操作行。
 * 整卡可点击进入详情页；启停/卸载按钮 stopPropagation。
 */
function SkillCard({
  skill,
  iconSrc,
  selectable = false,
  selected = false,
  onToggleSelect,
  onOpenDetail,
  onToggleEnabled,
  onUninstall,
  isLoading,
}: {
  skill: Skill;
  /** 市场图标 dataURL；null/undefined 时回落 Package 图标 */
  iconSrc?: string | null;
  /** 批量管理模式：整卡点击 = 切换选中，隐藏单卡操作行 */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  onOpenDetail: () => void;
  onToggleEnabled: () => void;
  onUninstall: () => void;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  // 无 sidecar 的存量目录按「本地」展示
  const isMarketplace = skill.source === 'marketplace';

  const handleCardClick = () => {
    if (selectable) {
      onToggleSelect?.();
      return;
    }
    onOpenDetail();
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selectable ? selected : undefined}
      onClick={handleCardClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleCardClick();
        }
      }}
      className={`rounded-lg border bg-surface-hover p-4 flex flex-col cursor-pointer hover:border-accent/40 transition-colors text-left ${
        selected ? 'border-accent ring-1 ring-accent/40' : 'border-border'
      }`}
    >
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className="relative flex-shrink-0">
          <div className="w-11 h-11 rounded-lg bg-surface flex items-center justify-center overflow-hidden">
            {iconSrc ? (
              <img src={iconSrc} alt="" className="w-11 h-11 rounded-lg object-cover" />
            ) : (
              <Package className="w-5 h-5 text-text-muted" />
            )}
          </div>
          {/* 状态点角标：绿=启用，灰=停用 */}
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-surface-hover ${
              skill.enabled ? 'bg-success' : 'bg-text-muted'
            }`}
          />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <h4 className="font-medium text-text-primary truncate">
              {skill.displayName || skill.name}
            </h4>
            {skill.version && (
              <span className="text-xs px-2 py-0.5 rounded bg-surface text-text-muted">
                v{skill.version}
              </span>
            )}
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                isMarketplace ? 'bg-accent/10 text-accent' : 'bg-success/10 text-success'
              }`}
            >
              {isMarketplace ? t('skills.sourceMarketplace') : t('skills.sourceLocal')}
            </span>
            {skill.type === 'mcp' && (
              <span className="text-xs px-2 py-0.5 rounded bg-mcp/10 text-mcp">MCP</span>
            )}
          </div>
          {skill.displayName && skill.displayName !== skill.name && (
            <div className="text-xs text-text-muted font-mono truncate">{skill.name}</div>
          )}
          {skill.description && (
            <p className="text-sm text-text-muted line-clamp-2 mt-1">{skill.description}</p>
          )}
        </div>
      </div>
      {/* 底部：批量模式显示勾选态；普通模式显示启停 + 卸载（点击不冒泡到卡片详情） */}
      {selectable ? (
        <div className="mt-3 flex items-center justify-center py-2 rounded-lg border border-dashed border-border text-text-muted">
          {selected ? (
            <CheckSquare className="w-4 h-4 text-accent" />
          ) : (
            <Square className="w-4 h-4" />
          )}
        </div>
      ) : (
        <div className="mt-3 flex gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleEnabled();
            }}
            disabled={isLoading}
            className={`flex-1 px-3 py-2 rounded-lg text-sm inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 ${
              skill.enabled
                ? 'bg-success/10 text-success hover:bg-success/20'
                : 'bg-surface text-text-muted hover:bg-surface-active'
            }`}
            title={skill.enabled ? t('common.disable') : t('common.enable')}
          >
            {skill.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
            {skill.enabled ? t('skills.statusEnabled') : t('skills.statusDisabled')}
          </button>
          {/* 全面安装制：所有技能均可卸载（管理列表只有全局目录技能） */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onUninstall();
            }}
            disabled={isLoading}
            className="px-3 py-2 rounded-lg bg-error/10 text-error hover:bg-error/20 transition-colors disabled:opacity-50"
            title={t('skills.uninstall')}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 已安装技能详情页（仅元数据，用户决策：不读 SKILL.md 正文、无新 IPC）。
 * 数据全部来自现有 Skill 字段：来源/版本/安装时间/启停状态/描述。
 */
function InstalledSkillDetail({
  skill,
  iconSrc,
  onBack,
  onToggleEnabled,
  onUninstall,
  isLoading,
}: {
  skill: Skill;
  /** 市场图标 dataURL；null/undefined 时回落 Package 图标 */
  iconSrc?: string | null;
  onBack: () => void;
  onToggleEnabled: () => void;
  onUninstall: () => void;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const isMarketplace = skill.source === 'marketplace';

  return (
    <div className="space-y-4">
      {/* 返回行 */}
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-accent transition-colors"
      >
        <ChevronLeft className="w-4 h-4" />
        {t('skills.backToList')}
      </button>

      {/* 头部卡 */}
      <div className="rounded-lg border border-border bg-surface-hover p-5">
        <div className="flex items-start gap-4">
          <div className="relative flex-shrink-0">
            <div className="w-14 h-14 rounded-lg bg-surface flex items-center justify-center overflow-hidden">
              {iconSrc ? (
                <img src={iconSrc} alt="" className="w-14 h-14 rounded-lg object-cover" />
              ) : (
                <Package className="w-7 h-7 text-text-muted" />
              )}
            </div>
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-surface-hover ${
                skill.enabled ? 'bg-success' : 'bg-text-muted'
              }`}
            />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <h3 className="text-lg font-semibold text-text-primary">
                {skill.displayName || skill.name}
              </h3>
              {skill.version && (
                <span className="text-xs px-2 py-0.5 rounded bg-surface text-text-muted">
                  v{skill.version}
                </span>
              )}
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  isMarketplace ? 'bg-accent/10 text-accent' : 'bg-success/10 text-success'
                }`}
              >
                {isMarketplace ? t('skills.sourceMarketplace') : t('skills.sourceLocal')}
              </span>
              {skill.type === 'mcp' && (
                <span className="text-xs px-2 py-0.5 rounded bg-mcp/10 text-mcp">MCP</span>
              )}
              <span
                className={`text-xs px-2 py-0.5 rounded ${
                  skill.enabled ? 'bg-success/10 text-success' : 'bg-surface text-text-muted'
                }`}
              >
                {skill.enabled ? t('skills.statusEnabled') : t('skills.statusDisabled')}
              </span>
            </div>
            {skill.displayName && skill.displayName !== skill.name && (
              <div className="text-xs text-text-muted font-mono">{skill.name}</div>
            )}
          </div>
        </div>

        {/* 元信息表 */}
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 mt-5 text-sm">
          <div>
            <dt className="text-xs text-text-muted mb-0.5">{t('skills.detailSource')}</dt>
            <dd className="text-text-primary">
              {isMarketplace ? t('skills.sourceMarketplace') : t('skills.sourceLocal')}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted mb-0.5">{t('skills.detailVersion')}</dt>
            <dd className="text-text-primary">
              {skill.version ? t('skills.versionLabel', { version: skill.version }) : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted mb-0.5">{t('skills.detailInstalledAt')}</dt>
            <dd className="text-text-primary">
              {skill.installedAt
                ? t('skills.detailInstalledAtValue', {
                    date: new Date(skill.installedAt).toLocaleDateString(),
                  })
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-text-muted mb-0.5">{t('skills.detailStatus')}</dt>
            <dd className="text-text-primary">
              {skill.enabled ? t('skills.statusEnabled') : t('skills.statusDisabled')}
            </dd>
          </div>
        </dl>
      </div>

      {/* 描述全文 */}
      <SettingsContentSection title={t('skills.detailDescription')}>
        <p className="text-sm text-text-secondary whitespace-pre-wrap break-words">
          {skill.description || '—'}
        </p>
      </SettingsContentSection>

      {/* 操作区：启停 + 卸载 */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onToggleEnabled}
          disabled={isLoading}
          className={`px-4 py-2 rounded-lg text-sm inline-flex items-center gap-2 transition-colors disabled:opacity-50 ${
            skill.enabled
              ? 'bg-surface text-text-secondary hover:bg-surface-active border border-border'
              : 'bg-accent text-white hover:bg-accent-hover'
          }`}
        >
          {skill.enabled ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
          {skill.enabled ? t('common.disable') : t('common.enable')}
        </button>
        <button
          type="button"
          onClick={onUninstall}
          disabled={isLoading}
          className="px-4 py-2 rounded-lg text-sm inline-flex items-center gap-2 bg-error/10 text-error hover:bg-error/20 transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-4 h-4" />
          {t('skills.uninstall')}
        </button>
      </div>
    </div>
  );
}
