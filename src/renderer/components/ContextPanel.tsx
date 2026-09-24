import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { resolveArtifactPath } from '../utils/artifact-path';
import { normalizeArtifactPathValue } from '../utils/tool-output-path';
import {
  getArtifactLabel,
  getArtifactIconComponent,
  collectArtifactPaths,
  shouldDisplayArtifactPath,
} from '../utils/artifact-steps';
import { useIPC } from '../hooks/useIPC';
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  FileText,
  FileSpreadsheet,
  FilePieChart,
  FileCode2,
  FileArchive,
  FileAudio2,
  FileVideo,
  Image as ImageIcon,
  FolderOpen,
  FolderSync,
  File,
  Check,
  Loader2,
  Plug,
  Wrench,
  Cpu,
  Copy,
  Layers,
} from 'lucide-react';
import type { TraceStep, MCPServerInfo, ContentBlock, ToolUseContent } from '../types';
import { getMcpToolDisplayName } from './message/toolHelpers';

const EMPTY_STEPS: TraceStep[] = [];
const EMPTY_MESSAGES: never[] = [];

export function ContextPanel() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const sessions = useAppStore((s) => s.sessions);
  // Fine-grained slices instead of the whole sessionStates map: streaming
  // patches sessionStates on every animation frame, but these slices keep
  // stable references until they actually change — so the panel no longer
  // re-renders per token.
  const sessionSteps = useAppStore((s) =>
    activeSessionId ? s.sessionStates[activeSessionId]?.traceSteps : undefined
  );
  const sessionMessages = useAppStore((s) =>
    activeSessionId ? s.sessionStates[activeSessionId]?.messages : undefined
  );
  const liveContextWindow = useAppStore((s) =>
    activeSessionId ? s.sessionStates[activeSessionId]?.contextWindow : undefined
  );
  const appConfig = useAppStore((s) => s.appConfig);
  // 旧会话没有 live 值（session.contextInfo 只在运行中下发）：
  // 退到当前配置的窗口，再退到与主进程一致的 128000 默认值，保证切旧对话也有分母可算。
  const contextWindow =
    liveContextWindow ?? appConfig?.contextWindow ?? 128000;
  const contextPanelCollapsed = useAppStore((s) => s.contextPanelCollapsed);
  const toggleContextPanel = useAppStore((s) => s.toggleContextPanel);
  const workingDir = useAppStore((s) => s.workingDir);
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const { getMCPServers, changeWorkingDir } = useIPC();
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const [expandedConnector, setExpandedConnector] = useState<string | null>(null);
  const [mcpServers, setMcpServers] = useState<MCPServerInfo[]>([]);
  const [copiedPath, setCopiedPath] = useState(false);
  const [isChangingDir, setIsChangingDir] = useState(false);
  const [, setRecentWorkspaceFiles] = useState<
    Array<{
      path: string;
      modifiedAt: number;
      size: number;
    }>
  >([]);

  const handleCopyPath = async (path: string) => {
    try {
      // Escape spaces for shell usage so the path can be pasted into terminal
      let shellPath = path;
      if (path.includes(' ')) {
        const isWindows = window.electronAPI?.platform === 'win32';
        shellPath = isWindows ? `"${path}"` : path.replace(/ /g, '\\ ');
      }
      await navigator.clipboard.writeText(shellPath);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  };

  const steps = sessionSteps ?? EMPTY_STEPS;
  const activeSession = activeSessionId ? sessions.find((s) => s.id === activeSessionId) : null;
  const currentWorkingDir = activeSession?.cwd || workingDir;
  const canShowItemInFolder =
    typeof window !== 'undefined' && !!window.electronAPI?.showItemInFolder;

  // Session info computations
  const messages = sessionMessages ?? EMPTY_MESSAGES;
  const artifactPaths = useMemo(() => collectArtifactPaths(steps, messages), [steps, messages]);
  const activeConfigSet = appConfig?.configSets?.find(
    (set) => set.id === appConfig.activeConfigSetId
  );
  const activeConfigSetModel = activeConfigSet
    ? activeConfigSet.profiles[activeConfigSet.activeProfileKey]?.model
    : undefined;
  const modelName = activeConfigSet
    ? `${activeConfigSet.name}：${activeConfigSetModel || '—'}`
    : activeSession?.model || appConfig?.model || '—';

  // Token usage aggregation
  const tokenUsage = useMemo(() => {
    let input = 0;
    let output = 0;
    for (const msg of messages) {
      if (msg.tokenUsage) {
        input += msg.tokenUsage.input || 0;
        output += msg.tokenUsage.output || 0;
      }
    }
    return { input, output, total: input + output };
  }, [messages]);

  // Context usage: last message's input tokens ≈ current context occupation
  const contextUsage = useMemo(() => {
    if (!contextWindow) return null;

    let lastInput = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].tokenUsage?.input) {
        lastInput = messages[i].tokenUsage!.input;
        break;
      }
    }
    if (lastInput === 0) return null;

    const percentage = Math.min((lastInput / contextWindow) * 100, 100);
    return { used: lastInput, total: contextWindow, percentage };
  }, [contextWindow, messages]);

  const completedStepCount = useMemo(
    () => steps.reduce((n, s) => n + (s.status === 'completed' ? 1 : 0), 0),
    [steps]
  );

  const mcpToolDisplayNames = useMemo(() => {
    const displayNames = new Map<string, string>();

    for (const msg of messages) {
      if (!Array.isArray(msg.content)) {
        continue;
      }

      for (const block of msg.content as ContentBlock[]) {
        if (block.type !== 'tool_use') {
          continue;
        }

        const toolUse = block as ToolUseContent;
        if (!toolUse.name.startsWith('mcp__')) {
          continue;
        }

        displayNames.set(toolUse.name, getMcpToolDisplayName(toolUse.name, toolUse.displayName));
      }
    }

    for (const step of steps) {
      if (step.type !== 'tool_call' || !step.toolName?.startsWith('mcp__')) {
        continue;
      }

      if (!displayNames.has(step.toolName)) {
        displayNames.set(step.toolName, getMcpToolDisplayName(step.toolName, step.title));
      }
    }

    return displayNames;
  }, [messages, steps]);

  useEffect(() => {
    if (contextPanelCollapsed) {
      return;
    }
    if (
      typeof window === 'undefined' ||
      !window.electronAPI?.artifacts?.listRecentFiles ||
      !currentWorkingDir ||
      !activeSession?.createdAt
    ) {
      setRecentWorkspaceFiles([]);
      return;
    }

    let cancelled = false;
    // 2s debounce: each completed tool step used to retrigger a full recursive
    // workspace scan in the main process; dense tool loops kept the scan hot.
    const timer = setTimeout(async () => {
      try {
        const files = await window.electronAPI.artifacts.listRecentFiles(
          currentWorkingDir,
          activeSession.createdAt,
          50
        );
        if (!cancelled) {
          setRecentWorkspaceFiles(files || []);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load recent workspace files:', error);
          setRecentWorkspaceFiles([]);
        }
      }
    }, 2000);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    activeSession?.createdAt,
    activeSessionId,
    completedStepCount,
    contextPanelCollapsed,
    currentWorkingDir,
  ]);

  const displayArtifacts = useMemo(() => {
    const allCandidates: string[] = [];
    const seenPaths = new Set<string>();

    for (const path of artifactPaths) {
      // Candidate may itself be a file:// URL or carry percent-encoded CJK —
      // normalize BEFORE resolving so it dedupes against the plain local path.
      const normalized = normalizeArtifactPathValue(path);
      const resolvedPath = resolveArtifactPath(normalized, currentWorkingDir);
      if (seenPaths.has(resolvedPath)) continue;
      seenPaths.add(resolvedPath);
      allCandidates.push(resolvedPath);
    }

    // Filter out non-deliverable files (.js, .json, .py, sidecars, etc.)
    // and deduplicate by filename so the same file only appears once.
    const dedupedByName = new Map<string, string>();

    for (const path of allCandidates) {
      if (!shouldDisplayArtifactPath(path)) continue;
      const normalized = normalizeArtifactPathValue(path).replace(/\\/g, '/');
      const nameKey = (normalized.split('/').pop() || normalized).toLowerCase();
      if (!dedupedByName.has(nameKey)) {
        dedupedByName.set(nameKey, path);
      }
    }

    return Array.from(dedupedByName.values()).map((path) => ({
      label: getArtifactLabel(path),
      path,
    }));
  }, [artifactPaths, currentWorkingDir]);

  // Only show artifacts that actually exist on disk. Text scans can produce
  // phantom candidates (URLs, code samples, example filenames); existence
  // checking keeps the panel to real deliverables.
  const [existingArtifacts, setExistingArtifacts] = useState<
    Array<{ label: string; path: string }>
  >([]);

  useEffect(() => {
    let cancelled = false;
    const checkExistence = async () => {
      if (!window.electronAPI?.artifacts?.checkPaths) {
        setExistingArtifacts(displayArtifacts);
        return;
      }
      try {
        const paths = displayArtifacts.map((a) => a.path);
        const existing = await window.electronAPI.artifacts.checkPaths(
          paths,
          currentWorkingDir ?? undefined
        );
        if (cancelled) return;
        const existingSet = new Set(existing);
        setExistingArtifacts(displayArtifacts.filter((a) => existingSet.has(a.path)));
      } catch (error) {
        console.error('Failed to check artifact paths:', error);
        if (!cancelled) {
          setExistingArtifacts(displayArtifacts);
        }
      }
    };
    void checkExistence();
    return () => {
      cancelled = true;
    };
  }, [displayArtifacts, currentWorkingDir]);

  useEffect(() => {
    if (contextPanelCollapsed) {
      return;
    }
    const loadMCPServers = async () => {
      try {
        const servers = await getMCPServers();
        setMcpServers(servers || []);
      } catch (error) {
        console.error('Failed to load MCP servers:', error);
      }
    };
    loadMCPServers();
    const interval = setInterval(loadMCPServers, 30000);
    return () => clearInterval(interval);
  }, [contextPanelCollapsed, getMCPServers]);

  if (contextPanelCollapsed) {
    return (
      <div className="w-10 bg-background border-l border-border-muted flex items-start justify-center pt-3">
        <button
          onClick={toggleContextPanel}
          className="w-7 h-7 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.expandPanel')}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="w-72 bg-background border-l border-border-muted flex flex-col overflow-hidden text-sm">
      {/* Header */}
      <div className="px-3 h-10 flex items-center gap-2 border-b border-border-muted shrink-0">
        <button
          onClick={toggleContextPanel}
          className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-surface-hover text-text-muted hover:text-text-primary transition-colors"
          title={t('context.collapsePanel')}
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
          {t('context.context')}
        </span>
      </div>

      {/* Session Stats */}
      {activeSession && (
        <div className="px-4 py-3 border-b border-border-muted space-y-1.5">
          <div className="flex items-center gap-1.5 text-text-primary font-medium">
            <Cpu className="w-3.5 h-3.5 text-text-muted shrink-0" />
            <span className="truncate">{modelName}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-text-muted pl-5">
            <span className="flex items-center gap-1">
              {t('context.inputTokens')} {formatTokenCount(tokenUsage.input)}
            </span>
            <span className="flex items-center gap-1">
              {t('context.outputTokens')} {formatTokenCount(tokenUsage.output)}
            </span>
          </div>
        </div>
      )}

      {/* Context Usage */}
      {activeSession && contextUsage && (
        <div className="px-4 py-2.5 border-b border-border-muted space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
              {t('context.contextUsage')}
            </span>
            <span
              className={`text-xs font-medium ${
                contextUsage.percentage > 95
                  ? 'text-error'
                  : contextUsage.percentage > 80
                    ? 'text-warning'
                    : 'text-text-primary'
              }`}
            >
              {Math.round(contextUsage.percentage)}%
            </span>
          </div>
          <div className="h-1.5 bg-surface-muted rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                contextUsage.percentage > 95
                  ? 'bg-error'
                  : contextUsage.percentage > 80
                    ? 'bg-warning'
                    : 'bg-gradient-to-r from-accent to-accent-hover'
              }`}
              style={{ width: `${contextUsage.percentage}%` }}
            />
          </div>
          <p className="text-xs text-text-muted">
            {t('context.contextUsageLabel', {
              used: formatTokenCount(contextUsage.used),
              total: formatTokenCount(contextUsage.total),
            })}
          </p>
        </div>
      )}

      {/* Artifacts Section */}
      <div className="border-b border-border-muted">
        <button
          onClick={() => setArtifactsOpen(!artifactsOpen)}
          className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-surface-hover transition-colors"
        >
          <span className="text-xs font-medium text-text-muted uppercase tracking-wider">
            {t('context.artifacts')}
          </span>
          {artifactsOpen ? (
            <ChevronUp className="w-3.5 h-3.5 text-text-muted" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-text-muted" />
          )}
        </button>

        {artifactsOpen && (
          <div className="pb-2 max-h-64 overflow-y-auto">
            {existingArtifacts.length === 0 ? (
              <div className="flex items-center gap-2 px-4 py-2 text-xs text-text-muted">
                <Layers className="w-3.5 h-3.5 shrink-0" />
                <span>{t('context.noArtifactsYet')}</span>
              </div>
            ) : (
              <div>
                {existingArtifacts.map((artifact, index) => {
                  const label = artifact.label || t('context.fileCreated');
                  const artifactPath = artifact.path;
                  const canClick = Boolean(artifactPath && canShowItemInFolder);
                  const iconComponent = getArtifactIconComponent(label);
                  const IconComponent =
                    iconComponent === 'presentation'
                      ? FilePieChart
                      : iconComponent === 'table'
                        ? FileSpreadsheet
                        : iconComponent === 'document'
                          ? FileText
                          : iconComponent === 'code'
                            ? FileCode2
                            : iconComponent === 'image'
                              ? ImageIcon
                              : iconComponent === 'audio'
                                ? FileAudio2
                                : iconComponent === 'video'
                                  ? FileVideo
                                  : iconComponent === 'archive'
                                    ? FileArchive
                                    : iconComponent === 'text'
                                      ? File
                                      : File;

                  return (
                    <div
                      key={artifact.path || artifact.label || `artifact-${index}`}
                      className={`flex items-center gap-2 px-4 py-1.5 transition-colors ${canClick ? 'cursor-pointer hover:bg-surface-hover' : ''}`}
                      onClick={async () => {
                        if (!canClick) return;
                        const revealed = await window.electronAPI.showItemInFolder(
                          artifactPath,
                          currentWorkingDir ?? undefined
                        );
                        if (!revealed) {
                          setGlobalNotice({
                            id: `artifact-reveal-failed-${Date.now()}`,
                            type: 'warning',
                            message: t('context.revealFailed'),
                          });
                        }
                      }}
                      title={artifactPath || undefined}
                    >
                      <IconComponent className="w-3.5 h-3.5 text-text-muted shrink-0" />
                      <span className="text-xs text-text-primary truncate">{label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Working Directory */}
      <div className="border-b border-border-muted">
        <div className="px-4 py-2.5">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
            {t('context.workingDirectory')}
          </p>
          <div className="flex items-center gap-1.5 min-w-0">
            <FolderOpen className="w-3.5 h-3.5 text-text-muted shrink-0" />
            <span
              className={`text-xs truncate flex-1 ${currentWorkingDir ? 'text-text-primary cursor-pointer hover:text-accent-primary transition-colors' : 'text-text-muted'}`}
              title={currentWorkingDir ? t('context.openInFileManager') : ''}
              onClick={() =>
                currentWorkingDir && window.electronAPI?.showItemInFolder(currentWorkingDir)
              }
            >
              {currentWorkingDir ? formatPath(currentWorkingDir) : t('context.noFolderSelected')}
            </span>
            {currentWorkingDir && (
              <button
                onClick={() => handleCopyPath(currentWorkingDir)}
                className="text-text-muted hover:text-text-primary transition-colors shrink-0 ml-1"
                title={t('context.copyPath')}
              >
                {copiedPath ? (
                  <Check className="w-3 h-3 text-success" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
            )}
            <button
              onClick={async () => {
                setIsChangingDir(true);
                try {
                  const result = await changeWorkingDir(
                    activeSessionId || undefined,
                    currentWorkingDir || undefined
                  );
                  if (!result.success && result.error && result.error !== 'User cancelled') {
                    setGlobalNotice({
                      id: `change-dir-failed-${Date.now()}`,
                      type: 'warning',
                      message: `${t('context.changeDirFailed')}: ${result.error}`,
                    });
                  }
                } catch (error) {
                  setGlobalNotice({
                    id: `change-dir-failed-${Date.now()}`,
                    type: 'error',
                    message:
                      error instanceof Error && error.message
                        ? `${t('context.changeDirFailed')}: ${error.message}`
                        : t('context.changeDirFailed'),
                  });
                } finally {
                  setIsChangingDir(false);
                }
              }}
              disabled={isChangingDir}
              className="text-text-muted hover:text-text-primary disabled:opacity-50 transition-colors shrink-0"
              title={t('context.changeDir')}
            >
              {isChangingDir ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <FolderSync className="w-3 h-3" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* MCP Connectors */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-4 py-2.5">
          <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-2">
            {t('context.mcpConnectors')}
          </p>
          {mcpServers.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-text-muted py-1">
              <Plug className="w-3.5 h-3.5 shrink-0" />
              <span>{t('mcp.noConnectors')}</span>
            </div>
          ) : (
            <div className="space-y-0.5">
              {mcpServers.map((server) => (
                <ConnectorItem
                  key={server.id}
                  server={server}
                  steps={steps}
                  mcpToolDisplayNames={mcpToolDisplayNames}
                  expanded={expandedConnector === server.id}
                  onToggle={() =>
                    setExpandedConnector(expandedConnector === server.id ? null : server.id)
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectorItem({
  server,
  steps,
  mcpToolDisplayNames,
  expanded,
  onToggle,
}: {
  server: MCPServerInfo;
  steps: TraceStep[];
  mcpToolDisplayNames: Map<string, string>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  // Get MCP tools used from this server
  // Tool names are in format: mcp__ServerName__toolname (with double underscores)
  // Server name preserves original case and spaces are replaced with underscores
  const serverNamePattern = server.name.replace(/\s+/g, '_');

  const mcpToolsUsed = steps
    .filter((s) => s.toolName?.startsWith('mcp__'))
    .map((s) => s.toolName!)
    .filter((name, index, self) => self.indexOf(name) === index)
    .filter((name) => {
      // Check if this tool belongs to this server
      // Format: mcp__ServerName__toolname
      const match = name.match(/^mcp__(.+?)__(.+)$/);
      if (match) {
        const toolServerName = match[1];
        return toolServerName === serverNamePattern;
      }
      return false;
    });

  const usageCount = steps.filter(
    (s) => s.toolName?.startsWith('mcp__') && mcpToolsUsed.includes(s.toolName)
  ).length;

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <button
        onClick={onToggle}
        className={`w-full px-3 py-2 flex items-center gap-2 transition-colors ${
          server.connected ? 'bg-mcp/10 hover:bg-mcp/20' : 'bg-surface-muted hover:bg-surface-hover'
        }`}
      >
        <div
          className={`w-6 h-6 rounded flex items-center justify-center ${
            server.connected ? 'bg-mcp/20' : 'bg-surface-muted'
          }`}
        >
          <Plug className={`w-3.5 h-3.5 ${server.connected ? 'text-mcp' : 'text-text-muted'}`} />
        </div>
        <div className="flex-1 text-left min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary truncate">{server.name}</span>
            {!server.connected && (
              <span className="text-xs text-text-muted">({t('mcp.notConnected')})</span>
            )}
          </div>
          {server.connected && (
            <p className="text-xs text-text-muted">
              {t('mcp.toolCount', { count: server.toolCount })}
              {usageCount > 0 && ` • ${t('mcp.callCount', { count: usageCount })}`}
            </p>
          )}
        </div>
        {server.connected &&
          (expanded ? (
            <ChevronDown className="w-4 h-4 text-text-muted" />
          ) : (
            <ChevronRight className="w-4 h-4 text-text-muted" />
          ))}
      </button>

      {expanded && server.connected && (
        <div className="px-3 pb-2 space-y-1 bg-surface">
          {mcpToolsUsed.length > 0 ? (
            <>
              <p className="text-xs text-text-muted px-2 py-1">{t('context.toolsUsedLabel')}</p>
              {mcpToolsUsed.map((toolName, index) => {
                const count = steps.filter((s) => s.toolName === toolName).length;
                const readableName =
                  mcpToolDisplayNames.get(toolName) || getMcpToolDisplayName(toolName);

                return (
                  <div
                    key={index}
                    className="flex items-center gap-2 px-2 py-1.5 rounded bg-mcp/5 hover:bg-mcp/10 transition-colors"
                  >
                    <Wrench className="w-3.5 h-3.5 text-mcp" />
                    <span className="text-xs text-text-primary flex-1">{readableName}</span>
                    <span className="text-xs text-text-muted">{count}x</span>
                  </div>
                );
              })}
            </>
          ) : (
            <p className="text-xs text-text-muted px-2 py-1">{t('context.noToolsUsedYet')}</p>
          )}
        </div>
      )}
    </div>
  );
}

// Format long paths to show abbreviated version
function formatPath(path: string): string {
  if (!path) return '';

  // Windows: Replace C:\Users\username with ~
  const winHome = /^[A-Z]:\\Users\\[^\\]+/i;
  const winMatch = path.match(winHome);
  if (winMatch) {
    return '~' + path.slice(winMatch[0].length).replace(/\\/g, '/');
  }

  // macOS/Linux: Replace /Users/username or /home/username with ~
  const unixHome = /^\/(?:Users|home)\/[^/]+/;
  const unixMatch = path.match(unixHome);
  if (unixMatch) {
    return '~' + path.slice(unixMatch[0].length);
  }

  return path;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
