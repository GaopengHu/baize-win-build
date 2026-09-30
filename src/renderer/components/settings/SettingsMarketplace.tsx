import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle, Loader2, Package, RefreshCw, X } from 'lucide-react';
import type { MarketplaceSkillApp } from '../../types';
import { useAppStore } from '../../store';
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

// 列表渐进渲染步长（见 visibleCount 注释）
const MARKETPLACE_PAGE_SIZE = 12;

/**
 * 技能市场（与"技能"平级的设置面板 Tab）。
 *
 * 数据流说明：这里安装 skill 后 **不调用** 技能页的 loadSkills ——
 * 主进程 SkillsManager 带 watchStorage watcher，写入技能目录后会广播
 * skills.storageChanged → store.skillsStorageChangedAt 更新，
 * 技能页在 (isActive, skillsStorageChangedAt) 变化时自动刷新。
 */
export function SettingsMarketplace({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation();
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const [marketplaceApps, setMarketplaceApps] = useState<MarketplaceSkillApp[]>([]);
  const [marketplaceIconCache, setMarketplaceIconCache] = useState<Record<number, string | null>>({});
  const [marketplaceBaseUrl, setMarketplaceBaseUrl] = useState('');
  const [marketplaceBaseUrlDraft, setMarketplaceBaseUrlDraft] = useState('');
  const [isMarketplaceSavingUrl, setIsMarketplaceSavingUrl] = useState(false);
  const [isMarketplaceLoading, setIsMarketplaceLoading] = useState(false);
  const [pluginActionKey, setPluginActionKey] = useState<string | null>(null);
  const [pluginToastMessage, setPluginToastMessage] = useState('');
  const [error, setError] = useState<LocalizedBanner | null>(null);
  const [success, setSuccess] = useState<LocalizedBanner | null>(null);
  const pluginToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasLoadedOnceRef = useRef(false);
  // 列表分页展示：服务端目录接口一次性返回全量（无分页参数），
  // 端侧按 PAGE_SIZE 渐进渲染，滚动到底自动追加，视觉上等同无限滚动。
  const [visibleCount, setVisibleCount] = useState(MARKETPLACE_PAGE_SIZE);
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null);

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
      // 新数据到达即重置可见数，避免旧 visibleCount 越界或直接全量
      setVisibleCount(MARKETPLACE_PAGE_SIZE);
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
      hasLoadedOnceRef.current = true;
    }
  }

  // 挂载后首次加载（viewedTabs 懒加载保证只在首次进入该 Tab 时挂载），
  // 之后每次从别的 Tab 切回来也刷新一次列表。
  useEffect(() => {
    if (!isActive) {
      return () => {
        if (pluginToastTimerRef.current) {
          clearTimeout(pluginToastTimerRef.current);
        }
      };
    }
    if (!hasLoadedOnceRef.current) {
      void loadMarketplaceApps();
    }
    return () => {
      if (pluginToastTimerRef.current) {
        clearTimeout(pluginToastTimerRef.current);
      }
    };
  }, [isActive]);

  // 滚动到底自动追加：哨兵 div 进入视口即 +PAGE_SIZE
  useEffect(() => {
    if (isMarketplaceLoading || marketplaceApps.length === 0) {
      return;
    }
    const sentinel = loadMoreSentinelRef.current;
    if (!sentinel) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisibleCount((prev) =>
            Math.min(prev + MARKETPLACE_PAGE_SIZE, marketplaceApps.length)
          );
        }
      },
      // Tab 布局下滚动发生在设置面板容器（页面级），
      // 用视口作为 root 才能正确判定"滚到底"。
      { rootMargin: '200px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [isMarketplaceLoading, marketplaceApps.length, visibleCount]);

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

  function pickPreferredPackage(app: MarketplaceSkillApp) {
    if (app.packages.length === 0) {
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

  return (
    <div className="space-y-4">
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

      {/* 工具栏：标题 + 刷新 + 市场地址输入框 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-base font-semibold text-text-primary whitespace-nowrap">
          {t('skills.marketplaceTitle')}
        </h3>
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
        className="w-full px-2.5 py-1.5 text-xs rounded border border-border bg-surface-hover text-text-secondary focus:text-text-primary focus:border-accent focus:outline-none disabled:opacity-60"
      />

      {/* 技能列表 */}
      {isMarketplaceLoading ? (
        <div className="py-8 flex items-center justify-center gap-2 text-text-secondary">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>{t('common.loading')}</span>
        </div>
      ) : marketplaceApps.length === 0 ? (
        <div className="py-8 text-center text-text-muted">{t('skills.marketplaceEmpty')}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {marketplaceApps.slice(0, visibleCount).map((app) => {
          const iconSrc = marketplaceIconCache[app.appId] || null;
          const pkg = pickPreferredPackage(app);
          const installTarget = `marketplace:${app.appId}`;
          const isInstalling = pluginActionKey === installTarget;
          const sizeLabel = pkg ? formatBytes(pkg.fileSize) : '';
          const noPackage = !pkg;
          return (
            <div
              key={app.appId}
              className="rounded-lg border border-border bg-surface-hover p-4 flex flex-col"
            >
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
                      <h4 className="font-medium text-text-primary truncate">{app.name}</h4>
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
                      <p className="text-sm text-text-muted line-clamp-2">{app.description}</p>
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
                      const avg = override?.avgScore ?? app.avgScore ?? null;
                      const count = override?.ratingCount ?? app.ratingCount ?? 0;
                      const downloaded =
                        downloadedMap[app.appId] !== undefined || isSkillDownloaded(app.appId);
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
                  title={noPackage ? t('skills.marketplaceNoPackage') : undefined}
                  className="mt-3 w-full px-3 py-2 rounded-lg bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-sm flex-shrink-0"
                >
                  {isInstalling ? (
                    <span className="inline-flex items-center justify-center gap-1">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t('skills.marketplaceInstalling')}
                    </span>
                  ) : (
                    t('skills.marketplaceInstall')
                  )}
                </button>
            </div>
          );
        })}
        </div>
      )}

      {/* 无限滚动哨兵：进入视口自动追加下一页；到底时显示收尾行 */}
      {!isMarketplaceLoading && marketplaceApps.length > 0 && (
        <div ref={loadMoreSentinelRef} className="py-3 text-center text-xs text-text-muted">
          {visibleCount < marketplaceApps.length ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              {t('skills.marketplaceLoadingMore', {
                shown: Math.min(visibleCount, marketplaceApps.length),
                total: marketplaceApps.length,
              })}
            </span>
          ) : (
            marketplaceApps.length > MARKETPLACE_PAGE_SIZE &&
            t('skills.marketplaceAllShown', { total: marketplaceApps.length })
          )}
        </div>
      )}

      {ratingModalApp &&
        (() => {
          const eligibility = getRateEligibility(ratingModalApp.appId, ratingKeyFp);
          const override = ratingOverrides[ratingModalApp.appId];
          const avg = override?.avgScore ?? ratingModalApp.avgScore ?? null;
          const count = override?.ratingCount ?? ratingModalApp.ratingCount ?? 0;
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
                          {isSubmittingRating && <Loader2 className="w-4 h-4 animate-spin" />}
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
