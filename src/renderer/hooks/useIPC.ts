import { useEffect, useCallback } from 'react';
import { useAppStore } from '../store';
import type {
  AppConfig,
  ClientEvent,
  ServerEvent,
  PermissionResult,
  Session,
  Message,
  TraceStep,
  ContentBlock,
} from '../types';
import i18n from '../i18n/config';

// Check if running in Electron
const isElectron = typeof window !== 'undefined' && window.electronAPI !== undefined;

// Unique local id generator. Two messages sent within the same millisecond
// used to collide on `msg-user-${Date.now()}`, which broke the store's
// turn-anchor lookup (assistant replies inserted after the wrong message —
// the observed "response stream confusion" after rapid sends / pause-resume).
function nextLocalId(prefix: string): string {
  const cryptoApi = typeof crypto !== 'undefined' ? crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `${prefix}-${cryptoApi.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Module-level singleton guard so only the FIRST useIPC() caller installs the
// server-event listener. Other callers (PermissionDialog, Sidebar, ChatView,
// etc.) still get the callback API but must NOT re-register the listener —
// the preload's `on()` is a "single-slot" bridge and re-registering (or
// unmounting a subsequent useIPC caller) tears down the single shared
// listener, silently dropping subsequent events from main.
let ipcListenerInstalled = false;

// RAF batching buffers (module-level so useCallback can access) + per-session
// turn scopes for sidebar status marking.
const pendingPartials: Record<string, string[]> = {};
const pendingThinking: Record<string, string[]> = {};
// 本轮起点时间戳：session.status=running 时记录，用于把"最终回答"判定
// 限定在本轮产生的消息内（历史上旧回答不能让停止/超时的任务误打绿勾）。
const turnStartedAt: Record<string, number> = {};

// Post-stop grace: when a running turn is stopped, the main process persists
// whatever was partially streamed and re-emits it as a regular message
// (stream.message) right before the session goes idle. The renderer must NOT
// wipe the live partial buffer the instant it stops — that is what made the
// visible reply vanish while only the trace panel survived. Instead, poll
// briefly: once the persisted message lands, addMessage() clears the partial
// buffers itself and reuses the same round anchor, and this poll finishes the
// turn teardown. A hard timeout restores the old (clear-everything) behavior
// if the persistence message never arrives.
const postStopGraceTimers = new Map<
  string,
  { poll: ReturnType<typeof setInterval>; hardStop: ReturnType<typeof setTimeout> }
>();

function disarmPostStopGrace(sessionId: string): void {
  const entry = postStopGraceTimers.get(sessionId);
  if (entry) {
    clearInterval(entry.poll);
    clearTimeout(entry.hardStop);
    postStopGraceTimers.delete(sessionId);
  }
}

// 本轮是否产出了真正的最终回答（作用域限定到本轮，避免历史消息误判）。
// 排除：超时/错误/重试等系统提示、tool_result 中间消息。
// 注意：暂停抢救的半截回复（"（已暂停"开头）是有效的正文内容，必须算作
// genuine，否则暂停后结局会误判为 stopped 且流式缓冲可能被清空。
const NON_FINAL_TEXT_RE =
  /本轮没有收到|请求超时|重试也失败|自动重试|正在重建会话|正在重试|上一轮/;
function isGenuineFinalMessage(m: Message, sinceTs: number | null): boolean {
  if (m.role !== 'assistant' || m.localStatus) return false;
  if (sinceTs != null && (m.timestamp ?? 0) < sinceTs - 1000) return false;
  const blocks = m.content ?? [];
  let hasThinking = false;
  for (const b of blocks) {
    if (b.type === 'thinking' && (b.thinking ?? '').trim()) hasThinking = true;
    if (b.type === 'text') {
      const t = (b.text ?? '').trim();
      if (!t) continue;
      if (NON_FINAL_TEXT_RE.test(t)) continue;
      if (t.startsWith('**Error**') || t.startsWith('**提示**')) continue;
      return true;
    }
  }
  return hasThinking;
}

function hasGenuineFinalSince(sessionId: string, sinceTs: number | null): boolean {
  if (sinceTs == null) return false;
  const ss = useAppStore.getState().sessionStates[sessionId];
  return Boolean((ss?.messages ?? []).some((m) => isGenuineFinalMessage(m, sinceTs)));
}

function armPostStopGrace(sessionId: string): void {
  disarmPostStopGrace(sessionId);
  const poll = setInterval(() => {
    const state = useAppStore.getState();
    const session = state.sessions.find((s) => s.id === sessionId);
    // A new turn already started — its lifecycle owns the buffers now.
    if (session?.status === 'running') {
      disarmPostStopGrace(sessionId);
      return;
    }
    const ss = state.sessionStates[sessionId];
    // The persisted capture message landed (addMessage cleared the buffers) —
    // finish the teardown now.
    if (!ss?.partialMessage && !ss?.partialThinking) {
      state.clearActiveTurn(sessionId);
      disarmPostStopGrace(sessionId);
    }
  }, 250);
  const hardStop = setTimeout(() => {
    disarmPostStopGrace(sessionId);
    const state = useAppStore.getState();
    const session = state.sessions.find((s) => s.id === sessionId);
    if (session?.status === 'running') return;
    state.clearPartialMessage(sessionId);
    state.clearPartialThinking(sessionId);
    state.clearActiveTurn(sessionId);
  }, 5000);
  postStopGraceTimers.set(sessionId, { poll, hardStop });
}

export function useIPC() {
  // Handle incoming server events - only setup once across all useIPC() callers.
  // See module-level `ipcListenerInstalled` guard above for the full reason.
  useEffect(() => {
    if (!isElectron) {
      console.log('[useIPC] Not in Electron, skipping IPC setup');
      return;
    }

    if (ipcListenerInstalled) {
      // A previous useIPC() caller already installed the shared listener.
      // Do nothing here — and crucially return no cleanup, so unmounting
      // this component does NOT tear down the shared listener.
      return;
    }
    ipcListenerInstalled = true;

    console.log('[useIPC] Setting up IPC listener (once)');

    // --- RAF batching for high-frequency events ---
    let partialRafId: number | null = null;
    let thinkingRafId: number | null = null;

    const flushPartials = () => {
      partialRafId = null;
      const store = useAppStore.getState();
      for (const sessionId in pendingPartials) {
        const chunks = pendingPartials[sessionId];
        if (chunks.length > 0) {
          store.setPartialMessage(sessionId, chunks.join(''));
          pendingPartials[sessionId] = [];
        }
      }
    };

    const bufferPartial = (sessionId: string, delta: string) => {
      if (!pendingPartials[sessionId]) pendingPartials[sessionId] = [];
      pendingPartials[sessionId].push(delta);
      if (partialRafId === null) {
        partialRafId = requestAnimationFrame(flushPartials);
      }
    };

    const flushThinking = () => {
      thinkingRafId = null;
      const store = useAppStore.getState();
      for (const sessionId in pendingThinking) {
        const chunks = pendingThinking[sessionId];
        if (chunks.length > 0) {
          store.setPartialThinking(sessionId, chunks.join(''));
          pendingThinking[sessionId] = [];
        }
      }
    };

    const bufferThinking = (sessionId: string, delta: string) => {
      if (!pendingThinking[sessionId]) pendingThinking[sessionId] = [];
      pendingThinking[sessionId].push(delta);
      if (thinkingRafId === null) {
        thinkingRafId = requestAnimationFrame(flushThinking);
      }
    };

    type TraceAction =
      | { kind: 'add'; sessionId: string; step: TraceStep }
      | { kind: 'update'; sessionId: string; stepId: string; updates: Partial<TraceStep> };
    let pendingTraces: TraceAction[] = [];
    let traceRafId: number | null = null;

    const flushTraces = () => {
      traceRafId = null;
      const store = useAppStore.getState();
      for (const action of pendingTraces) {
        if (action.kind === 'add') {
          store.addTraceStep(action.sessionId, action.step);
        } else {
          store.updateTraceStep(action.sessionId, action.stepId, action.updates);
        }
      }
      pendingTraces = [];
    };

    const bufferTrace = (action: TraceAction) => {
      pendingTraces.push(action);
      if (traceRafId === null) {
        traceRafId = requestAnimationFrame(flushTraces);
      }
    };

    const applyConfigSnapshot = (config: AppConfig, isConfigured: boolean) => {
      const store = useAppStore.getState();
      const isInitialConfigStatus = !store.hasSeenInitialConfigStatus;
      store.setIsConfigured(isConfigured);
      store.setAppConfig(config);
      store.setSettings({ theme: config.theme || 'light' });
      if (isInitialConfigStatus) {
        store.markInitialConfigStatusSeen();
      }
    };

    const cleanup = window.electronAPI.on((event: ServerEvent) => {
      const store = useAppStore.getState();

      try {
        switch (event.type) {
          case 'session.list':
            store.setSessions(event.payload.sessions);
            break;

          case 'session.status':
            store.updateSession(event.payload.sessionId, {
              status: event.payload.status,
            });
            if (event.payload.status === 'running') {
              // 新一轮开始：结局未知，先清掉上一轮的 completed/stopped，
              // 侧边栏回到运行中（… + 黄），杜绝"还在跑却挂着绿勾"。
              // 同时记录本轮起点，后续"最终回答"判定只看本轮消息。
              // 注意：停止会先发 idle（见 stopSession）再发 running，双事件都会
              // 到；running 最后到即覆盖，保证追问启动时结局恒为 null。
              turnStartedAt[event.payload.sessionId] = Date.now();
              store.setLastTurnOutcome(event.payload.sessionId, null);
              break;
            }
            // 走到这里 status 一定不是 running（上面已 break），直接处理收尾。
            store.finishExecutionClock(event.payload.sessionId);
            store.setLoading(false);
            const sinceTs = turnStartedAt[event.payload.sessionId] ?? null;
            const ss = useAppStore.getState().sessionStates[event.payload.sessionId];
            const hasLivePartial = Boolean(ss?.partialMessage || ss?.partialThinking);
            if (hasLivePartial) {
              // 回复流到一半回合结束（用户停止或网关中断）：不立刻定结局，
              // 等持久化的 stream.message 落定后再判定（见 stream.message）。
              store.clearPendingTurns(event.payload.sessionId);
              store.clearQueuedMessages(event.payload.sessionId);
              armPostStopGrace(event.payload.sessionId);
            } else {
              // 流式缓冲已空：本轮有真正的最终回答 = 正常完成
              // （completed + 绿勾），否则是停止/中止（stopped，不打勾）。
              const completed = hasGenuineFinalSince(event.payload.sessionId, sinceTs);
              store.setLastTurnOutcome(
                event.payload.sessionId,
                completed ? 'completed' : 'stopped'
              );
              store.clearActiveTurn(event.payload.sessionId);
              store.clearPendingTurns(event.payload.sessionId);
              store.clearQueuedMessages(event.payload.sessionId);
              delete pendingPartials[event.payload.sessionId];
              delete pendingThinking[event.payload.sessionId];
            }
            break;

          case 'session.update':
            store.updateSession(event.payload.sessionId, event.payload.updates);
            break;

          case 'stream.message':
            // Clear pending partial buffer to prevent RAF from appending stale chunks
            delete pendingPartials[event.payload.sessionId];
            // Clear thinking buffer too — final thinking is in the message content blocks
            delete pendingThinking[event.payload.sessionId];
            store.addMessage(event.payload.sessionId, event.payload.message);
            // 停止后到达的持久化消息：只有"本轮未输出正文"占位符才定为
            // stopped（不打勾）；抢救下来的半截正文是有效内容，走正常的
            // genuine 判定（半截正文应显示且可继续）。正常流式结束到达的
            // 最终回答则在此处立即定 completed——它往往先于
            // session.status(idle) 到达，提前落定可以让侧边栏绿勾更跟手。
            {
              const msg = event.payload.message;
              if (msg.role === 'assistant' && !msg.localStatus) {
                const sessionId = event.payload.sessionId;
                const session = useAppStore
                  .getState()
                  .sessions.find((s) => s.id === sessionId);
                if (session?.status !== 'running') {
                  const text = (msg.content ?? [])
                    .filter((b) => b.type === 'text')
                    .map((b) => (b as { text?: string }).text ?? '')
                    .join('\n');
                  if (/本轮未输出正文/.test(text)) {
                    store.setLastTurnOutcome(sessionId, 'stopped');
                  } else if (isGenuineFinalMessage(msg, turnStartedAt[sessionId] ?? null)) {
                    store.setLastTurnOutcome(sessionId, 'completed');
                  }
                }
              }
            }
            break;

          case 'stream.partial':
            bufferPartial(event.payload.sessionId, event.payload.delta);
            break;

          case 'stream.thinking':
            bufferThinking(event.payload.sessionId, event.payload.delta);
            break;

          case 'trace.step': {
            if (event.payload.step.type === 'thinking' && event.payload.step.status === 'running') {
              const currentState = useAppStore.getState();
              const ss = currentState.sessionStates[event.payload.sessionId];
              const pending = ss?.pendingTurns || [];
              const activeTurn = ss?.activeTurn;
              if (pending.length > 0) {
                store.activateNextTurn(event.payload.sessionId, event.payload.step.id);
              } else if (activeTurn) {
                // 绑定真实 stepId，避免 mock stepId 导致无法清理
                store.updateActiveTurnStep(event.payload.sessionId, event.payload.step.id);
              }
            }
            bufferTrace({
              kind: 'add',
              sessionId: event.payload.sessionId,
              step: event.payload.step,
            });
            break;
          }

          case 'trace.update':
            if (
              event.payload.updates.status &&
              (event.payload.updates.status === 'completed' ||
                event.payload.updates.status === 'error')
            ) {
              store.clearActiveTurn(event.payload.sessionId, event.payload.stepId);
            }
            bufferTrace({
              kind: 'update',
              sessionId: event.payload.sessionId,
              stepId: event.payload.stepId,
              updates: event.payload.updates,
            });
            break;

          case 'permission.request':
            store.setPendingPermission(event.payload);
            break;

          case 'permission.dismiss': {
            const currentPermission = useAppStore.getState().pendingPermission;
            if (currentPermission?.toolUseId === event.payload.toolUseId) {
              store.setPendingPermission(null);
            }
            break;
          }

          case 'stream.executionTime':
            store.updateMessage(event.payload.sessionId, event.payload.messageId, {
              executionTimeMs: event.payload.executionTimeMs,
            });
            break;

          case 'sudo.password.request':
            store.setPendingSudoPassword(event.payload);
            break;

          case 'sudo.password.dismiss': {
            const currentSudo = useAppStore.getState().pendingSudoPassword;
            if (currentSudo?.toolUseId === event.payload.toolUseId) {
              store.setPendingSudoPassword(null);
            }
            break;
          }

          case 'config.status': {
            console.log('[useIPC] config.status received:', event.payload.isConfigured);
            applyConfigSnapshot(event.payload.config, event.payload.isConfigured);
            break;
          }

          case 'sandbox.progress':
            console.log(
              '[useIPC] sandbox.progress received:',
              event.payload.phase,
              event.payload.message
            );
            store.setSandboxSetupProgress(event.payload);
            break;

          case 'sandbox.sync':
            console.log(
              '[useIPC] sandbox.sync received:',
              event.payload.phase,
              event.payload.message
            );
            store.setSandboxSyncStatus(event.payload);
            break;

          case 'skills.storageChanged':
            console.log(
              '[useIPC] skills.storageChanged received:',
              event.payload.path,
              event.payload.reason
            );
            store.setSkillsStorageChangeEvent(event.payload);
            store.setSkillsStorageChangedAt(Date.now());
            break;

          case 'workdir.changed':
            console.log('[useIPC] workdir.changed received:', event.payload.path);
            store.setWorkingDir(event.payload.path || null);
            break;

          case 'session.contextInfo':
            store.setSessionContextWindow(event.payload.sessionId, event.payload.contextWindow);
            break;

          case 'error':
            console.error('[useIPC] Server error:', event.payload.message);
            store.setLoading(false);
            if (event.payload.code === 'CONFIG_REQUIRED_ACTIVE_SET') {
              store.setGlobalNotice({
                id: `notice-config-required-${Date.now()}`,
                type: 'warning',
                message: i18n.t('api.configRequiredActiveSet'),
                messageKey: 'api.configRequiredActiveSet',
                action:
                  event.payload.action === 'open_api_settings' ? 'open_api_settings' : undefined,
              });
            } else {
              store.setGlobalNotice({
                id: `notice-error-${Date.now()}`,
                type: 'error',
                message: event.payload.message,
              });
            }
            break;

          case 'native-theme.changed':
            store.setSystemDarkMode(event.payload.shouldUseDarkColors);
            break;

          case 'new-session':
            store.setActiveSession(null);
            store.setShowSettings(false);
            break;

          case 'navigate':
            if (event.payload === 'settings') {
              store.setShowSettings(true);
            }
            break;

          default:
            console.log('[useIPC] Unknown server event:', event);
        }
      } catch (err) {
        console.error('[useIPC] Error handling server event:', event.type, err);
      }
    });

    let disposed = false;
    void (async () => {
      try {
        const [config, isConfigured, systemTheme] = await Promise.all([
          window.electronAPI.config.get(),
          window.electronAPI.config.isConfigured(),
          window.electronAPI.getSystemTheme(),
        ]);
        if (disposed) {
          return;
        }
        const store = useAppStore.getState();
        store.setSystemDarkMode(Boolean(systemTheme?.shouldUseDarkColors));
        applyConfigSnapshot(config, Boolean(isConfigured));

        // Hydrate main-process permission rules from the renderer's (possibly
        // persisted) settings so the agent has them before the first tool call.
        // Re-read the store after applyConfigSnapshot so we send the latest
        // persisted rules, not a stale pre-hydration snapshot.
        try {
          const latest = useAppStore.getState();
          window.electronAPI.send({
            type: 'settings.update',
            payload: { permissionRules: latest.settings.permissionRules } as Record<
              string,
              unknown
            >,
          });
        } catch (syncErr) {
          console.warn('[useIPC] Failed to sync permissionRules to main:', syncErr);
        }
      } catch (error) {
        console.error('[useIPC] Failed to bootstrap config/theme state:', error);
      }
    })();

    // Cleanup on unmount only
    return () => {
      disposed = true;
      console.log('[useIPC] Cleaning up IPC listener');
      // Flush any pending RAF batches before cancelling to avoid lost updates
      if (partialRafId !== null) {
        cancelAnimationFrame(partialRafId);
        flushPartials();
      }
      if (thinkingRafId !== null) {
        cancelAnimationFrame(thinkingRafId);
        flushThinking();
      }
      if (traceRafId !== null) {
        cancelAnimationFrame(traceRafId);
        flushTraces();
      }
      cleanup?.();
      // Reset guard so a subsequent mount (e.g., React Strict Mode double-
      // invoke in dev) re-installs the listener instead of silently running
      // with a torn-down bridge.
      ipcListenerInstalled = false;
    };
  }, []); // Empty deps - setup listener only once!

  // Get actions for the rest of the hook
  const addSession = useAppStore((s) => s.addSession);
  const updateSession = useAppStore((s) => s.updateSession);
  const addMessage = useAppStore((s) => s.addMessage);
  const setLoading = useAppStore((s) => s.setLoading);
  const setPendingPermission = useAppStore((s) => s.setPendingPermission);
  const clearActiveTurn = useAppStore((s) => s.clearActiveTurn);
  const activateNextTurn = useAppStore((s) => s.activateNextTurn);
  const clearPendingTurns = useAppStore((s) => s.clearPendingTurns);
  const cancelQueuedMessages = useAppStore((s) => s.cancelQueuedMessages);
  const startExecutionClock = useAppStore((s) => s.startExecutionClock);
  const finishExecutionClock = useAppStore((s) => s.finishExecutionClock);

  // Send event to main process
  const send = useCallback((event: ClientEvent) => {
    if (!isElectron) {
      return;
    }
    window.electronAPI.send(event);
  }, []);

  // Invoke and wait for response
  const invoke = useCallback(async <T>(event: ClientEvent): Promise<T> => {
    if (!isElectron) {
      return null as T;
    }
    return window.electronAPI.invoke<T>(event);
  }, []);

  // Start a new session
  const startSession = useCallback(
    async (title: string, promptOrContent: string | ContentBlock[], cwd?: string) => {
      setLoading(true);
      console.log('[useIPC] Starting session:', title);

      // Normalize input to ContentBlock array
      const content: ContentBlock[] =
        typeof promptOrContent === 'string'
          ? [{ type: 'text', text: promptOrContent }]
          : promptOrContent;

      // Extract text for legacy backend and session title (if needed)
      const textContent = content.find((block) => block.type === 'text');
      const prompt = textContent && 'text' in textContent ? textContent.text : '';

      // Browser mode mock
      if (!isElectron) {
        const sessionId = `mock-session-${Date.now()}`;
        const session: Session = {
          id: sessionId,
          title: title || 'New Session',
          status: 'running',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          cwd: cwd || '',
          mountedPaths: [],
          allowedTools: [
            'webfetch',
            'websearch',
            'read',
            'write',
            'edit',
            'list_directory',
            'glob',
            'grep',
          ],
          memoryEnabled: true,
        };

        addSession(session);
        useAppStore.getState().setActiveSession(sessionId);

        const userMessage: Message = {
          id: nextLocalId('msg-user'),
          sessionId,
          role: 'user',
          content,
          timestamp: Date.now(),
        };
        addMessage(sessionId, userMessage);
        startExecutionClock(sessionId, userMessage.timestamp);
        const mockStepId = `mock-step-${Date.now()}`;
        activateNextTurn(sessionId, mockStepId);

        await new Promise((resolve) => setTimeout(resolve, 500));

        const assistantMessage: Message = {
          id: `msg-assistant-${Date.now()}`,
          sessionId,
          role: 'assistant',
          content: [{ type: 'text', text: `Mock response to: "${prompt}"` }],
          timestamp: Date.now(),
        };
        addMessage(sessionId, assistantMessage);

        updateSession(sessionId, { status: 'idle' });
        clearActiveTurn(sessionId, mockStepId);
        setLoading(false);

        return session;
      }

      // Electron mode
      try {
        const session = await invoke<Session>({
          type: 'session.start',
          payload: {
            title,
            prompt,
            cwd,
            content, // Send full content blocks including images
          },
        });
        if (session) {
          addSession(session);
          useAppStore.getState().setActiveSession(session.id);

          // Immediately add user message to UI
          const userMessage: Message = {
            id: nextLocalId('msg-user'),
            sessionId: session.id,
            role: 'user',
            content,
            timestamp: Date.now(),
          };
          addMessage(session.id, userMessage);
          startExecutionClock(session.id, userMessage.timestamp);

          // Immediately activate turn to show processing indicator while waiting for API
          const mockStepId = `pending-step-${Date.now()}`;
          activateNextTurn(session.id, mockStepId);
        }
        // Loading will be reset when we receive session.status event
        return session;
      } catch (e) {
        setLoading(false);
        useAppStore.getState().setGlobalNotice({
          id: `notice-session-start-${Date.now()}`,
          type: 'error',
          message: e instanceof Error ? e.message : i18n.t('chat.startFailed'),
          messageKey: e instanceof Error ? undefined : 'chat.startFailed',
        });
        return null;
      }
    },
    [
      invoke,
      addSession,
      addMessage,
      updateSession,
      setLoading,
      activateNextTurn,
      clearActiveTurn,
      startExecutionClock,
    ]
  );

  // Continue an existing session
  const continueSession = useCallback(
    async (
      sessionId: string,
      promptOrContent: string | ContentBlock[],
      options?: { silentUserMessage?: boolean }
    ) => {
      setLoading(true);
      console.log('[useIPC] Continuing session:', sessionId);

      // Normalize input to ContentBlock array
      const content: ContentBlock[] =
        typeof promptOrContent === 'string'
          ? [{ type: 'text', text: promptOrContent }]
          : promptOrContent;

      // Extract text for legacy backend (if needed)
      const textContent = content.find((block) => block.type === 'text');
      const prompt = textContent && 'text' in textContent ? textContent.text : '';

      // Immediately add user message to UI (for both modes), unless the
      // caller asked for a silent resume (e.g. pause-continue): no user
      // bubble, the model just keeps generating.
      const store = useAppStore.getState();
      const isSessionRunning =
        store.sessions.find((session) => session.id === sessionId)?.status === 'running';
      const ss = store.sessionStates[sessionId];
      const hasActiveTurn = Boolean(ss?.activeTurn);
      const hasPending = (ss?.pendingTurns?.length ?? 0) > 0;
      const shouldQueue = isSessionRunning || hasActiveTurn || hasPending;
      const silent = options?.silentUserMessage === true && !shouldQueue;
      if (!silent) {
        const userMessage: Message = {
          id: nextLocalId('msg-user'),
          sessionId,
          role: 'user',
          content,
          timestamp: Date.now(),
          localStatus: shouldQueue ? 'queued' : undefined,
        };
        addMessage(sessionId, userMessage);
        startExecutionClock(sessionId, userMessage.timestamp);
      } else {
        startExecutionClock(sessionId, Date.now());
      }

      // Browser mode mock
      if (!isElectron) {
        updateSession(sessionId, { status: 'running' });
        const mockStepId = `mock-step-${Date.now()}`;
        activateNextTurn(sessionId, mockStepId);

        await new Promise((resolve) => setTimeout(resolve, 500));

        const assistantMessage: Message = {
          id: `msg-assistant-${Date.now()}`,
          sessionId,
          role: 'assistant',
          content: [{ type: 'text', text: `Mock response to: "${prompt}"` }],
          timestamp: Date.now(),
        };
        addMessage(sessionId, assistantMessage);

        updateSession(sessionId, { status: 'idle' });
        clearActiveTurn(sessionId, mockStepId);
        clearPendingTurns(sessionId);
        setLoading(false);
        return;
      }

      // Clear stale streaming buffers from previous aborted turns, and cancel
      // any pending post-stop grace from a previous stop.
      disarmPostStopGrace(sessionId);
      delete pendingPartials[sessionId];
      delete pendingThinking[sessionId];
      useAppStore.getState().clearPartialMessage(sessionId);
      useAppStore.getState().clearPartialThinking(sessionId);

      // Electron mode - send to backend (user message already added above)
      // Immediately activate turn to show processing indicator while waiting for API
      if (!shouldQueue) {
        const mockStepId = `pending-step-${Date.now()}`;
        activateNextTurn(sessionId, mockStepId);
      }

      try {
        send(
          silent
            ? { type: 'session.resume', payload: { sessionId } }
            : {
                type: 'session.continue',
                payload: {
                  sessionId,
                  prompt,
                  content, // Send full content blocks including images
                },
              }
        );
        // Loading will be reset when we receive session.status event
      } catch (e) {
        setLoading(false);
        useAppStore.getState().setGlobalNotice({
          id: `notice-session-continue-${Date.now()}`,
          type: 'error',
          message: e instanceof Error ? e.message : i18n.t('chat.startFailed'),
          messageKey: e instanceof Error ? undefined : 'chat.startFailed',
        });
      }
    },
    [
      send,
      addMessage,
      updateSession,
      setLoading,
      activateNextTurn,
      clearActiveTurn,
      clearPendingTurns,
      startExecutionClock,
    ]
  );

  const stopSession = useCallback(
    (sessionId: string) => {
      cancelQueuedMessages(sessionId);
      clearPendingTurns(sessionId);
      finishExecutionClock(sessionId);
      // Keep the active turn and the live partial buffers visible. The main
      // process persists the partially-streamed reply and re-emits it as
      // stream.message; wiping here would blank the visible reply instantly
      // (the reported "disappears on pause" bug). The grace poll armed via
      // the session.status(idle) event finishes the teardown once the
      // persisted message lands.
      if (!isElectron) {
        clearActiveTurn(sessionId);
        delete pendingPartials[sessionId];
        delete pendingThinking[sessionId];
        useAppStore.getState().clearPartialMessage(sessionId);
        useAppStore.getState().clearPartialThinking(sessionId);
        updateSession(sessionId, { status: 'idle' });
        setLoading(false);
        return;
      }
      send({ type: 'session.stop', payload: { sessionId } });
      setLoading(false);
    },
    [
      send,
      updateSession,
      setLoading,
      cancelQueuedMessages,
      clearPendingTurns,
      clearActiveTurn,
      finishExecutionClock,
    ]
  );

  const deleteSession = useCallback(
    (sessionId: string) => {
      useAppStore.getState().removeSession(sessionId);
      if (isElectron) {
        send({ type: 'session.delete', payload: { sessionId } });
      }
    },
    [send]
  );

  const batchDeleteSessions = useCallback(
    (sessionIds: string[]) => {
      useAppStore.getState().removeSessions(sessionIds);
      if (isElectron) {
        send({ type: 'session.batchDelete', payload: { sessionIds } });
      }
    },
    [send]
  );

  const listSessions = useCallback(() => {
    if (!isElectron) return;
    send({ type: 'session.list', payload: {} });
  }, [send]);

  // Get messages for a session (from persistent storage)
  const getSessionMessages = useCallback(
    async (sessionId: string): Promise<Message[]> => {
      if (!isElectron) {
        console.log('[useIPC] Browser mode - no persistent messages');
        return [];
      }
      console.log('[useIPC] Getting messages for session:', sessionId);
      const messages = await invoke<Message[]>({
        type: 'session.getMessages',
        payload: { sessionId },
      });
      return messages || [];
    },
    [invoke]
  );

  const getSessionMessagesPaginated = useCallback(
    async (
      sessionId: string,
      limit: number,
      offset: number
    ): Promise<{ messages: Message[]; total: number; hasMore: boolean }> => {
      if (!isElectron) {
        return { messages: [], total: 0, hasMore: false };
      }
      // Handler returns JSON string to bypass Electron's structured clone overhead
      const jsonStr = await invoke<string>({
        type: 'session.getMessagesPaginated',
        payload: { sessionId, limit, offset },
      });
      return JSON.parse(jsonStr);
    },
    [invoke]
  );

  const getSessionTraceSteps = useCallback(
    async (sessionId: string): Promise<TraceStep[]> => {
      if (!isElectron) {
        console.log('[useIPC] Browser mode - no persistent trace steps');
        return [];
      }
      return (
        (await invoke<TraceStep[]>({ type: 'session.getTraceSteps', payload: { sessionId } })) || []
      );
    },
    [invoke]
  );

  const respondToPermission = useCallback(
    (toolUseId: string, result: PermissionResult, allowAll?: boolean) => {
      send({
        type: 'permission.response',
        payload: { toolUseId, result, allowAll },
      });
      setPendingPermission(null);
    },
    [send, setPendingPermission]
  );

  const setPendingSudoPassword = useAppStore((s) => s.setPendingSudoPassword);

  const respondToSudoPassword = useCallback(
    (toolUseId: string, password: string | null) => {
      send({
        type: 'sudo.password.response',
        payload: { toolUseId, password },
      });
      setPendingSudoPassword(null);
    },
    [send, setPendingSudoPassword]
  );

  const selectFolder = useCallback(async (): Promise<string | null> => {
    if (!isElectron) {
      return '/mock/folder/path';
    }
    return invoke<string | null>({ type: 'folder.select', payload: {} });
  }, [invoke]);

  const getWorkingDir = useCallback(async (): Promise<string | null> => {
    if (!isElectron) {
      return '/mock/working/dir';
    }
    return invoke<string | null>({ type: 'workdir.get', payload: {} });
  }, [invoke]);

  const changeWorkingDir = useCallback(
    async (
      sessionId?: string,
      currentPath?: string
    ): Promise<{ success: boolean; path: string; error?: string }> => {
      if (!isElectron) {
        return { success: true, path: '/mock/working/dir' };
      }
      const result = await invoke<{ success: boolean; path: string; error?: string }>({
        type: 'workdir.select',
        payload: { sessionId, currentPath },
      });
      if (result.success) {
        useAppStore.getState().setWorkingDir(result.path);
      }
      return result;
    },
    [invoke]
  );

  const getMCPServers = useCallback(async () => {
    if (!isElectron) {
      return [];
    }
    // Use the exposed mcp.getServerStatus method
    return window.electronAPI.mcp.getServerStatus();
  }, []);

  return {
    send,
    invoke,
    startSession,
    continueSession,
    stopSession,
    deleteSession,
    batchDeleteSessions,
    listSessions,
    getSessionMessages,
    getSessionMessagesPaginated,
    getSessionTraceSteps,
    respondToPermission,
    respondToSudoPassword,
    selectFolder,
    getWorkingDir,
    changeWorkingDir,
    getMCPServers,
    isElectron,
  };
}
