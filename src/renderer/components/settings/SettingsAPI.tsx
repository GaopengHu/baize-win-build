import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle,
  Circle,
  Cpu,
  Edit3,
  Key,
  Layers,
  Loader2,
  Plus,
  Plug,
  RefreshCw,
  Server,
  Stethoscope,
  Trash2,
  X,
  XCircle,
  ChevronRight,
  ChevronLeft,
} from 'lucide-react';
import { useApiConfigState } from '../../hooks/useApiConfigState';
import { CommonProviderSetupsCard, GuidanceInlineHint } from '../ProviderGuidance';
import ApiDiagnosticsPanel from '../ApiDiagnosticsPanel';

interface ModelOptionItem {
  id: string;
  name: string;
}

type HealthState = 'idle' | 'success' | 'error';

function HealthIcon({ state }: { state: HealthState }) {
  if (state === 'success') return <CheckCircle className="w-4 h-4 text-success" />;
  if (state === 'error') return <XCircle className="w-4 h-4 text-error" />;
  return <Circle className="w-4 h-4 text-text-muted" />;
}

export function SettingsAPI() {
  const { t } = useTranslation();
  const {
    provider,
    customProtocol,
    apiKey,
    baseUrl,
    model,
    customModel,
    useCustomModel,
    contextWindow,
    maxTokens,
    modelInputPlaceholder,
    modelInputHint,
    presets,
    currentPreset,
    modelOptions,
    isSaving,
    isLoadingConfig,
    error,
    successMessage,
    isRefreshingModels,
    isDiscoveringLocalOllama,
    enableThinking,
    isOllamaMode,
    requiresApiKey,
    protocolGuidanceText,
    protocolGuidanceTone,
    baseUrlGuidanceText,
    commonProviderSetups,
    configSets,
    activeConfigSetId,
    currentConfigSet,
    setApiKey,
    setBaseUrl,
    setModel,
    setCustomModel,
    setContextWindow,
    setMaxTokens,
    toggleCustomModel,
    setEnableThinking,
    applyCommonProviderSetup,
    changeProvider,
    changeProtocol,
    requestConfigSetSwitch,
    requestCreateBlankConfigSet,
    renameConfigSet,
    deleteConfigSet,
    handleSave,
    refreshModelOptions,
    discoverLocalOllama,
    diagnosticResult,
    isDiagnosing,
    handleDiagnose,
    shouldShowOllamaManualModelToggle,
  } = useApiConfigState();

  const [currentNameDraft, setCurrentNameDraft] = useState('');
  const [diagnosticHealthBySet, setDiagnosticHealthBySet] = useState<Record<string, HealthState>>(
    {}
  );
  const [creatingSet, setCreatingSet] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [diagnosingSetId, setDiagnosingSetId] = useState<string | null>(null);
  const [deleteConfirmSetId, setDeleteConfirmSetId] = useState<string | null>(null);

  useEffect(() => {
    setCurrentNameDraft(currentConfigSet?.name || '');
  }, [currentConfigSet?.id, currentConfigSet?.name]);

  useEffect(() => {
    if (!diagnosticResult || isDiagnosing || !diagnosingSetId) return;
    setDiagnosticHealthBySet((prev) => ({
      ...prev,
      [diagnosingSetId]: diagnosticResult.overallOk ? 'success' : 'error',
    }));
    setDiagnosingSetId(null);
  }, [diagnosticResult, isDiagnosing, diagnosingSetId]);

  const activeSetSummary = useMemo(() => {
    if (!currentConfigSet) return '';
    const profile = currentConfigSet.profiles[currentConfigSet.activeProfileKey];
    const modelName = profile?.model || t('api.noModelsAvailable', '无可用模型');
    const providerLabel =
      currentConfigSet.provider === 'custom'
        ? `${t('api.moreModels', '自定义')} · ${currentConfigSet.customProtocol.toUpperCase()}`
        : presets?.[currentConfigSet.provider]?.name || currentConfigSet.provider;
    return `${providerLabel} · ${modelName}`;
  }, [currentConfigSet, presets, t]);

  const handleRenameCurrentSet = async () => {
    if (!currentConfigSet) return;
    const nextName = currentNameDraft.trim();
    if (!nextName || nextName === currentConfigSet.name) {
      setCurrentNameDraft(currentConfigSet.name);
      return;
    }
    const renamed = await renameConfigSet(currentConfigSet.id, nextName);
    if (renamed === false) setCurrentNameDraft(currentConfigSet.name);
  };

  const handleCreateModel = async () => {
    setCreatingSet(true);
    try {
      await requestCreateBlankConfigSet();
      setEditorOpen(true);
    } finally {
      setCreatingSet(false);
    }
  };

  const handleSelectSet = async (setId: string) => {
    await requestConfigSetSwitch(setId);
  };

  const handleDeleteSet = async (setId: string) => {
    const target = configSets.find((s) => s.id === setId);
    if (!target || target.isSystem || configSets.length <= 1) {
      return;
    }
    const deleted = await deleteConfigSet(setId);
    if (deleted && currentConfigSet?.id === setId) {
      setEditorOpen(false);
    }
    setDeleteConfirmSetId(null);
  };

  const handleDiagnoseActive = async () => {
    if (!currentConfigSet) return;
    setDiagnosingSetId(currentConfigSet.id);
    await handleDiagnose();
  };

  if (isLoadingConfig) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-accent" />
        <span className="ml-2 text-text-secondary">{t('common.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div
        className={`grid grid-cols-1 gap-5 ${editorOpen ? 'xl:grid-cols-[320px_minmax(0,1fr)]' : ''}`}
      >
        {/* Left list */}
        <div className="rounded-2xl border border-border-muted bg-background-secondary/60 overflow-hidden">
          <div className="px-4 py-4 border-b border-border-muted">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Layers className="w-4 h-4" />
              {t('api.configSet', '配置方案')}
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {t('api.addCustomModelHint', '将当前配置保存为新方案，可在对话中一键切换')}
            </p>
          </div>

          <div className="p-3 space-y-2 max-h-[calc(100vh-260px)] overflow-y-auto">
            {configSets.map((set) => {
              const profile = set.profiles[set.activeProfileKey];
              const health = diagnosticHealthBySet[set.id] || 'idle';
              const isActive = set.id === activeConfigSetId;
              const modelName = profile?.model || t('api.noModelsAvailable', '未配置');
              return (
                <div
                  key={set.id}
                  className={`rounded-xl border p-3 transition-colors ${
                    isActive
                      ? 'border-accent bg-accent/8'
                      : 'border-border-muted bg-background hover:bg-surface-hover'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        void handleSelectSet(set.id);
                      }}
                      className="w-full text-left min-w-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-text-primary truncate">
                            {set.name}
                          </p>
                          {isActive && <Check className="w-3.5 h-3.5 text-accent shrink-0" />}
                        </div>
                        <p className="text-[11px] text-text-muted truncate mt-0.5">
                          {set.provider === 'custom'
                            ? `${t('api.moreModels', '自定义')} · ${set.customProtocol.toUpperCase()}`
                            : presets?.[set.provider]?.name || set.provider}
                        </p>
                        <p className="text-[11px] text-text-secondary truncate mt-0.5">
                          {modelName}
                        </p>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        if (set.isSystem || configSets.length <= 1) return;
                        setDeleteConfirmSetId(set.id);
                      }}
                      disabled={Boolean(set.isSystem) || configSets.length <= 1}
                      className="flex-shrink-0 rounded-lg p-2 text-text-muted hover:text-error hover:bg-error/10 disabled:opacity-40 disabled:hover:bg-transparent"
                      title={t('api.deleteSet', '删除方案')}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        void handleSelectSet(set.id);
                      }}
                      className="flex-1 inline-flex items-center justify-start gap-2 rounded-lg px-3 py-2 text-xs font-medium border border-border-muted bg-background hover:bg-surface-hover text-text-secondary transition-colors"
                    >
                      <HealthIcon state={health} />
                      <span className="truncate">
                        {health === 'success'
                          ? t('api.diagnostic.connected', '连接成功')
                          : health === 'error'
                            ? t('api.diagnostic.disconnected', '连接失败')
                            : t('api.diagnostic.title', '诊断连接')}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorOpen((open) => !open)}
                      className="w-9 h-9 rounded-lg border border-border-muted bg-background hover:bg-surface-hover text-text-secondary transition-colors flex items-center justify-center"
                      title={editorOpen ? t('common.close') : t('common.edit', '编辑')}
                    >
                      {editorOpen ? (
                        <ChevronLeft className="w-4 h-4" />
                      ) : (
                        <ChevronRight className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}

            <button
              type="button"
              onClick={() => {
                void handleCreateModel();
              }}
              disabled={creatingSet}
              className="w-full rounded-xl border-2 border-dashed border-border-muted bg-transparent px-3 py-4 text-text-secondary hover:border-accent/60 hover:text-accent hover:bg-accent/5 transition-colors disabled:opacity-50"
            >
              <div className="flex items-center justify-center gap-2 text-sm font-medium">
                {creatingSet ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                {t('api.newSet', '新建配置方案')}
              </div>
            </button>
          </div>
        </div>

        {/* Right editor, hidden until expanded */}
        {editorOpen && currentConfigSet && (
          <div className="rounded-2xl border border-border-muted bg-background-secondary/40 overflow-hidden">
            <div className="px-5 py-4 border-b border-border-muted flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                  <Cpu className="w-4 h-4" />
                  {currentConfigSet.name}
                </div>
                <p className="mt-1 text-xs text-text-muted">{activeSetSummary}</p>
              </div>
              <button
                type="button"
                onClick={() => setEditorOpen(false)}
                className="w-8 h-8 rounded-lg border border-border-muted bg-background hover:bg-surface-hover text-text-secondary transition-colors flex items-center justify-center"
                title={t('common.close')}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-5 max-h-[calc(100vh-230px)] overflow-y-auto">
              {/* Name */}
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Layers className="w-4 h-4" />
                  {t('api.currentSetName', '方案名称')}
                </label>
                <input
                  type="text"
                  value={currentNameDraft}
                  onChange={(e) => setCurrentNameDraft(e.target.value)}
                  onBlur={() => {
                    void handleRenameCurrentSet();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleRenameCurrentSet();
                    }
                  }}
                  placeholder={t('api.createSetNamePlaceholder', '输入配置方案名称')}
                  className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                />
              </div>

              {/* Provider Selection */}
              <div className="space-y-3 py-4 border-b border-border-muted">
                <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Server className="w-4 h-4" />
                  {t('api.provider')}
                </label>
                <p className="text-xs leading-5 text-text-muted">{t('api.providerDescription')}</p>
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2">
                  {(['openrouter', 'anthropic', 'openai', 'gemini', 'ollama', 'custom'] as const).map(
                    (p) => (
                      <button
                        key={p}
                        onClick={() => changeProvider(p)}
                        disabled={isLoadingConfig}
                        className={`px-3 py-2 rounded-lg text-sm transition-colors border ${
                          provider === p
                            ? 'border-accent bg-accent/10 text-accent font-medium'
                            : 'border-border-muted text-text-secondary hover:border-border hover:text-text-primary disabled:opacity-50'
                        }`}
                      >
                        {p === 'custom' ? t('api.moreModels') : presets?.[p]?.name || p}
                      </button>
                    )
                  )}
                </div>
              </div>

              {/* API Key */}
              <div className="space-y-3 py-4 border-b border-border-muted">
                <label
                  htmlFor="api-key-input"
                  className="flex items-center gap-2 text-sm font-medium text-text-primary"
                >
                  <Key className="w-4 h-4" />
                  {t('api.apiKey')}
                </label>
                <p className="text-xs leading-5 text-text-muted">{t('api.apiKeyDescription')}</p>
                <input
                  id="api-key-input"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={currentPreset?.keyPlaceholder || t('api.enterApiKey')}
                  className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                />
                {currentPreset?.keyHint && <p className="text-xs text-text-muted">{currentPreset.keyHint}</p>}
              </div>

              {/* Custom Protocol */}
              {provider === 'custom' && (
                <div className="space-y-3 py-4 border-b border-border-muted">
                  <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
                    <Server className="w-4 h-4" />
                    {t('api.protocol')}
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {([
                      { id: 'anthropic', label: 'Anthropic' },
                      { id: 'openai', label: 'OpenAI' },
                      { id: 'gemini', label: 'Gemini' },
                    ] as const).map((mode) => (
                      <button
                        key={mode.id}
                        onClick={() => changeProtocol(mode.id)}
                        className={`px-3 py-2 rounded-lg text-sm transition-colors border ${
                          customProtocol === mode.id
                            ? 'border-accent bg-accent/10 text-accent font-medium'
                            : 'border-border-muted text-text-secondary hover:border-border hover:text-text-primary'
                        }`}
                      >
                        {mode.label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-text-muted">{t('api.selectProtocol')}</p>
                  <GuidanceInlineHint text={protocolGuidanceText} tone={protocolGuidanceTone} />
                </div>
              )}

              {/* Base URL */}
              {(provider === 'custom' || provider === 'ollama') && (
                <div className="space-y-3 py-4 border-b border-border-muted">
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
                      <Server className="w-4 h-4" />
                      {t('api.baseUrl')}
                    </label>
                    {isOllamaMode && (
                      <button
                        type="button"
                        onClick={() => {
                          void discoverLocalOllama();
                        }}
                        disabled={isDiscoveringLocalOllama}
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 bg-accent-muted text-accent hover:bg-accent-muted/80 disabled:opacity-50"
                      >
                        <Plug className="w-3 h-3" />
                        {isDiscoveringLocalOllama ? t('api.discoveringLocalOllama') : t('api.discoverLocalOllama')}
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={
                      provider === 'ollama'
                        ? 'http://localhost:11434/v1'
                        : customProtocol === 'openai'
                          ? 'https://api.openai.com/v1'
                          : customProtocol === 'gemini'
                            ? 'https://generativelanguage.googleapis.com'
                            : currentPreset?.baseUrl || 'https://api.anthropic.com'
                    }
                    className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                  />
                  <p className="text-xs text-text-muted">
                    {provider === 'ollama'
                      ? t('api.enterOllamaUrl')
                      : customProtocol === 'openai'
                        ? t('api.enterOpenAIUrl')
                        : customProtocol === 'gemini'
                          ? t('api.enterGeminiUrl')
                          : t('api.enterAnthropicUrl')}
                  </p>
                  {isOllamaMode && <p className="text-xs text-text-muted">{t('api.discoverLocalOllamaHint')}</p>}
                  {provider === 'custom' && <GuidanceInlineHint text={baseUrlGuidanceText} />}
                </div>
              )}

              {/* Model Selection */}
              <div className="space-y-3 py-4 border-b border-border-muted">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
                    <Cpu className="w-4 h-4" />
                    {t('api.model')}
                  </label>
                  <div className="flex items-center gap-2">
                    {isOllamaMode && (
                      <button
                        type="button"
                        onClick={() => {
                          void refreshModelOptions();
                        }}
                        disabled={isRefreshingModels}
                        className="flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 bg-surface-hover text-text-secondary hover:bg-surface-active disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3 h-3 ${isRefreshingModels ? 'animate-spin' : ''}`} />
                        {isRefreshingModels ? t('api.refreshingModels') : t('api.refreshModels')}
                      </button>
                    )}
                    {shouldShowOllamaManualModelToggle && (
                      <button
                        type="button"
                        onClick={toggleCustomModel}
                        className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors active:scale-95 ${
                          useCustomModel
                            ? 'bg-accent-muted text-accent'
                            : 'border border-border-muted bg-background text-text-secondary hover:bg-surface-hover'
                        }`}
                      >
                        <Edit3 className="w-3 h-3" />
                        {isOllamaMode
                          ? useCustomModel
                            ? t('api.useDetectedModels')
                            : t('api.manualModel')
                          : useCustomModel
                            ? t('api.usePreset')
                            : t('api.custom')}
                      </button>
                    )}
                  </div>
                </div>
                {useCustomModel ? (
                  <input
                    type="text"
                    value={customModel}
                    onChange={(e) => setCustomModel(e.target.value)}
                    placeholder={modelInputPlaceholder}
                    className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                  />
                ) : (
                  <select
                    value={modelOptions.length ? model : ''}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg bg-background border border-border text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all appearance-none cursor-pointer"
                  >
                    {modelOptions.length ? (
                      (modelOptions as ModelOptionItem[]).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))
                    ) : (
                      <option value="" disabled>
                        {t('api.noModelsAvailable')}
                      </option>
                    )}
                  </select>
                )}
                {useCustomModel && <p className="text-xs text-text-muted">{modelInputHint}</p>}

                {(provider === 'ollama' || provider === 'custom') && (
                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">
                        {t('api.contextWindow')}
                      </label>
                      <input
                        type="number"
                        value={contextWindow}
                        onChange={(e) => setContextWindow(e.target.value)}
                        placeholder={t('api.contextWindowPlaceholder')}
                        min={1024}
                        step={1024}
                        className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-text-secondary mb-1">
                        {t('api.maxOutputTokens')}
                      </label>
                      <input
                        type="number"
                        value={maxTokens}
                        onChange={(e) => setMaxTokens(e.target.value)}
                        placeholder={t('api.maxOutputTokensPlaceholder')}
                        min={256}
                        step={256}
                        className="w-full px-3 py-2 rounded-lg bg-background border border-border text-text-primary text-sm placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-all"
                      />
                    </div>
                    <p className="col-span-2 text-xs text-text-muted">{t('api.contextWindowHint')}</p>
                  </div>
                )}
              </div>

              {provider === 'custom' && (
                <CommonProviderSetupsCard setups={commonProviderSetups} onApplySetup={applyCommonProviderSetup} />
              )}

              <div className="space-y-3 py-4 border-b border-border-muted">
                <div className="flex items-start gap-2 text-xs text-text-muted">
                  <input
                    type="checkbox"
                    id="enable-thinking"
                    checked={enableThinking}
                    onChange={(e) => setEnableThinking(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded border-border text-accent focus:ring-accent"
                  />
                  <label htmlFor="enable-thinking" className="space-y-0.5 flex-1">
                    <div className="text-text-primary font-medium">{t('api.enableThinking')}</div>
                    <div>{t('api.enableThinkingHint')}</div>
                    {isOllamaMode && (
                      <div className="text-amber-500 dark:text-amber-400 text-xs mt-1">
                        {t('api.enableThinkingOllamaHint')}
                      </div>
                    )}
                  </label>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-error/10 text-error text-sm">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {error}
                </div>
              )}
              {successMessage && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-success/10 text-success text-sm">
                  <CheckCircle className="w-4 h-4 flex-shrink-0" />
                  {successMessage}
                </div>
              )}

              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <Stethoscope className="w-4 h-4" />
                  {t('api.diagnostic.title', '诊断连接')}
                </div>
                <p className="text-xs text-text-muted">
                  {t('api.diagnostic.hint', '配置完成后先诊断连接，确认 API 配置正确')}
                </p>
                <ApiDiagnosticsPanel
                  result={diagnosticResult}
                  isRunning={isDiagnosing}
                  onRunDiagnostics={handleDiagnoseActive}
                  disabled={requiresApiKey && !apiKey.trim()}
                />
              </div>

              <div className="space-y-3 pt-2">
                <button
                  onClick={() => {
                    void handleSave();
                  }}
                  disabled={isSaving || (requiresApiKey && !apiKey.trim())}
                  className="w-full py-3 px-4 rounded-lg bg-accent text-white font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98] flex items-center justify-center gap-2"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      {t('common.saving')}
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-4 h-4" />
                      {t('api.saveSettings')}
                    </>
                  )}
                </button>
                <p className="text-[11px] text-text-muted text-center">
                  {t('api.currentSetSavingHint', '“保存设置”只会更新当前选中的配置方案。')}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {deleteConfirmSetId && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/35 backdrop-blur-[1px] px-4">
          <div className="w-full max-w-md rounded-2xl border border-border-muted bg-background shadow-elevated overflow-hidden">
            <div className="flex items-start justify-between gap-3 px-5 pt-5">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 items-center justify-center rounded-full bg-error/10 text-error">
                  <AlertTriangle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-text-primary">
                    {t('api.configSetDeleteTitle', '删除配置方案')}
                  </h3>
                  <p className="mt-1 text-sm leading-6 text-text-muted">
                    {t('api.configSetDeleteConfirm', {
                      name: configSets.find((s) => s.id === deleteConfirmSetId)?.name || '',
                    })}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDeleteConfirmSetId(null)}
                className="rounded-lg p-2 text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors"
                title={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-5 py-4 mt-1 border-t border-border-muted/70 bg-background-secondary/40">
              <p className="text-xs leading-5 text-text-muted">
                {t('api.configSetDeleteWarning', '删除后该配置方案将立即从列表和对话切换中移除，且无法恢复。')}
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-border-muted bg-background-secondary/30">
              <button
                type="button"
                onClick={() => setDeleteConfirmSetId(null)}
                className="px-4 py-2 rounded-lg border border-border-muted bg-background text-text-secondary hover:bg-surface-hover transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleDeleteSet(deleteConfirmSetId);
                }}
                className="px-4 py-2 rounded-lg bg-error text-white hover:bg-error/90 transition-colors inline-flex items-center gap-2"
              >
                <Trash2 className="h-4 w-4" />
                {t('api.deleteSet', '删除方案')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
