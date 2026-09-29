import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../store';
import type { SearchEngine, SearchRuntimeConfig } from '../../types';

const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.2;
const FONT_SCALE_STEP = 0.01;
const FONT_SCALE_MARKS = [
  { scale: 0.85, label: '小' },
  { scale: 0.95, label: '默认' },
  { scale: 1.0, label: '标准' },
  { scale: 1.1, label: '大' },
  { scale: 1.2, label: '超大' },
];

function clampFontScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, value));
}

function formatScale(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

const SEARCH_ENGINES: SearchEngine[] = [
  'none',
  'bing-cn',
  'sogou',
  'chrome-mcp',
  'bing-api',
  'serper',
  'duckduckgo',
];

const DEFAULT_SEARCH_RUNTIME: SearchRuntimeConfig = {
  engine: 'none',
  apiKey: '',
  timeoutMs: 10000,
};

function cloneSearchRuntime(runtime?: SearchRuntimeConfig): SearchRuntimeConfig {
  return {
    engine: runtime?.engine ?? DEFAULT_SEARCH_RUNTIME.engine,
    apiKey: runtime?.apiKey ?? '',
    timeoutMs: runtime?.timeoutMs ?? DEFAULT_SEARCH_RUNTIME.timeoutMs,
  };
}

export function SettingsGeneral() {
  const { i18n, t } = useTranslation();
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const currentLang = i18n.language.startsWith('zh') ? 'zh' : 'en';
  const [appVer, setAppVer] = useState('');
  const [draftScale, setDraftScale] = useState(() => clampFontScale(settings.fontScale || 1));
  const [isDraggingScale, setIsDraggingScale] = useState(false);

  useEffect(() => {
    setDraftScale(clampFontScale(settings.fontScale || 1));
  }, [settings.fontScale]);

  useEffect(() => {
    try {
      const v = window.electronAPI?.getVersion?.();
      if (v instanceof Promise) v.then(setAppVer);
      else if (v) setAppVer(v);
    } catch {
      /* ignore */
    }
  }, []);

  const languages = useMemo(
    () => [
      { code: 'en', nativeName: 'English' },
      { code: 'zh', nativeName: '中文' },
    ],
    []
  );

  const themeOptions = useMemo(
    () => [
      { value: 'light' as const, label: t('general.themeLight') },
      { value: 'dark' as const, label: t('general.themeDark') },
      { value: 'system' as const, label: t('general.themeSystem', 'System') },
    ],
    [t]
  );

  const handleScaleCommit = (scale: number) => {
    const next = clampFontScale(scale);
    setDraftScale(next);
    updateSettings({ fontScale: next });
  };

  const sliderProgress = ((draftScale - FONT_SCALE_MIN) / (FONT_SCALE_MAX - FONT_SCALE_MIN)) * 100;

  return (
    <div className="space-y-6">
      {/* Theme */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.appearance')}</h4>
        <div className="flex gap-2">
          {themeOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => updateSettings({ theme: opt.value })}
              className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all ${
                settings.theme === opt.value
                  ? 'border-accent bg-accent/5 text-text-primary'
                  : 'border-border bg-surface hover:border-accent/50 text-text-secondary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Font size */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-sm font-medium text-text-primary">{t('general.fontSize', '字体大小')}</h4>
          <span className="text-xs font-medium text-text-muted">{formatScale(draftScale)}</span>
        </div>

        <div className="rounded-2xl border border-border bg-surface px-4 py-4">
          <div className="flex items-center gap-4">
            <span className="text-sm font-semibold tracking-[0.08em] text-text-secondary w-9 shrink-0 text-left">
              {t('general.fontSmall', '小')}
            </span>
            <div className="relative flex-1 pt-5 pb-4">
              {isDraggingScale && (
                <div
                  className="absolute -top-1 left-0 z-20 -translate-y-full rounded-full bg-black px-2.5 py-1 text-[11px] font-semibold text-white shadow-elevated"
                  style={{ left: `${sliderProgress}%`, transform: 'translateX(-50%) translateY(-6px)' }}
                >
                  {formatScale(draftScale)}
                </div>
              )}

              <input
                type="range"
                min={FONT_SCALE_MIN}
                max={FONT_SCALE_MAX}
                step={FONT_SCALE_STEP}
                value={draftScale}
                onChange={(e) => setDraftScale(Number(e.target.value))}
                onPointerDown={() => setIsDraggingScale(true)}
                onPointerUp={() => {
                  setIsDraggingScale(false);
                  handleScaleCommit(draftScale);
                }}
                onMouseUp={() => {
                  setIsDraggingScale(false);
                  handleScaleCommit(draftScale);
                }}
                onTouchEnd={() => {
                  setIsDraggingScale(false);
                  handleScaleCommit(draftScale);
                }}
                className="font-size-slider w-full"
                style={{ ['--slider-progress' as never]: `${sliderProgress}%` }}
                aria-label={t('general.fontSize', '字体大小')}
              />

              <div className="pointer-events-none absolute inset-x-0 top-1/2 flex -translate-y-1/2 items-center">
                <div className="relative h-1 w-full rounded-full bg-border/70">
                  {FONT_SCALE_MARKS.map((mark) => {
                    const left = ((mark.scale - FONT_SCALE_MIN) / (FONT_SCALE_MAX - FONT_SCALE_MIN)) * 100;
                    return (
                      <span
                        key={mark.scale}
                        className="absolute top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-full bg-border-muted"
                        style={{ left: `${left}%` }}
                      />
                    );
                  })}
                </div>
              </div>
            </div>
            <span className="text-sm font-semibold tracking-[0.08em] text-text-secondary w-9 shrink-0 text-right">
              {t('general.fontLarge', '大')}
            </span>
          </div>

          <div className="mt-3 flex items-center justify-between text-[11px] text-text-muted">
            {FONT_SCALE_MARKS.map((mark) => (
              <span key={mark.scale}>{mark.label}</span>
            ))}
          </div>

          <div className="mt-4 overflow-hidden rounded-xl border border-border bg-surface-muted">
            <div className="flex items-center justify-between px-4 pt-2.5">
              <span className="text-[10px] font-medium uppercase tracking-wide text-text-muted">
                {t('general.fontSizePreview', '预览')}
              </span>
              <span className="text-[11px] font-semibold text-accent">{formatScale(draftScale)}</span>
            </div>
            <div
              className="px-4 pb-3.5"
              style={{ fontSize: `${Math.round(16 * draftScale)}px` }}
            >
              <p className="font-semibold text-text-primary" style={{ fontSize: '1.25em' }}>
                今点通 NowLink
              </p>
              <p className="mt-0.5 leading-relaxed text-text-secondary" style={{ fontSize: '1em' }}>
                拖动滑块，实时预览全局字体大小变化效果。
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Language */}
      <div className="space-y-3">
        <h4 className="text-sm font-medium text-text-primary">{t('general.language')}</h4>
        <div className="flex gap-2">
          {languages.map((lang) => (
            <button
              key={lang.code}
              onClick={() => i18n.changeLanguage(lang.code)}
              className={`flex-1 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-all ${
                currentLang === lang.code
                  ? 'border-accent bg-accent/5 text-text-primary'
                  : 'border-border bg-surface hover:border-accent/50 text-text-secondary'
              }`}
            >
              {lang.nativeName}
            </button>
          ))}
        </div>
      </div>

      <SearchEngineSection />

      {/* About */}
      {appVer && (
        <div className="pt-4 border-t border-border">
          <p className="text-xs text-text-muted">今点通 v{appVer}</p>
        </div>
      )}
    </div>
  );
}
/**
 * Phase 7.1.2：搜索引擎切换（子 agent 联网检索端点）。
 * 默认禁用（fail-closed，涉密优先）；用户显式开启后 research 子任务才可联网。
 * 付费引擎（bing-api/serper）的 key 由企业部署预置，此处仅提供输入口。
 */
function SearchEngineSection() {
  const { t } = useTranslation();
  const appConfig = useAppStore((s) => s.appConfig);
  const [draft, setDraft] = useState<SearchRuntimeConfig>(() =>
    cloneSearchRuntime(appConfig?.searchRuntime)
  );
  const [isBusy, setIsBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setDraft(cloneSearchRuntime(appConfig?.searchRuntime));
  }, [appConfig?.searchRuntime]);

  const needsKey = draft.engine === 'bing-api' || draft.engine === 'serper';
  const dirty =
    draft.engine !== (appConfig?.searchRuntime?.engine ?? DEFAULT_SEARCH_RUNTIME.engine) ||
    (draft.apiKey ?? '') !== (appConfig?.searchRuntime?.apiKey ?? '') ||
    draft.timeoutMs !== (appConfig?.searchRuntime?.timeoutMs ?? DEFAULT_SEARCH_RUNTIME.timeoutMs);

  const handleSave = async () => {
    setIsBusy(true);
    setStatus(null);
    try {
      await window.electronAPI.config.save({ searchRuntime: draft });
      setStatus(t('general.searchSaved', '搜索引擎配置已保存'));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium text-text-primary">
        {t('general.searchEngine', '联网检索')}
      </h4>
      <p className="text-xs leading-5 text-text-muted">
        {t(
          'general.searchEngineDesc',
          '子 agent 联网检索的搜索引擎。默认 Bing 国内版（免费、免配置）；企业部署如需付费端点可在此填入 Key。'
        )}
      </p>
      <select
        value={draft.engine}
        onChange={(e) => setDraft((prev) => ({ ...prev, engine: e.target.value as SearchEngine }))}
        className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
      >
        {SEARCH_ENGINES.map((engine) => (
          <option key={engine} value={engine}>
            {t(`general.searchEngine_${engine.replace(/-/g, '_')}`, engine)}
          </option>
        ))}
      </select>
      {needsKey && (
        <input
          type="password"
          value={draft.apiKey ?? ''}
          onChange={(e) => setDraft((prev) => ({ ...prev, apiKey: e.target.value }))}
          placeholder={t('general.searchApiKeyPlaceholder', 'API Key（企业部署预置）')}
          className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-text-primary outline-none focus:border-accent"
        />
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={handleSave}
          disabled={isBusy || !dirty}
          className="btn btn-secondary text-sm py-2 px-4 disabled:opacity-50"
        >
          {t('general.save', '保存')}
        </button>
        {status && <span className="text-xs text-text-muted">{status}</span>}
      </div>
    </div>
  );
}
