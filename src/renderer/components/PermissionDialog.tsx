import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useIPC } from '../hooks/useIPC';
import type { PermissionRequest } from '../types';
import { Shield, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { describePermission } from '../utils/permission-summary';

interface PermissionDialogProps {
  permission: PermissionRequest;
}

function getWarningKey(kind?: 'advanced' | 'delete' | 'outside' | 'normal'): string | null {
  if (kind === 'advanced') return 'permission.advancedWarning';
  if (kind === 'delete') return 'permission.deleteWarning';
  if (kind === 'outside') return 'permission.outsideWarning';
  return null;
}

export function PermissionDialog({ permission }: PermissionDialogProps) {
  const { t } = useTranslation();
  const { respondToPermission } = useIPC();
  const [pendingAlwaysAllow, setPendingAlwaysAllow] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  // Elevated / delete requests never offer the session allow-all shortcut.
  const isElevatedOnly = permission.kind === 'advanced' || permission.kind === 'delete';
  const isHighRisk =
    isElevatedOnly ||
    ['bash', 'write', 'edit', 'execute_command', 'write_file', 'edit_file'].includes(
      permission.toolName
    );
  const warningKey = getWarningKey(permission.kind);
  const summary = describePermission(permission.toolName, permission.input, t);

  return (
    <div className="fixed inset-0 bg-black/20 backdrop-blur-sm flex items-center justify-center z-50 animate-fade-in">
      <div className="card w-full max-w-md p-6 m-4 shadow-elevated animate-slide-up">
        {/* Header */}
        <div className="flex items-start gap-4">
          <div
            className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isHighRisk ? 'bg-warning/10' : 'bg-accent-muted'
            }`}
          >
            {isHighRisk ? (
              <AlertTriangle className="w-6 h-6 text-warning" />
            ) : (
              <Shield className="w-6 h-6 text-accent" />
            )}
          </div>

          <div className="flex-1">
            <h2 className="text-lg font-semibold text-text-primary">
              {t('permission.permissionRequired')}
            </h2>
            <p className="text-sm text-text-secondary mt-1">{summary}</p>
          </div>
        </div>

        {/* Details Toggle */}
        <button
          onClick={() => setDetailsOpen((v) => !v)}
          className="mt-3 w-full btn btn-ghost text-sm"
        >
          {detailsOpen ? (
            <>
              <ChevronUp className="w-4 h-4" />
              {t('permission.detailsCollapse')}
            </>
          ) : (
            <>
              <ChevronDown className="w-4 h-4" />
              {t('permission.detailsExpand')}
            </>
          )}
        </button>

        {detailsOpen && (
          <div className="mt-2 p-4 bg-surface-muted rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium text-text-primary">{t('permission.tool')}</span>
              <span className="font-mono text-accent text-sm">{permission.toolName}</span>
            </div>

            <div className="text-sm text-text-secondary">
              <span className="font-medium text-text-primary">{t('permission.input')}</span>
              <pre className="mt-1 text-xs code-block max-h-32 overflow-auto">
                {JSON.stringify(permission.input, null, 2)}
              </pre>
            </div>
          </div>
        )}

        {/* Warning (kind-specific) */}
        {warningKey && (
          <div className="mt-4 p-3 bg-warning/10 border border-warning/20 rounded-xl">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
              <p className="text-sm text-warning">{t(warningKey)}</p>
            </div>
          </div>
        )}
        {!warningKey && isHighRisk && (
          <div className="mt-4 p-3 bg-warning/10 border border-warning/20 rounded-xl">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-warning mt-0.5 flex-shrink-0" />
              <p className="text-sm text-warning">{t('permission.warning')}</p>
            </div>
          </div>
        )}

        {/* Actions - 2x2 grid, text-only secondary buttons */}
        <div className="mt-6 grid grid-cols-2 gap-2">
          <button
            onClick={() => respondToPermission(permission.toolUseId, 'deny')}
            className="btn btn-secondary text-sm py-2"
          >
            {t('permission.deny')}
          </button>

          <button
            onClick={() => respondToPermission(permission.toolUseId, 'allow')}
            className="btn btn-secondary text-sm py-2"
          >
            {t('permission.allow')}
          </button>

          {!isElevatedOnly && (
            <button
              onClick={() => respondToPermission(permission.toolUseId, 'allow', true)}
              className="btn btn-secondary text-sm py-2"
            >
              {t('permission.allowAllSession')}
            </button>
          )}

          {!pendingAlwaysAllow && !isElevatedOnly && (
            <button
              onClick={() => {
                const dangerousTools = ['bash', 'write', 'edit', 'execute_command'];
                const isDangerous = dangerousTools.some((tool) =>
                  permission.toolName?.toLowerCase().includes(tool)
                );
                if (isDangerous) {
                  setPendingAlwaysAllow(true);
                } else {
                  respondToPermission(permission.toolUseId, 'allow_always');
                }
              }}
              className="btn btn-secondary text-sm py-2"
            >
              {t('permission.alwaysAllow')}
            </button>
          )}
          {pendingAlwaysAllow && !isElevatedOnly && (
            <div className="col-span-2 p-3 bg-warning/10 border border-warning/20 rounded-xl">
              <p className="text-sm text-warning mb-2">
                {t('permission.alwaysAllowConfirm', { toolName: permission.toolName })}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPendingAlwaysAllow(false)}
                  className="flex-1 btn btn-secondary text-sm"
                >
                  {t('permission.deny')}
                </button>
                <button
                  onClick={() => {
                    setPendingAlwaysAllow(false);
                    respondToPermission(permission.toolUseId, 'allow_always');
                  }}
                  className="flex-1 btn btn-secondary text-sm"
                >
                  {t('permission.alwaysAllow')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
