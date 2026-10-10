import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import {
  ChevronLeft,
  ChevronRight,
  Trash2,
  Moon,
  Sun,
  Monitor,
  Settings,
  Search as SearchIcon,
  Plus,
  ListChecks,
  Check,
  Pencil,
  MoreHorizontal,
  CheckCircle2,
} from 'lucide-react';
import type { Session } from '../types';

import sidebarLogoSrc from '../assets/logo.png';

type SessionGroup = {
  key: string;
  label: string;
  sessions: Session[];
};

type ContextMenuState = {
  sessionId: string;
  x: number;
  y: number;
} | null;

/**
 * 任务条目可视状态（唯一真相来源，侧边栏所有行都走这里）。
 *
 * 优先级是关键——运行中永远压过一切：
 * 1. running：session.status === 'running'，或本地仍有未结束的回合
 *    （activeTurn / pendingTurns / 执行时钟未结束 / 还有流式残留）。
 *    运行中途会产生中间 assistant/tool 消息，绝不能因此判完成 → … + 整条标黄。
 * 2. completed：上面都不命中，且本轮结局是 completed（正常跑完、有最终
 *    回答）。lastTurnOutcome 只在新一轮 running 到达时清 null、在"缓冲已空"
 *    的 idle 落定瞬间写入 completed/stopped——中间 assistant/tool 消息和
 *    停止后抢救的半截回复都不会把它置绿 → √ + 整条标绿。
 * 3. idle：新任务、停止/中止、无最终回答、重启后历史任务等，一律不打标记。
 */
type SessionVisualStatus = 'running' | 'completed' | 'idle';

const sessionVisualCache = new Map<
  string,
  { localRunning: boolean; lastTurnOutcome: 'completed' | 'stopped' | null }
>();

function getSessionStatusVisual(
  status: Session['status'],
  opts: { localRunning: boolean; lastTurnOutcome: 'completed' | 'stopped' | null }
): SessionVisualStatus {
  if (status === 'running' || opts.localRunning) return 'running';
  if (opts.lastTurnOutcome === 'completed') return 'completed';
  return 'idle';
}

export function Sidebar() {
  const { t } = useTranslation();
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const settings = useAppStore((s) => s.settings);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setMessages = useAppStore((s) => s.setMessages);
  const setHasMoreMessages = useAppStore((s) => s.setHasMoreMessages);
  const setTraceSteps = useAppStore((s) => s.setTraceSteps);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const updateSession = useAppStore((s) => s.updateSession);
  const isConfigured = useAppStore((s) => s.isConfigured);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  // 侧边栏每一行都有的两个本地信号：
  // - localRunning：activeTurn / pendingTurns / 执行时钟未结束 / 流式残留 /
  //   user 追问还排着队。发消息瞬间 main 的 running 事件还没到，或
  //   session.list 刷新用落库的 idle 覆盖了 running 时，这是"还在处理却差点
  //   打勾"的唯一兜底，running 优先级最高。
  // - lastTurnOutcome：本轮结局（completed=正常跑完有最终回答；stopped=停止/
  //   中止/超时）。由 useIPC 在 session.status(idle) 落定或最终消息到达时写入，
  //   新一轮 running 到达时清 null——详见 store 里的 lastTurnOutcome 注释。
  const sessionVisuals = useAppStore(
    useShallow((s) => {
      const map: Record<
        string,
        { localRunning: boolean; lastTurnOutcome: 'completed' | 'stopped' | null }
      > = {};
      for (const session of s.sessions) {
        const ss = s.sessionStates[session.id];
        const messages = ss?.messages ?? [];
        const localRunning =
          Boolean(ss?.activeTurn) ||
          (ss?.pendingTurns?.length ?? 0) > 0 ||
          (ss?.executionClock != null &&
            ss.executionClock.startAt !== null &&
            ss.executionClock.endAt === null) ||
          Boolean(ss?.partialMessage || ss?.partialThinking) ||
          // 排队中的追问（并发槽未释放、等待启动）同样算"还在处理"
          messages.some((m) => m.localStatus === 'queued');
        const lastTurnOutcome = ss?.lastTurnOutcome ?? null;
        // 复用引用：值没变就沿用缓存对象，useShallow 才能判等、
        // 流式 tick 时侧边栏才不会跟着每一帧重渲染。
        const prev = sessionVisualCache.get(session.id);
        if (
          prev &&
          prev.localRunning === localRunning &&
          prev.lastTurnOutcome === lastTurnOutcome
        ) {
          map[session.id] = prev;
        } else {
          const next = { localRunning, lastTurnOutcome };
          sessionVisualCache.set(session.id, next);
          map[session.id] = next;
        }
      }
      // 清理已删除会话的缓存，避免 Map 无限增长（每次都对账，
      // 删除+新建等长替换的场景也能覆盖）
      const alive = new Set(s.sessions.map((x) => x.id));
      for (const key of Array.from(sessionVisualCache.keys())) {
        if (!alive.has(key)) sessionVisualCache.delete(key);
      }
      return map;
    })
  );
  const {
    deleteSession,
    batchDeleteSessions,
    getSessionMessagesPaginated,
    getSessionTraceSteps,
    isElectron,
  } = useIPC();
  const setLoadingSessionId = useAppStore((s) => s.setLoadingSessionId);
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSelectMode, setIsSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [renameSessionId, setRenameSessionId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const normalizedQuery = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);
  const filteredSessions = useMemo(() => {
    return normalizedQuery
      ? sessions.filter((session) => session.title.toLowerCase().includes(normalizedQuery))
      : sessions;
  }, [sessions, normalizedQuery]);

  const groupedSessions = useMemo(
    () => groupSessionsByDate(filteredSessions, t),
    [filteredSessions, t]
  );

  // Exit select mode when sidebar collapses
  useEffect(() => {
    if (sidebarCollapsed && isSelectMode) {
      setIsSelectMode(false);
      setSelectedIds(new Set());
      setShowDeleteConfirm(false);
    }
  }, [sidebarCollapsed, isSelectMode]);

  // Escape key exits select mode
  useEffect(() => {
    if (!isSelectMode) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsSelectMode(false);
        setSelectedIds(new Set());
        setShowDeleteConfirm(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSelectMode]);

  // Reset selection when search query changes to avoid deleting hidden sessions
  useEffect(() => {
    if (isSelectMode) {
      setSelectedIds(new Set());
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  const exitSelectMode = useCallback(() => {
    setIsSelectMode(false);
    setSelectedIds(new Set());
    setShowDeleteConfirm(false);
  }, []);

  const toggleSelectSession = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const visibleSessionIds = useMemo(() => filteredSessions.map((s) => s.id), [filteredSessions]);

  const allVisibleSelected =
    visibleSessionIds.length > 0 && visibleSessionIds.every((id) => selectedIds.has(id));

  const toggleSelectAll = useCallback(() => {
    if (allVisibleSelected) {
      // Deselect all visible, keep others
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) {
          next.delete(id);
        }
        return next;
      });
    } else {
      // Select all visible, keep existing selections
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSessionIds) {
          next.add(id);
        }
        return next;
      });
    }
  }, [allVisibleSelected, visibleSessionIds]);

  const handleBatchDelete = useCallback(() => {
    const visibleSet = new Set(visibleSessionIds);
    const ids = Array.from(selectedIds).filter((id) => visibleSet.has(id));
    if (ids.length === 0) return;
    batchDeleteSessions(ids);
    exitSelectMode();
  }, [selectedIds, visibleSessionIds, batchDeleteSessions, exitSelectMode]);

  const handleSessionClick = useCallback(
    async (sessionId: string) => {
      setShowSettings(false);

      if (activeSessionId === sessionId) return;

      // Read sessionStates at call-time from the store rather than closing over
      // the selector value. The selector returns a new object reference every
      // time any session's state changes (patchSession spreads the whole map),
      // so including it in deps would rebuild this callback on every streaming
      // tick and cause a React #185 "Maximum update depth exceeded" loop when
      // rapidly switching sessions on slow renderers (e.g. Windows).
      const currentSessionStates = useAppStore.getState().sessionStates;

      const existingMessages = currentSessionStates[sessionId]?.messages;
      const existingSteps = currentSessionStates[sessionId]?.traceSteps;
      const needMessages = (!existingMessages || existingMessages.length === 0) && isElectron;
      const needTrace = (!existingSteps || existingSteps.length === 0) && isElectron;

      // Switch active session immediately so header/sidebar highlight updates
      setActiveSession(sessionId);

      if (needMessages || needTrace) {
        // Signal loading state so the UI can show a skeleton/spinner
        setLoadingSessionId(sessionId);

        // Parallelize IPC calls — messages and trace steps are independent
        try {
          const [messagesResult, traceStepsResult] = await Promise.all([
            needMessages
              ? getSessionMessagesPaginated(sessionId, 50, 0).catch((error) => {
                  console.error('[Sidebar] Failed to load messages:', error);
                  return null;
                })
              : Promise.resolve(null),
            needTrace
              ? getSessionTraceSteps(sessionId).catch((error) => {
                  console.error('[Sidebar] Failed to load trace steps:', error);
                  return null;
                })
              : Promise.resolve(null),
          ]);

          if (messagesResult?.messages?.length) {
            setMessages(sessionId, messagesResult.messages);
          }
          if (messagesResult) {
            setHasMoreMessages(sessionId, messagesResult.hasMore);
          }
          if (traceStepsResult) {
            setTraceSteps(sessionId, traceStepsResult);
          }
        } catch (error) {
          console.error('[Sidebar] Failed to load session data:', error);
        } finally {
          // Guard: only clear loading if this session is still the one being
          // loaded. A newer click may have already replaced loadingSessionId
          // with a different session — clearing it here would hide the
          // spinner for that session and leave the user staring at an empty
          // "start conversation" placeholder.
          if (useAppStore.getState().loadingSessionId === sessionId) {
            setLoadingSessionId(null);
          }
        }
      }
    },
    [
      activeSessionId,
      getSessionMessagesPaginated,
      getSessionTraceSteps,
      isElectron,
      setActiveSession,
      setLoadingSessionId,
      setMessages,
      setHasMoreMessages,
      setShowSettings,
      setTraceSteps,
    ]
  );

  const handleNewSession = () => {
    setActiveSession(null);
    setShowSettings(false);
  };

  const handleDeleteSession = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    deleteSession(sessionId);
  };

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ sessionId, x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleRenameClick = useCallback(() => {
    if (!contextMenu) return;
    const session = sessions.find((s) => s.id === contextMenu.sessionId);
    if (!session) return;
    setRenameSessionId(contextMenu.sessionId);
    setRenameTitle(session.title);
    closeContextMenu();
  }, [closeContextMenu, contextMenu, sessions]);

  const cancelRename = useCallback(() => {
    setRenameSessionId(null);
    setRenameTitle('');
  }, []);

  const handleRenameSubmit = useCallback(() => {
    if (!renameSessionId) return;

    const nextTitle = renameTitle.trim();
    if (!nextTitle) return;

    updateSession(renameSessionId, { title: nextTitle });
    cancelRename();
    closeContextMenu();
  }, [cancelRename, closeContextMenu, renameSessionId, renameTitle, updateSession]);

  useEffect(() => {
    if (!renameSessionId) return;

    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameSessionId]);

  useEffect(() => {
    if (!contextMenu && !renameSessionId) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && contextMenuRef.current?.contains(target)) {
        return;
      }
      if (target && renameInputRef.current?.contains(target)) {
        return;
      }

      if (renameSessionId) {
        cancelRename();
      }
      if (contextMenu) {
        closeContextMenu();
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [cancelRename, closeContextMenu, contextMenu, renameSessionId]);

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
      closeContextMenu();
    }
  };

  const toggleTheme = () => {
    const next =
      settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark';
    updateSettings({ theme: next });
  };

  const themeIcon =
    settings.theme === 'dark' ? (
      <Sun className="w-4 h-4" />
    ) : settings.theme === 'light' ? (
      <Moon className="w-4 h-4" />
    ) : (
      <Monitor className="w-4 h-4" />
    );

  if (sidebarCollapsed) {
    return (
      <aside className="w-[4.5rem] bg-surface/96 border-r border-border-muted flex flex-col overflow-hidden">
        <div className="px-3 pt-4 pb-3 flex flex-col items-center gap-2 border-b border-border-muted">
          <button
            onClick={toggleSidebar}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
            title={t('context.expandPanel')}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          <button
            onClick={handleNewSession}
            className="w-9 h-9 rounded-2xl flex items-center justify-center bg-background hover:bg-surface-hover transition-colors text-text-primary border border-border-subtle"
            title={t('sidebar.newTask')}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-3 py-4">
          <button
            onClick={toggleSidebar}
            className="rounded-2xl px-2 py-3 text-[11px] leading-4 text-center text-text-muted hover:bg-surface-hover transition-colors"
            title={t('sidebar.expandToView')}
          >
            {t('sidebar.expandToView')}
          </button>
        </div>

        <div className="px-3 py-3 border-t border-border-muted flex flex-col items-center gap-2">
          <button
            onClick={toggleTheme}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary"
            title={t('sidebar.themeToggle')}
          >
            {themeIcon}
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="w-9 h-9 rounded-2xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary relative"
            title={t('sidebar.settings')}
          >
            <Settings className="w-4 h-4" />
            {!isConfigured && (
              <span className="absolute right-2 top-2 w-1.5 h-1.5 rounded-full bg-accent" />
            )}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <>
      <aside className="w-[17.5rem] bg-surface/96 border-r border-border-muted flex flex-col overflow-hidden">
        <div className="px-4 pt-5 pb-4 border-b border-border-muted">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex items-center gap-3">
              <img
                src={sidebarLogoSrc}
                alt={t('common.appLogoAlt')}
                className="w-10 h-10 rounded-2xl object-cover border border-border-subtle bg-background/60 flex-shrink-0"
              />
              <div className="min-w-0">
                <h1 className="text-[1.34rem] leading-none font-semibold tracking-[-0.035em] text-text-primary">
                  今点通
                </h1>
              </div>
            </div>
            <button
              onClick={toggleSidebar}
              className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-surface-hover transition-colors text-text-secondary flex-shrink-0"
              title={t('context.collapsePanel')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>

          <button
            onClick={handleNewSession}
            className="mt-3 w-full flex items-center gap-2 rounded-xl bg-background/60 px-3 py-2 text-left text-text-primary hover:bg-surface-hover transition-colors"
          >
            <Plus className="w-4 h-4 text-text-secondary flex-shrink-0" />
            <span className="text-[13px] font-medium">{t('sidebar.newTask')}</span>
          </button>

          {sessions.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('sidebar.search')}
                  className="w-full rounded-xl border border-transparent bg-background/50 pl-9 pr-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:border-border focus:bg-background transition-colors"
                />
              </div>
              <button
                onClick={() => {
                  if (isSelectMode) {
                    exitSelectMode();
                  } else {
                    setIsSelectMode(true);
                  }
                }}
                className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors ${
                  isSelectMode
                    ? 'bg-accent text-white'
                    : 'text-text-secondary hover:text-text-primary hover:bg-surface-hover'
                }`}
                title={t('sidebar.manage')}
              >
                <ListChecks className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-4">
          {groupedSessions.length === 0 ? (
            <div className="px-3 py-6">
              <p className="text-sm text-text-secondary">{t('sidebar.noTasks')}</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">{t('sidebar.noTasksHint')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {groupedSessions.map((group) => (
                <section key={group.key}>
                  <div className="px-3 pb-2 text-[11px] font-medium tracking-[0.04em] text-text-muted">
                    {group.label}
                  </div>
                  <div className="space-y-0.5">
                    {group.sessions.map((session) => {
                      const isActive = activeSessionId === session.id;
                      const isSelected = selectedIds.has(session.id);
                      const visual = sessionVisuals[session.id] ?? {
                        localRunning: false,
                        lastTurnOutcome: null,
                      };
                      const visualStatus = getSessionStatusVisual(session.status, visual);
                      const isRunning = visualStatus === 'running';
                      const isCompleted = visualStatus === 'completed';
                      // 方案B：整行高亮 — 运行中淡黄、已完成淡绿；选中态优先
                      const statusBgClass =
                        !isSelectMode && isRunning
                          ? 'bg-warning/12 border border-warning/30 !border-l-2 !border-l-warning/70'
                          : !isSelectMode && isCompleted
                            ? 'bg-success/10 border border-success/20 !border-l-2 !border-l-success/60'
                            : 'border border-transparent';
                      return (
                        <div
                          key={session.id}
                          onClick={() => {
                            if (isSelectMode) {
                              toggleSelectSession(session.id);
                            } else {
                              handleSessionClick(session.id);
                            }
                          }}
                          onContextMenu={(e) => handleContextMenu(e, session.id)}
                          onMouseEnter={() => setHoveredSession(session.id)}
                          onMouseLeave={() => setHoveredSession(null)}
                          title={isRunning ? '任务运行中' : isCompleted ? '任务已完成' : undefined}
                          className={`group relative cursor-pointer rounded-lg px-2.5 py-1.5 transition-colors ${statusBgClass} ${
                            isSelectMode && isSelected
                              ? '!bg-accent-muted/20 !border-accent/30'
                              : isActive && !isSelectMode
                                ? isRunning
                                  ? 'bg-warning/20'
                                  : isCompleted
                                    ? 'bg-success/15'
                                    : 'bg-surface-hover/80'
                                : !isRunning && !isCompleted
                                  ? 'hover:bg-surface-hover/60'
                                  : ''
                          }`}
                        >
                          <div className={`flex items-center gap-2 ${!isSelectMode ? 'pr-6' : ''}`}>
                            {!isSelectMode && isRunning && (
                              <span
                                className="w-5 h-5 rounded-full bg-warning/15 border border-warning/30 flex items-center justify-center flex-shrink-0"
                                aria-label="任务运行中"
                              >
                                <MoreHorizontal className="w-3 h-3 text-warning animate-pulse" />
                              </span>
                            )}
                            {!isSelectMode && isCompleted && (
                              <span
                                className="w-5 h-5 rounded-full bg-success/15 border border-success/25 flex items-center justify-center flex-shrink-0"
                                aria-label="任务已完成"
                              >
                                <CheckCircle2 className="w-3 h-3 text-success" />
                              </span>
                            )}
                            {isSelectMode && (
                              <div
                                className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-colors ${
                                  isSelected
                                    ? 'bg-accent text-white'
                                    : 'border border-border-muted bg-background'
                                }`}
                              >
                                {isSelected && <Check className="w-2.5 h-2.5" />}
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              {renameSessionId === session.id ? (
                                <input
                                  ref={renameInputRef}
                                  type="text"
                                  value={renameTitle}
                                  onChange={(e) => setRenameTitle(e.target.value)}
                                  onBlur={() => {
                                    cancelRename();
                                    closeContextMenu();
                                  }}
                                  onKeyDown={handleRenameKeyDown}
                                  onClick={(e) => e.stopPropagation()}
                                  className="w-full text-[13px] font-medium leading-5 text-text-primary bg-surface-active border border-accent rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-accent"
                                  autoFocus
                                />
                              ) : (
                                <div className="text-[13px] font-medium leading-5 text-text-primary truncate">
                                  {session.title}
                                </div>
                              )}
                            </div>
                          </div>

                          {!isSelectMode && hoveredSession === session.id && (
                            <button
                              onClick={(e) => handleDeleteSession(e, session.id)}
                              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-error hover:bg-surface-active transition-colors"
                              title={t('common.delete')}
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

        {isSelectMode ? (
          <div className="px-3 py-3 border-t border-border-muted">
            {showDeleteConfirm ? (
              <div className="border border-error/30 bg-error/10 rounded-lg px-3 py-3">
                <p className="text-[13px] text-text-primary mb-3">
                  {t('sidebar.batchDeleteConfirm', { count: selectedIds.size })}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                  >
                    {t('sidebar.cancel')}
                  </button>
                  <button
                    onClick={handleBatchDelete}
                    className="flex-1 px-3 py-1.5 rounded-lg text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors"
                  >
                    {t('sidebar.confirmDelete')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1">
                  <button
                    onClick={toggleSelectAll}
                    className="text-[12px] font-medium text-accent hover:text-accent/80 transition-colors"
                  >
                    {allVisibleSelected ? t('sidebar.deselectAll') : t('sidebar.selectAll')}
                  </button>
                  <span className="text-[12px] text-text-muted">
                    {t('sidebar.nSelected', { count: selectedIds.size })}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={exitSelectMode}
                    className="flex-1 px-3 py-2 rounded-xl text-[13px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                  >
                    {t('sidebar.cancel')}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={selectedIds.size === 0}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-error text-white hover:bg-error/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="px-3 py-3 border-t border-border-muted">
            <div className="flex items-center gap-2 rounded-2xl bg-background/50 px-3 py-2.5">
              <button
                onClick={() => setShowSettings(true)}
                className="flex-1 min-w-0 flex items-center gap-2 text-left text-text-secondary hover:text-text-primary transition-colors"
              >
                <Settings className="w-4 h-4 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-text-primary">
                    {t('sidebar.settings')}
                  </div>
                  <div className="text-[11px] text-text-muted truncate">
                    {isConfigured ? t('sidebar.apiConfigured') : t('sidebar.apiNotConfigured')}
                  </div>
                </div>
              </button>

              <button
                onClick={toggleTheme}
                className="w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors flex-shrink-0"
                title={t('sidebar.themeToggle')}
              >
                {themeIcon}
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Context Menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[120px] bg-surface border border-border rounded-lg shadow-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={handleRenameClick}
            className="w-full px-3 py-1.5 text-[13px] text-text-primary hover:bg-surface-hover flex items-center gap-2"
          >
            <Pencil className="w-3.5 h-3.5" />
            {t('sidebar.rename')}
          </button>
          <button
            onClick={() => {
              deleteSession(contextMenu.sessionId);
              setContextMenu(null);
            }}
            className="w-full px-3 py-1.5 text-[13px] text-error hover:bg-surface-hover flex items-center gap-2"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t('common.delete')}
          </button>
        </div>
      )}
    </>
  );
}

function groupSessionsByDate(sessions: Session[], t: (key: string) => string): SessionGroup[] {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfPreviousWeek = startOfToday - 7 * 86_400_000;

  const buckets: SessionGroup[] = [
    { key: 'today', label: t('sidebar.today'), sessions: [] },
    { key: 'yesterday', label: t('sidebar.yesterday'), sessions: [] },
    { key: 'previousWeek', label: t('sidebar.previousWeek'), sessions: [] },
    { key: 'older', label: t('sidebar.older'), sessions: [] },
  ];

  const sortedSessions = [...sessions].sort(
    (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)
  );
  for (const session of sortedSessions) {
    const timestamp = session.updatedAt || session.createdAt;
    if (timestamp >= startOfToday) {
      buckets[0].sessions.push(session);
    } else if (timestamp >= startOfYesterday) {
      buckets[1].sessions.push(session);
    } else if (timestamp >= startOfPreviousWeek) {
      buckets[2].sessions.push(session);
    } else {
      buckets[3].sessions.push(session);
    }
  }

  return buckets.filter((bucket) => bucket.sessions.length > 0);
}
