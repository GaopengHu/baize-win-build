import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  CheckCircle,
  Package,
  Power,
  PowerOff,
  Trash2,
  Plus,
  Loader2,
  Globe,
  RefreshCw,
  X,
} from 'lucide-react';
import type {
  Skill,
  MarketplaceSkillApp,
} from '../../types';
import { useAppStore } from '../../store';
import { SettingsContentSection } from './shared';
import type { LocalizedBanner } from './shared';
import { StarDisplay, StarRatingInput } from './MarketplaceRating';
import {
  loadDownloadedMap,
  markSkillDownloaded,
  isSkillDownloaded,
  getRateEligibility,
  recordRating,
  getDeviceId,
  isValidRatingStep,
  formatCooldownDays,
  applyPersistedRatingState,
} from '../../utils/marketplace-rating';

const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

export function SettingsSkills({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const skillsStorageChangedAt = useAppStore((state) => state.skillsStorageChangedAt);
  const skillsStorageChangeEvent = useAppStore((state) => state.skillsStorageChangeEvent);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [storagePath, setStoragePath] = useState('');
  const [marketplaceApps, setMarketplaceApps] = useState<MarketplaceSkillApp[]>([]);
  const [marketplaceIconCache, setMarketplaceIconCache] = useState<Record<number, string | null>>({});
  const [marketplaceBaseUrl, setMarketplaceBaseUrl] = useState('');
  const [marketplaceBaseUrlDraft, setMarketplaceBaseUrlDraft] = useState('');
  const [isMarketplaceSavingUrl, setIsMarketplaceSavingUrl] = useState(false);
  const [isMarketplaceLoading, setIsMarketplaceLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isPluginModalOpen, setIsPluginModalOpen] = useState(false);
  const [pluginActionKey, setPluginActionKey] = useState<string | null>(null);
  const [pluginToastMessage, setPluginToastMessage] = useState('');
  const [error, setError] = useState<LocalizedBanner | null>(null);
  const [success, setSuccess] = useState<LocalizedBanner | null>(null);
  const pluginToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 评分相关状态
  const [downloadedMap, setDownloadedMap] = useState<Record<number, number>>(() =>
    loadDownloadedMap()
  );
  // 本机刚评完的本地覆盖：{ appId: { avgScore, ratingCount } }，优先于服务端旧值展示
  const [ratingOverrides, setRatingOverrides] = useState<
    Record<number, { avgScore: number; ratingCount: number }>
  >({});
  const [ratingModalApp, setRatingModalApp] = useState<MarketplaceSkillApp | null>(null);
  const [ratingValue, setRatingValue] = useState(0);
  const [ratingHover, setRatingHover] = useState<number | null>(null);
  const [isSubmittingRating, setIsSubmittingRating] = useState(false);
  const [ratingError, setRatingError] = useState('');
  // 当前模型 API Key 指纹（主进程计算，原文不出配置）：评分冷却按 Key 隔离，
  // 同一机器换 Key = 换用户，各自独立的半年额度。
  const [ratingKeyFp, setRatingKeyFp] = useState('');

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

  function showPluginInstallToast(message: string) {
    setPluginToastMessage(message);
    if (pluginToastTimerRef.current) {
      clearTimeout(pluginToastTimerRef.current);
    }
    pluginToastTimerRef.current = setTimeout(() => {
      setPluginToastMessage('');
      pluginToastTimerRef.current = null;
    }, 5000);
  }

  const loadSkills = useCallback(async (silent = false) => {
    try {
      const [skillsResult, storagePathResult] = await Promise.allSettled([
        window.electronAPI.skills.getAll(),
        window.electronAPI.skills.getStoragePath(),
      ]);
      const errors: string[] = [];

      if (skillsResult.status === 'fulfilled') {
        setSkills(skillsResult.value || []);
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
  }, []);

  useEffect(() => {
    if (!isElectron || !isActive) {
      return () => {
        if (pluginToastTimerRef.current) {
          clearTimeout(pluginToastTimerRef.current);
        }
      };
    }

    void loadSkills();

    return () => {
      if (pluginToastTimerRef.current) {
        clearTimeout(pluginToastTimerRef.current);
      }
    };
  }, [isActive, loadSkills]);

  useEffect(() => {
    if (isElectron && isActive && skillsStorageChangedAt > 0) {
      void loadSkills(true);
    }
  }, [isActive, loadSkills, skillsStorageChangedAt]);

  async function handleBrowsePlugins() {
    setIsPluginModalOpen(true);
    await loadMarketplaceApps();
  }

  async function loadMarketplaceApps() {
    if (!isElectron || !window.electronAPI.marketplace) {
      return;
    }
    setIsMarketplaceLoading(true);
    try {
      const [apps, baseUrl] = await Promise.all([
        window.electronAPI.marketplace.listSkillApps(),
        window.electronAPI.marketplace.getBaseUrl().catch(() => ''),
      ]);
      setMarketplaceApps(apps || []);
      // 用主进程备份校准本地门控：单删 Local Storage 文件夹后，
      // 下载记录与评分冷却从这里恢复，半年限制继续生效。
      try {
        const persisted = await window.electronAPI.marketplace.getRatingState();
        if (persisted) {
          applyPersistedRatingState(persisted);
          setDownloadedMap(loadDownloadedMap());
          setRatingKeyFp(typeof persisted.keyFp === 'string' ? persisted.keyFp : '');
        }
      } catch {
        // 校准失败不阻塞列表展示
      }
      setMarketplaceBaseUrl(baseUrl || '');
      setMarketplaceBaseUrlDraft(baseUrl || '');
      setError(null);
      // Fetch icons lazily; missing icons resolve to null and fall back to the
      // default glyph in the UI.
      const iconResults = await Promise.allSettled(
        (apps || []).map((app) => window.electronAPI.marketplace.getIcon(app.appId))
      );
      const iconMap: Record<number, string | null> = {};
      (apps || []).forEach((app, index) => {
        const result = iconResults[index];
        iconMap[app.appId] = result.status === 'fulfilled' ? result.value : null;
      });
      setMarketplaceIconCache(iconMap);
    } catch (err) {
      setMarketplaceApps([]);
      const rawMessage = err instanceof Error && err.message ? err.message : '';
      // 主进程缺 handler = 客户端版本早于市场 IPC（2026-09-18 落码）：
      // 直说升级，别把 IPC 原文甩给办公用户。
      const outdated =
        rawMessage.includes('No handler registered') &&
        rawMessage.includes('marketplace.');
      setError({
        text: outdated
          ? t('skills.marketplaceClientOutdated')
          : rawMessage
            ? `${t('skills.marketplaceLoadFailed')}: ${rawMessage}`
            : t('skills.marketplaceLoadFailed'),
      });
    } finally {
      setIsMarketplaceLoading(false);
    }
  }

  async function handleMarketplaceBaseUrlBlur() {
    const next = marketplaceBaseUrlDraft.trim().replace(/\/+$/, '');
    // Unchanged or empty: revert the input display without touching config.
    if (!next || next === marketplaceBaseUrl) {
      setMarketplaceBaseUrlDraft(marketplaceBaseUrl);
      return;
    }
    // Basic sanity check before persisting.
    if (!/^https?:\/\/.+/.test(next)) {
      setError({ text: t('skills.marketplaceInvalidUrl') });
      setMarketplaceBaseUrlDraft(marketplaceBaseUrl);
      return;
    }
    setIsMarketplaceSavingUrl(true);
    try {
      const result = await window.electronAPI.config.save({ marketplaceBaseUrl: next });
      if (result?.success) {
        useAppStore.getState().setAppConfig(result.config);
      }
      setMarketplaceBaseUrl(next);
      setMarketplaceBaseUrlDraft(next);
      await loadMarketplaceApps();
    } catch (err) {
      setError({
        text:
          err instanceof Error && err.message
            ? `${t('skills.marketplaceSaveUrlFailed')}: ${err.message}`
            : t('skills.marketplaceSaveUrlFailed'),
      });
      setMarketplaceBaseUrlDraft(marketplaceBaseUrl);
    } finally {
      setIsMarketplaceSavingUrl(false);
    }
  }

  async function handleInstallMarketplaceSkill(app: MarketplaceSkillApp) {
    const pkg = pickPreferredPackage(app);
    if (!pkg) {
      setError({ text: t('skills.marketplaceNoPackage') });
      return;
    }
    setPluginActionKey(`marketplace:${app.appId}`);
    setError(null);
    setSuccess(null);
    try {
      const result = await window.electronAPI.marketplace.installSkill({
        appId: app.appId,
        packageId: pkg.packageId,
        skillName: app.name,
      });
      await loadSkills();
      // 下载成功即登记：本地 + 主进程各记一份，只有下载过的 skill 才允许评分
      setDownloadedMap(markSkillDownloaded(app.appId));
      try {
        await window.electronAPI.marketplace.markDownloaded({ appId: app.appId });
      } catch {
        // 主进程备份失败不影响本次流程，下次打开商店时以本地为准
      }
      const message = t('skills.marketplaceInstallSuccess', {
        name: result.skillName || app.name,
      });
      setSuccess({ text: message });
      showPluginInstallToast(message);
      setTimeout(() => setSuccess(null), 4000);
    } catch (err) {
      setError({
        text:
          err instanceof Error && err.message
            ? `${t('skills.marketplaceInstallFailed')}: ${err.message}`
            : t('skills.marketplaceInstallFailed'),
      });
    } finally {
      setPluginActionKey(null);
    }
  }

  function openRatingModal(app: MarketplaceSkillApp) {
    // 没下载过：只看分，不给评
    if (!isSkillDownloaded(app.appId) && downloadedMap[app.appId] === undefined) {
      return;
    }
    setRatingModalApp(app);
    setRatingValue(0);
    setRatingHover(null);
    setRatingError('');
  }

  async function handleSubmitRating() {
    const app = ratingModalApp;
    if (!app || isSubmittingRating) return;
    if (!isValidRatingStep(ratingValue)) {
      setRatingError(t('skills.marketplaceRatingInvalid'));
      return;
    }
    // 端侧硬门槛：该 Key 半年内评过同一 skill，直接拒绝提交
    const eligibility = getRateEligibility(app.appId, ratingKeyFp);
    if (!eligibility.allowed) {
      setRatingError(
        t('skills.marketplaceRatingCooldown', {
          days: formatCooldownDays(eligibility.remainingMs),
        })
      );
      return;
    }
    setIsSubmittingRating(true);
    setRatingError('');
    try {
      const result = await window.electronAPI.marketplace.submitRating({
        appId: app.appId,
        score: ratingValue,
        deviceId: getDeviceId(),
      });
      // 服务端返回合并后的最新平均分与总次数，直接覆盖展示
      setMarketplaceApps((prev) =>
        prev.map((item) =>
          item.appId === app.appId
            ? { ...item, avgScore: result.avg_score, ratingCount: result.rating_count }
            : item
        )
      );
      setRatingOverrides((prev) => ({
        ...prev,
        [app.appId]: { avgScore: result.avg_score, ratingCount: result.rating_count },
      }));
      recordRating(app.appId, ratingKeyFp);
      try {
        await window.electronAPI.marketplace.recordRating({ appId: app.appId });
      } catch {
        // 主进程备份失败不影响本次评分，本地冷却已生效
      }
      setRatingModalApp(null);
      const message = t('skills.marketplaceRatingSuccess', { name: app.name });
      setSuccess({ text: message });
      showPluginInstallToast(message);
      setTimeout(() => setSuccess(null), 4000);
    } catch (err) {
      setRatingError(
        err instanceof Error && err.message
          ? `${t('skills.marketplaceRatingFailed')}: ${err.message}`
          : t('skills.marketplaceRatingFailed')
      );
    } finally {
      setIsSubmittingRating(false);
    }
  }

  function pickPreferredPackage(app: MarketplaceSkillApp) {    if (app.packages.length === 0) {
      return null;
    }
    // Prefer x64, then the first package by server sort order (already sorted).
    return (
      app.packages.find((pkg) => pkg.arch.toLowerCase() === 'x64') ?? app.packages[0]
    );
  }

  function formatBytes(size: number): string {
    if (!Number.isFinite(size) || size <= 0) {
      return '';
    }
    if (size < 1024) {
      return `${size} B`;
    }
    if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }

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
        setError({ text: `Invalid skill folder: ${validation.errors.join(', ')}` });
        return;
      }

      const result = await window.electronAPI.skills.install(folderPath);
      if (result.success) {
        await loadSkills();
        setError(null);
        setSuccess(null);
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

  async function handleDelete(skillId: string, skillName: string) {
    if (!confirm(t('skills.deleteSkill', { name: skillName }))) return;

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

  const builtinSkills = skills.filter((s) => s.type === 'builtin');
  const customSkills = skills.filter((s) => s.type !== 'builtin');

  return (
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

      {/* Built-in Skills */}
      <SettingsContentSection
        title={t('skills.builtinSkills')}
        description={t('skills.builtinSkillsDesc')}
      >
        {builtinSkills.map((skill) => (
          <SkillCard
            key={skill.id}
            skill={skill}
            onToggleEnabled={() => handleToggleEnabled(skill)}
            onDelete={null}
            isLoading={isLoading}
          />
        ))}
      </SettingsContentSection>

      {/* Custom Skills */}
      <SettingsContentSection
        title={t('skills.customSkills')}
        description={t('skills.installSkillsDesc')}
      >
        {customSkills.length === 0 ? (
          <div className="text-center py-8 text-text-muted">
            <Package className="w-10 h-10 mx-auto mb-3 opacity-50" />
            <p>{t('skills.noCustomSkills')}</p>
            <p className="text-sm mt-1">{t('skills.installSkillsDesc')}</p>
          </div>
        ) : (
          customSkills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onToggleEnabled={() => handleToggleEnabled(skill)}
              onDelete={() => handleDelete(skill.id, skill.name)}
              isLoading={isLoading}
            />
          ))
        )}
      </SettingsContentSection>

      <SettingsContentSection
        title={t('skills.pluginsTitle')}
        description={t('skills.pluginsDesc')}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <button
            onClick={handleBrowsePlugins}
            disabled={isLoading || isMarketplaceLoading}
            className="w-full py-3 px-4 rounded-lg border border-border-subtle hover:border-accent hover:bg-accent/5 transition-all flex items-center justify-center gap-2 text-text-secondary hover:text-accent disabled:opacity-50"
          >
            {isMarketplaceLoading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Package className="w-5 h-5" />
            )}
            {t('skills.browsePlugins')}
          </button>
          <button
            onClick={handleInstall}
            disabled={isLoading}
            className="w-full py-3 px-4 rounded-lg border-2 border-dashed border-border-subtle hover:border-accent hover:bg-accent/5 transition-all flex items-center justify-center gap-2 text-text-secondary hover:text-accent disabled:opacity-50"
          >
            <Plus className="w-5 h-5" />
            {t('skills.installSkillFromFolder')}
          </button>
        </div>
      </SettingsContentSection>

      {isPluginModalOpen && (
        <div className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4">
          <div className="w-full max-w-3xl max-h-[80vh] overflow-hidden rounded-lg border border-border bg-surface shadow-elevated">
            <div className="px-5 py-4 border-b border-border">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-lg font-semibold text-text-primary whitespace-nowrap">
                  {t('skills.marketplaceTitle')}
                </h3>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => loadMarketplaceApps()}
                    disabled={isMarketplaceLoading}
                    className="p-2 rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-50"
                    title={t('skills.refreshSkills')}
                  >
                    <RefreshCw
                      className={`w-4 h-4 text-text-secondary ${isMarketplaceLoading ? 'animate-spin' : ''}`}
                    />
                  </button>
                  <button
                    onClick={() => setIsPluginModalOpen(false)}
                    className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
                  >
                    <X className="w-5 h-5 text-text-secondary" />
                  </button>
                </div>
              </div>
              <input
                value={marketplaceBaseUrlDraft}
                onChange={(e) => setMarketplaceBaseUrlDraft(e.target.value)}
                onBlur={() => void handleMarketplaceBaseUrlBlur()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === 'Escape') {
                    setMarketplaceBaseUrlDraft(marketplaceBaseUrl);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                disabled={isMarketplaceLoading || isMarketplaceSavingUrl}
                spellCheck={false}
                placeholder="http://host:3000"
                title={t('skills.marketplaceUrlHint')}
                className="mt-2 w-full px-2.5 py-1.5 text-xs rounded border border-border bg-surface-hover text-text-secondary focus:text-text-primary focus:border-accent focus:outline-none disabled:opacity-60"
              />
            </div>
            <div className="p-5 space-y-3 overflow-y-auto max-h-[65vh]">
              {error && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-error/10 text-error text-sm">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span className="break-all">{error.key ? t(error.key) : error.text}</span>
                </div>
              )}
              {success && (
                <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-success/10 text-success text-sm">
                  <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span className="break-all">{success.key ? t(success.key) : success.text}</span>
                </div>
              )}
              {isMarketplaceLoading ? (
                <div className="py-8 flex items-center justify-center gap-2 text-text-secondary">
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>{t('common.loading')}</span>
                </div>
              ) : marketplaceApps.length === 0 ? (
                <div className="py-8 text-center text-text-muted">
                  {t('skills.marketplaceEmpty')}
                </div>
              ) : (
                marketplaceApps.map((app) => {
                  const iconSrc = marketplaceIconCache[app.appId] || null;
                  const pkg = pickPreferredPackage(app);
                  const installTarget = `marketplace:${app.appId}`;
                  const isInstalling = pluginActionKey === installTarget;
                  const sizeLabel = pkg ? formatBytes(pkg.fileSize) : '';
                  const noPackage = !pkg;
                  return (
                    <div
                      key={app.appId}
                      className="rounded-lg border border-border bg-surface-hover p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 flex-1 min-w-0">
                          {iconSrc ? (
                            <img
                              src={iconSrc}
                              alt=""
                              className="w-11 h-11 rounded-lg object-cover flex-shrink-0"
                            />
                          ) : (
                            <div className="w-11 h-11 rounded-lg bg-surface flex items-center justify-center flex-shrink-0">
                              <Package className="w-5 h-5 text-text-muted" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <h4 className="font-medium text-text-primary truncate">
                                {app.name}
                              </h4>
                              {app.version && (
                                <span className="text-xs px-2 py-0.5 rounded bg-surface text-text-muted">
                                  v{app.version}
                                </span>
                              )}
                              {app.tags.map((tag) => (
                                <span
                                  key={tag}
                                  className="text-xs px-2 py-0.5 rounded bg-accent/10 text-accent"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                            {app.description && (
                              <p className="text-sm text-text-muted line-clamp-2">
                                {app.description}
                              </p>
                            )}
                            <p className="text-xs text-text-muted mt-2">
                              {t('skills.marketplaceDownloadCount', {
                                count: app.downloadCount,
                              })}
                              {sizeLabel ? ` · ${sizeLabel}` : ''}
                              {pkg && pkg.arch ? ` · ${pkg.arch}` : ''}
                              {noPackage ? (
                                <span className="text-warning">
                                  {' '}
                                  · {t('skills.marketplaceNoPackage')}
                                </span>
                              ) : (
                                ''
                              )}
                            </p>
                            {(() => {
                              const override = ratingOverrides[app.appId];
                              const avg =
                                override?.avgScore ?? app.avgScore ?? null;
                              const count =
                                override?.ratingCount ?? app.ratingCount ?? 0;
                              const downloaded =
                                downloadedMap[app.appId] !== undefined ||
                                isSkillDownloaded(app.appId);
                              return (
                                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                  <StarDisplay score={avg} />
                                  {avg === null ? (
                                    <span className="text-xs text-text-muted">
                                      {t('skills.marketplaceNoRating')}
                                    </span>
                                  ) : (
                                    <span className="text-xs text-text-muted">
                                      {avg.toFixed(1)}
                                      {t('skills.marketplaceRatingUnit', {
                                        count,
                                      })}
                                    </span>
                                  )}
                                  {downloaded && (
                                    <button
                                      type="button"
                                      onClick={() => openRatingModal(app)}
                                      className="text-xs text-accent hover:text-accent-hover hover:underline transition-colors"
                                    >
                                      {t('skills.marketplaceRateAction')}
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                        <button
                          onClick={() => handleInstallMarketplaceSkill(app)}
                          disabled={noPackage || pluginActionKey !== null}
                          title={
                            noPackage ? t('skills.marketplaceNoPackage') : undefined
                          }
                          className="px-3 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-sm flex-shrink-0"
                        >
                          {isInstalling ? (
                            <span className="inline-flex items-center gap-1">
                              <Loader2 className="w-4 h-4 animate-spin" />
                              {t('skills.marketplaceInstalling')}
                            </span>
                          ) : (
                            t('skills.marketplaceInstall')
                          )}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {ratingModalApp &&
        (() => {
          const eligibility = getRateEligibility(ratingModalApp.appId, ratingKeyFp);
          const override = ratingOverrides[ratingModalApp.appId];
          const avg =
            override?.avgScore ?? ratingModalApp.avgScore ?? null;
          const count =
            override?.ratingCount ?? ratingModalApp.ratingCount ?? 0;
          const shown = ratingHover ?? ratingValue;
          return (
            <div className="fixed inset-0 z-[70] bg-black/50 flex items-center justify-center p-4">
              <div className="w-full max-w-md rounded-lg border border-border bg-surface shadow-elevated">
                <div className="px-5 py-4 border-b border-border flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-text-primary truncate">
                    {t('skills.marketplaceRatingTitle', {
                      name: ratingModalApp.name,
                    })}
                  </h3>
                  <button
                    onClick={() => setRatingModalApp(null)}
                    className="p-2 rounded-lg hover:bg-surface-hover transition-colors shrink-0"
                  >
                    <X className="w-5 h-5 text-text-secondary" />
                  </button>
                </div>
                <div className="px-5 py-4 space-y-4">
                  <div className="flex items-center gap-2">
                    <StarDisplay score={avg} />
                    {avg === null ? (
                      <span className="text-sm text-text-muted">
                        {t('skills.marketplaceNoRating')}
                      </span>
                    ) : (
                      <span className="text-sm text-text-muted">
                        {avg.toFixed(1)}
                        {t('skills.marketplaceRatingUnit', { count })}
                      </span>
                    )}
                  </div>
                  {!eligibility.allowed ? (
                    <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-warning/10 text-warning text-sm">
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>
                        {t('skills.marketplaceRatingCooldown', {
                          days: formatCooldownDays(eligibility.remainingMs),
                        })}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-3">
                        <StarRatingInput
                          value={ratingValue}
                          hoverValue={ratingHover}
                          disabled={isSubmittingRating}
                          onChange={setRatingValue}
                          onHover={setRatingHover}
                        />
                        <span className="text-sm text-text-secondary min-w-10">
                          {shown > 0
                            ? t('skills.marketplaceRatingPicked', {
                                score: shown.toFixed(1),
                              })
                            : ''}
                        </span>
                      </div>
                      {ratingError && (
                        <div className="flex items-start gap-2 px-4 py-3 rounded-lg bg-error/10 text-error text-sm">
                          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                          <span className="break-all">{ratingError}</span>
                        </div>
                      )}
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => setRatingModalApp(null)}
                          disabled={isSubmittingRating}
                          className="px-4 py-2 rounded-lg border border-border text-text-secondary hover:border-accent hover:text-accent transition-all text-sm disabled:opacity-50"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          onClick={() => void handleSubmitRating()}
                          disabled={isSubmittingRating || ratingValue <= 0}
                          className="px-4 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover transition-all text-sm disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1"
                        >
                          {isSubmittingRating && (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          )}
                          {t('skills.marketplaceRatingSubmit')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

      {pluginToastMessage && (
        <div className="fixed right-6 bottom-6 z-[80] max-w-md rounded-lg border border-success/30 bg-surface px-4 py-3 shadow-elevated">
          <div className="flex items-start gap-2 text-success text-sm">
            <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{pluginToastMessage}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SkillCard({
  skill,
  onToggleEnabled,
  onDelete,
  isLoading,
}: {
  skill: Skill;
  onToggleEnabled: () => void;
  onDelete: (() => void) | null;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const isBuiltin = skill.type === 'builtin';

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <div
              className={`w-3 h-3 rounded-full ${skill.enabled ? 'bg-success' : 'bg-text-muted'}`}
            />
            <h3 className="font-medium text-text-primary">{skill.name}</h3>
            <span
              className={`px-2 py-0.5 text-xs rounded ${
                isBuiltin
                  ? 'bg-accent/10 text-accent'
                  : skill.type === 'mcp'
                    ? 'bg-mcp/10 text-mcp'
                    : 'bg-success/10 text-success'
              }`}
            >
              {skill.type.toUpperCase()}
            </span>
          </div>
          {skill.description && (
            <p className="text-sm text-text-muted ml-6 line-clamp-2">{skill.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onToggleEnabled}
            disabled={isLoading}
            className={`p-2 rounded-lg transition-colors ${
              skill.enabled
                ? 'bg-success/10 text-success hover:bg-success/20'
                : 'bg-surface-muted text-text-muted hover:bg-surface-active'
            }`}
            title={skill.enabled ? t('common.disable') : t('common.enable')}
          >
            {skill.enabled ? <Power className="w-4 h-4" /> : <PowerOff className="w-4 h-4" />}
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              disabled={isLoading}
              className="p-2 rounded-lg bg-error/10 text-error hover:bg-error/20 transition-colors"
              title={t('common.delete')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
