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
  Globe,
  RefreshCw,
} from 'lucide-react';
import type { Skill, SkillLoadDiagnostic } from '../../types';
import { useAppStore } from '../../store';
import { SettingsContentSection } from './shared';
import type { LocalizedBanner } from './shared';

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
  const [diagnostics, setDiagnostics] = useState<SkillLoadDiagnostic[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<LocalizedBanner | null>(null);
  const [success, setSuccess] = useState<LocalizedBanner | null>(null);

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

  const loadSkills = useCallback(async (silent = false) => {
    try {
      const [skillsResult, storagePathResult, diagnosticsResult] = await Promise.allSettled([
        window.electronAPI.skills.getAll(),
        window.electronAPI.skills.getStoragePath(),
        window.electronAPI.skills.getDiagnostics(),
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
  }, []);

  useEffect(() => {
    if (!isElectron || !isActive) {
      return;
    }

    void loadSkills();
  }, [isActive, loadSkills]);

  useEffect(() => {
    if (isElectron && isActive && skillsStorageChangedAt > 0) {
      void loadSkills(true);
    }
  }, [isActive, loadSkills, skillsStorageChangedAt]);

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
              // 插件技能随插件生命周期管理，不支持单独删除
              onDelete={
                skill.id.startsWith('plugin-') ? null : () => handleDelete(skill.id, skill.name)
              }
              isLoading={isLoading}
            />
          ))
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
                  <div className="text-text-primary break-all font-mono text-xs">{diag.path}</div>
                  <div className="text-text-muted text-xs mt-0.5">{diag.reason}</div>
                </div>
              </div>
            ))}
          </div>
        </SettingsContentSection>
      )}

      <SettingsContentSection
        title={t('skills.pluginsTitle')}
        description={t('skills.pluginsDesc')}
      >
        <button
          onClick={handleInstall}
          disabled={isLoading}
          className="w-full py-3 px-4 rounded-lg border-2 border-dashed border-border-subtle hover:border-accent hover:bg-accent/5 transition-all flex items-center justify-center gap-2 text-text-secondary hover:text-accent disabled:opacity-50"
        >
          <Plus className="w-5 h-5" />
          {t('skills.installSkillFromFolder')}
        </button>
      </SettingsContentSection>
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
            <h3 className="font-medium text-text-primary">{skill.displayName || skill.name}</h3>
            {skill.displayName && skill.displayName !== skill.name && (
              <span className="text-xs text-text-muted font-mono">{skill.name}</span>
            )}
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
