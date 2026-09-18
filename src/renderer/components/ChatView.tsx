import { useState, useRef, useEffect, useMemo, useCallback, useLayoutEffect } from 'react';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { useTranslation } from 'react-i18next';
import {
  useActiveSessionId,
  useCurrentSession,
  useActiveSessionMessages,
  useActivePartialContent,
  useActiveTurn,
  usePendingTurns,
  useActiveExecutionClock,
  useActiveLastTurnOutcome,
  useAppConfig,
  useActiveHasMoreMessages,
  useLoadingSessionId,
} from '../store/selectors';
import { useAppStore } from '../store';
import { useIPC } from '../hooks/useIPC';
import { MessageCard } from './MessageCard';
import { ProcessPanel } from './message/ProcessPanel';
import { ContentBlockView } from './message/ContentBlockView';
import { buildRoundRenderPlans } from '../utils/round-render-plan';
import type { Message, ContentBlock } from '../types';
import {
  Send,
  Square,
  Plus,
  Loader2,
  Plug,
  Play,
  X,
  Clock,
  ChevronDown,
  ChevronRight,
  Check,
  Cpu,
} from 'lucide-react';

type AttachedFile = {
  name: string;
  path: string;
  size: number;
  type: string;
  inlineDataBase64?: string;
};

// Audio/video extensions the asr-transcribe skill accepts. Attaching any of
// these signals a likely heavy local transcription; low-memory machines are
// the most common trigger of the blank-window (renderer OOM) issue.
const ASR_AUDIO_EXTENSIONS = new Set([
  'm4a',
  'mp3',
  'wav',
  'aac',
  'flac',
  'ogg',
  'mp4',
  'mov',
  'wma',
  'amr',
]);

function isAudioAttachment(file: { name: string; type?: string }): boolean {
  const ext = file.name.toLowerCase().split('.').pop() || '';
  if (ASR_AUDIO_EXTENSIONS.has(ext)) {
    return true;
  }
  return /^audio\//i.test(file.type || '');
}

// Model quick-switch entries shown in the chat input dropdown.
// Populated from the configured config sets (see useAppConfig configSets).
type QuickSwitchModel = { id: string; label: string };

export function ChatView() {
  const { t } = useTranslation();
  // Scoped selectors — each subscription only re-renders when its slice changes
  const activeSessionId = useActiveSessionId();
  const activeSession = useCurrentSession();
  const messages = useActiveSessionMessages();
  const { partialMessage, partialThinking } = useActivePartialContent();
  const hasMoreMessages = useActiveHasMoreMessages();
  const activeTurn = useActiveTurn();
  const pendingTurns = usePendingTurns();
  const executionClock = useActiveExecutionClock();
  const appConfig = useAppConfig();
  const loadingSessionId = useLoadingSessionId();
  const setGlobalNotice = useAppStore((s) => s.setGlobalNotice);
  const { continueSession, stopSession, getSessionMessagesPaginated, isElectron } = useIPC();
  const prependMessages = useAppStore((s) => s.prependMessages);

  // Model quick-switch entries populated from the configured config sets.
  // Each config set is a fully configured model profile (provider, key, url...).
  const quickSwitchModels = useMemo<QuickSwitchModel[]>(() => {
    const sets = appConfig?.configSets ?? [];
    const list: QuickSwitchModel[] = sets.map((set) => {
      const activeProfile = set.profiles[set.activeProfileKey];
      const modelLabel =
        activeProfile?.model ||
        set.profiles.anthropic?.model ||
        set.profiles.openai?.model ||
        set.profiles.gemini?.model ||
        '';
      const schemeName = set.name.trim() || t('chat.noConfigSet');
      const resolvedModel = modelLabel || t('chat.noModel');
      return {
        id: set.id,
        label: `${schemeName}：${resolvedModel}`,
      };
    });
    return list;
  }, [appConfig?.configSets, t]);

  const activeConfigSetId = appConfig?.activeConfigSetId;
  const [prompt, setPrompt] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inputHeight, setInputHeight] = useState(56);
  const [activeConnectors, setActiveConnectors] = useState<
    { id: string; name: string; connected: boolean; toolCount: number }[]
  >([]);
  const [showConnectorLabel, setShowConnectorLabel] = useState(true);
  const headerRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const connectorMeasureRef = useRef<HTMLDivElement>(null);
  const [pastedImages, setPastedImages] = useState<
    Array<{ url: string; base64: string; mediaType: string }>
  >([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const inputBoxMaxWidth = 1320;
  const {
    size: inputBoxSize,
    setSize: setInputBoxSize,
    startResize,
  } = useResizablePanel({
    defaultWidth: 920,
    defaultHeight: 180,
    minWidth: 640,
    minHeight: 150,
    maxWidth: inputBoxMaxWidth,
    maxHeight: 360,
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isUserAtBottomRef = useRef(true);
  const isComposingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevMessageCountRef = useRef(0);
  const prevPartialLengthRef = useRef(0);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRequestRef = useRef<number | null>(null);
  const isScrollingRef = useRef(false);
  /** Warn about low memory for ASR only once per mount to avoid nagging. */
  const lowMemoryWarnedRef = useRef(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const prevActiveSessionIdRef = useRef<string | null>(null);
  // While a freshly opened session is being settled at the bottom, scroll
  // events come from our own code — not the user — so they must not feed
  // isUserAtBottomRef or trigger pagination.
  const suppressScrollStateRef = useRef(false);
  const suppressScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasActiveTurn = Boolean(activeTurn);
  const pendingCount = pendingTurns.length;
  const isSessionRunning = activeSession?.status === 'running';
  const canStop = isSessionRunning || hasActiveTurn || pendingCount > 0;
  const lastTurnOutcome = useActiveLastTurnOutcome();
  // 暂停后且有本轮内容可续写时，显示"继续"按钮。paused 状态在用户点击
  // 继续或发起新提问时自然结束（新一轮 running 会清掉 outcome）。
  const canResume =
    !canStop &&
    lastTurnOutcome !== null &&
    messages.length > 0 &&
    messages[messages.length - 1]?.role === 'assistant';

  const loadMoreMessages = useCallback(async () => {
    if (!activeSessionId || loadingMoreRef.current || !hasMoreMessages || !isElectron) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const result = await getSessionMessagesPaginated(activeSessionId, 50, messages.length);
      if (result.messages.length > 0) {
        const container = scrollContainerRef.current;
        const prevHeight = container?.scrollHeight ?? 0;
        prependMessages(activeSessionId, result.messages, result.hasMore);
        // Restore scroll position so user doesn't jump to bottom after prepend
        requestAnimationFrame(() => {
          if (container) {
            const newHeight = container.scrollHeight;
            container.scrollTop += newHeight - prevHeight;
          }
        });
      } else {
        prependMessages(activeSessionId, [], false);
      }
    } catch (e) {
      console.error('[ChatView] loadMoreMessages failed:', e);
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [
    activeSessionId,
    hasMoreMessages,
    isElectron,
    messages.length,
    getSessionMessagesPaginated,
    prependMessages,
  ]);

  // Stable ref for loadMoreMessages so the scroll effect doesn't re-run every
  // time messages.length changes (which recreates loadMoreMessages).
  const loadMoreMessagesRef = useRef(loadMoreMessages);
  loadMoreMessagesRef.current = loadMoreMessages;

  useEffect(() => {
    // When switching sessions, restore the input capsule to its widest
    // comfortable size so the composer looks balanced by default.
    setInputBoxSize((prev) => ({
      ...prev,
      width: inputBoxMaxWidth,
    }));
  }, [activeSessionId, setInputBoxSize]);

  const displayedMessages = useMemo(() => {
    if (!activeSessionId) return messages;
    // Show streaming message if we have partial text OR partial thinking
    const hasStreamingContent = partialMessage || partialThinking;
    if (!hasStreamingContent || !activeTurn?.userMessageId) return messages;
    const anchorIndex = messages.findIndex((message) => message.id === activeTurn.userMessageId);
    if (anchorIndex === -1) return messages;

    let insertIndex = anchorIndex + 1;
    while (insertIndex < messages.length) {
      if (messages[insertIndex].role === 'user') break;
      insertIndex += 1;
    }

    const contentBlocks: ContentBlock[] = [];
    if (partialThinking) {
      contentBlocks.push({ type: 'thinking', thinking: partialThinking });
    }
    if (partialMessage) {
      contentBlocks.push({ type: 'text', text: partialMessage });
    }

    const streamingMessage: Message = {
      id: `partial-${activeSessionId}`,
      sessionId: activeSessionId,
      role: 'assistant',
      content: contentBlocks,
      timestamp: Date.now(),
    };

    return [...messages.slice(0, insertIndex), streamingMessage, ...messages.slice(insertIndex)];
  }, [activeSessionId, activeTurn?.userMessageId, messages, partialMessage, partialThinking]);

  // Memoized render plans: unchanged rounds keep identical plan/block array
  // references across streaming frames, so memoized children (ProcessPanel,
  // ContentBlockView, ...) skip re-rendering entirely. See round-render-plan.ts.
  const roundPlans = useMemo(() => buildRoundRenderPlans(displayedMessages), [displayedMessages]);

  // Format execution time for display
  const formatExecutionTime = useCallback((ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(0);
    return `${minutes}m ${seconds}s`;
  }, []);

  // --- Real-time execution timer ---
  const [clockNow, setClockNow] = useState(() => Date.now());

  useEffect(() => {
    const isActive = Boolean(executionClock?.startAt && executionClock.endAt === null);
    if (!isActive) {
      return;
    }
    setClockNow(Date.now());
    const interval = setInterval(() => {
      setClockNow(Date.now());
    }, 100);
    return () => clearInterval(interval);
  }, [executionClock?.startAt, executionClock?.endAt]);

  const liveElapsed =
    executionClock?.startAt == null
      ? 0
      : Math.max(0, (executionClock.endAt ?? clockNow) - executionClock.startAt);
  const timerActive = Boolean(executionClock?.startAt && executionClock.endAt === null);

  // Debounced scroll function to prevent scroll conflicts
  const scrollToBottom = useRef((behavior: ScrollBehavior = 'auto', immediate: boolean = false) => {
    // Cancel any pending scroll requests
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    if (scrollRequestRef.current) {
      cancelAnimationFrame(scrollRequestRef.current);
      scrollRequestRef.current = null;
    }

    const performScroll = () => {
      if (!isUserAtBottomRef.current) return;

      // Mark as scrolling to prevent concurrent scrolls
      isScrollingRef.current = true;

      messagesEndRef.current?.scrollIntoView({ behavior });

      // Reset scrolling flag after a short delay
      setTimeout(
        () => {
          isScrollingRef.current = false;
        },
        behavior === 'smooth' ? 300 : 50
      );
    };

    if (immediate) {
      performScroll();
    } else {
      // Use RAF + timeout for debouncing
      scrollRequestRef.current = requestAnimationFrame(() => {
        scrollTimeoutRef.current = setTimeout(performScroll, 16); // ~1 frame delay
      });
    }
  }).current;

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // The listener MUST be attached on every run, including the run triggered
    // by a session switch. An earlier fix returned early here to avoid a
    // duplicate page-0 load; because the deps below only change when
    // hasMoreMessages flips, a session whose hasMoreMessages stays at its
    // default `true` (i.e. any history longer than one page) never re-ran this
    // effect and therefore never got a scroll listener — scrolling to the top
    // loaded nothing and long conversations stayed truncated.
    const sessionJustChanged = prevActiveSessionIdRef.current !== activeSessionId;
    prevActiveSessionIdRef.current = activeSessionId;

    const updateScrollState = () => {
      // Ignore scroll events produced by our own programmatic scrolling: during
      // the layout pass after a switch distanceToBottom is still huge, and
      // recording that pinned isUserAtBottomRef=false, leaving the newly opened
      // conversation stuck at the top.
      if (suppressScrollStateRef.current || isScrollingRef.current) return;
      const distanceToBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      isUserAtBottomRef.current = distanceToBottom <= 80;
      // Load more messages when scrolling near the top (within 200px)
      if (container.scrollTop <= 200 && hasMoreMessages) {
        loadMoreMessagesRef.current();
      }
    };

    // Skip only the *initial* check right after a switch: the container sits at
    // scrollTop 0 while hasMoreMessages still holds the previous session's
    // value, which would fire a duplicate page-0 load on top of the one
    // handleSessionClick already issued.
    if (!sessionJustChanged) updateScrollState();

    // 用户阅读旧消息时，阻止新消息自动滚动打断视线
    const onScroll = () => updateScrollState();
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
    // hasMoreMessages in deps so re-binding picks up when loadMore becomes a
    // no-op. loadMoreMessages itself is accessed through the stable ref above
    // so we don't need to re-bind the scroll listener when it's recreated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, hasMoreMessages]);

  useEffect(() => {
    const messageCount = messages.length;
    const partialLength = partialMessage.length + partialThinking.length;
    const hasNewMessage = messageCount !== prevMessageCountRef.current;
    const isStreamingTick = partialLength !== prevPartialLengthRef.current && !hasNewMessage;

    // Skip scroll if already scrolling (prevent conflicts)
    if (isScrollingRef.current) {
      prevMessageCountRef.current = messageCount;
      prevPartialLengthRef.current = partialLength;
      return;
    }

    if (isUserAtBottomRef.current) {
      if (!isStreamingTick) {
        // New message - use smooth scroll but with debounce
        const behavior: ScrollBehavior = hasNewMessage ? 'smooth' : 'auto';
        scrollToBottom(behavior, false);
      } else {
        // Streaming tick - use instant scroll with debounce
        scrollToBottom('auto', false);
      }
    }

    prevMessageCountRef.current = messageCount;
    prevPartialLengthRef.current = partialLength;
  }, [messages.length, partialMessage.length, partialThinking.length]);

  // Instant scroll to bottom when switching sessions
  useEffect(() => {
    if (!activeSessionId) return;
    // Force scroll to bottom immediately (no animation)
    isUserAtBottomRef.current = true;
    suppressScrollStateRef.current = true;
    if (suppressScrollTimerRef.current) clearTimeout(suppressScrollTimerRef.current);
    // Safety net: an empty session never delivers messages, so nothing would
    // release the suppression below — always fall back to a timeout.
    suppressScrollTimerRef.current = setTimeout(() => {
      suppressScrollStateRef.current = false;
      suppressScrollTimerRef.current = null;
    }, 1500);
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [activeSessionId]);

  // The switch above runs while the list is still empty (the first page is in
  // flight), so settle at the bottom once again after it has painted, then hand
  // control back to the scroll listener.
  useEffect(() => {
    if (!activeSessionId || messages.length === 0) return;
    if (!suppressScrollStateRef.current) return;
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        const container = scrollContainerRef.current;
        if (container) {
          isUserAtBottomRef.current = true;
          container.scrollTop = container.scrollHeight;
        }
        suppressScrollStateRef.current = false;
        if (suppressScrollTimerRef.current) {
          clearTimeout(suppressScrollTimerRef.current);
          suppressScrollTimerRef.current = null;
        }
      });
    });
    return () => {
      cancelAnimationFrame(outerRaf);
      if (innerRaf) cancelAnimationFrame(innerRaf);
    };
  }, [activeSessionId, messages.length]);

  // Additional scroll trigger for content height changes (e.g., TodoWrite expand/collapse)
  useEffect(() => {
    const container = scrollContainerRef.current;
    const messagesContainer = messagesContainerRef.current;
    if (!container || !messagesContainer) return;

    const resizeObserver = new ResizeObserver(() => {
      // Don't interfere with ongoing scrolls
      if (!isScrollingRef.current && isUserAtBottomRef.current) {
        // Scroll to bottom when content height changes
        scrollToBottom('auto', false);
      }
    });

    resizeObserver.observe(messagesContainer);

    return () => {
      resizeObserver.disconnect();
    };
  }, []); // ResizeObserver is stable — no need to recreate on message count changes

  // Cleanup scroll timeouts on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      if (scrollRequestRef.current) {
        cancelAnimationFrame(scrollRequestRef.current);
      }
      if (suppressScrollTimerRef.current) {
        clearTimeout(suppressScrollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [activeSessionId]);

  useEffect(() => {
    setPrompt('');
    setPastedImages((prev) => {
      for (const image of prev) {
        URL.revokeObjectURL(image.url);
      }
      return [];
    });
    setAttachedFiles([]);
    setInputHeight(56);
    if (textareaRef.current) {
      textareaRef.current.value = '';
      textareaRef.current.style.height = 'auto';
    }
  }, [activeSessionId]);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.style.height = 'auto';
    const nextHeight = Math.min(Math.max(el.scrollHeight, 24), 180);
    el.style.height = `${nextHeight}px`;
    setInputHeight(nextHeight + 24);
  }, [prompt, activeSessionId]);

  // Warm up experience-memory retrieval while the user types so the deferred
  // mid-turn injection is usually a cache hit when the message is sent.
  const memoryPrefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastPrefetchedDraftRef = useRef('');

  const handlePromptChange = useCallback(
    (value: string) => {
      setPrompt(value);
      if (typeof window === 'undefined' || !window.electronAPI || !activeSessionId) return;
      if (memoryPrefetchTimerRef.current) clearTimeout(memoryPrefetchTimerRef.current);
      const draft = value.trim();
      if (draft.length < 8 || draft === lastPrefetchedDraftRef.current) return;
      memoryPrefetchTimerRef.current = setTimeout(() => {
        memoryPrefetchTimerRef.current = null;
        lastPrefetchedDraftRef.current = draft;
        window.electronAPI?.send({
          type: 'memory.prefetch',
          payload: { sessionId: activeSessionId, draft },
        });
      }, 600);
    },
    [activeSessionId]
  );

  useEffect(() => {
    return () => {
      if (memoryPrefetchTimerRef.current) clearTimeout(memoryPrefetchTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (inputHeight < 56) {
      setInputHeight(56);
    }
  }, [inputHeight]);

  // Handle paste event for images
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter((item) => item.type.startsWith('image/'));
    if (imageItems.length === 0) return;

    e.preventDefault();

    const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

    for (const item of imageItems) {
      const blob = item.getAsFile();
      if (!blob) continue;

      try {
        // Resize if needed to stay under API limit
        const resizedBlob = await resizeImageIfNeeded(blob);
        const base64 = await blobToBase64(resizedBlob);
        const url = URL.createObjectURL(resizedBlob);
        newImages.push({
          url,
          base64,
          mediaType: resizedBlob.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        });
      } catch (err) {
        // Notify the user instead of silently dropping the error
        setGlobalNotice({
          id: `image-paste-failed-${Date.now()}`,
          type: 'warning',
          message: t('chat.imageProcessFailed'),
        });
      }
    }

    setPastedImages((prev) => [...prev, ...newImages]);
  };

  const blobToBase64 = (blob: Blob): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('FileReader result is not a string'));
          return;
        }
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const parts = result.split(',');
        resolve(parts[1] || '');
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  // Resize and compress image if needed to stay under 5MB base64 limit
  const resizeImageIfNeeded = async (blob: Blob): Promise<Blob> => {
    // Claude API limit is 5MB for base64 encoded images
    // Base64 encoding increases size by ~33%, so we target 3.75MB for the blob
    const MAX_BLOB_SIZE = 3.75 * 1024 * 1024; // 3.75MB

    if (blob.size <= MAX_BLOB_SIZE) {
      return blob; // No need to resize
    }

    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);

      img.onload = () => {
        URL.revokeObjectURL(url);

        // Calculate scaling factor to reduce file size
        // We use a more aggressive approach: scale down until size is acceptable
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }

        // Start with a scale factor based on size ratio
        const scale = Math.sqrt(MAX_BLOB_SIZE / blob.size);
        const quality = 0.9;

        const attemptCompress = (currentScale: number, currentQuality: number): Promise<Blob> => {
          canvas.width = Math.floor(img.width * currentScale);
          canvas.height = Math.floor(img.height * currentScale);

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          return new Promise((resolveBlob) => {
            canvas.toBlob(
              (compressedBlob) => {
                if (!compressedBlob) {
                  reject(new Error('Failed to compress image'));
                  return;
                }

                // If still too large, try again with lower quality or scale
                if (
                  compressedBlob.size > MAX_BLOB_SIZE &&
                  (currentQuality > 0.5 || currentScale > 0.3)
                ) {
                  const newQuality = Math.max(0.5, currentQuality - 0.1);
                  const newScale = currentQuality <= 0.5 ? currentScale * 0.9 : currentScale;
                  attemptCompress(newScale, newQuality).then(resolveBlob);
                } else {
                  resolveBlob(compressedBlob);
                }
              },
              blob.type || 'image/jpeg',
              currentQuality
            );
          });
        };

        attemptCompress(scale, quality).then(resolve).catch(reject);
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };

      img.src = url;
    });
  };

  const removeImage = (index: number) => {
    setPastedImages((prev) => {
      const updated = [...prev];
      URL.revokeObjectURL(updated[index].url);
      updated.splice(index, 1);
      return updated;
    });
  };

  const removeFile = (index: number) => {
    setAttachedFiles((prev) => {
      const updated = [...prev];
      updated.splice(index, 1);
      return updated;
    });
  };

  const handleFileSelect = async () => {
    if (!isElectron || !window.electronAPI) {
      console.log('[ChatView] Not in Electron, file selection not available');
      return;
    }

    try {
      const filePaths = await window.electronAPI.selectFiles();
      if (filePaths.length === 0) return;

      // Get file info for each selected file
      const newFiles = filePaths.map((filePath) => {
        const fileName = filePath.split(/[/\\]/).pop() || 'unknown';
        return {
          name: fileName,
          path: filePath,
          size: 0, // Will be set by backend when copying
          type: 'application/octet-stream',
        };
      });

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    } catch (error) {
      console.error('[ChatView] Error selecting files:', error);
    }
  };

  // Handle drag and drop for images
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter((file) => file.type.startsWith('image/'));
    const otherFiles = files.filter((file) => !file.type.startsWith('image/'));

    // Process images
    if (imageFiles.length > 0) {
      const newImages: Array<{ url: string; base64: string; mediaType: string }> = [];

      for (const file of imageFiles) {
        try {
          // Resize if needed to stay under API limit
          const resizedBlob = await resizeImageIfNeeded(file);
          const base64 = await blobToBase64(resizedBlob);
          const url = URL.createObjectURL(resizedBlob);
          newImages.push({
            url,
            base64,
            mediaType: resizedBlob.type,
          });
        } catch (err) {
          // Notify the user instead of silently dropping the error
          setGlobalNotice({
            id: `image-drop-failed-${Date.now()}`,
            type: 'warning',
            message: t('chat.imageProcessFailed'),
          });
        }
      }

      setPastedImages((prev) => [...prev, ...newImages]);
    }

    // Process other files
    if (otherFiles.length > 0) {
      const newFiles = await Promise.all(
        otherFiles.map(async (file) => {
          const droppedPath = 'path' in file && typeof file.path === 'string' ? file.path : '';
          const inlineDataBase64 = droppedPath ? undefined : await blobToBase64(file);

          return {
            name: file.name,
            path: droppedPath,
            size: file.size,
            type: file.type || 'application/octet-stream',
            inlineDataBase64,
          };
        })
      );

      setAttachedFiles((prev) => [...prev, ...newFiles]);
    }
  };

  // Close the model dropdown when clicking outside or pressing Escape
  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }
    const handlePointerDown = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModelMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [modelMenuOpen]);

  // Switch to a different config set (model profile) by calling the
  // config.switchSet IPC handler, which persists the active set id.
  const handleModelSwitch = useCallback(
    async (setId: string) => {
      if (isElectron && typeof window !== 'undefined' && window.electronAPI) {
        try {
          const { config } = await window.electronAPI.config.switchSet({ id: setId });
          useAppStore.getState().setAppConfig(config);
          useAppStore.getState().setIsConfigured(Boolean(config.isConfigured));
        } catch (err) {
          console.error('Failed to switch model:', err);
          useAppStore.getState().setGlobalNotice({
            id: `notice-model-switch-${Date.now()}`,
            type: 'error',
            message: err instanceof Error ? err.message : '切换模型失败，请稍后重试',
          });
        }
      }
      setModelMenuOpen(false);
    },
    [isElectron]
  );

  // Load active MCP connectors
  useEffect(() => {
    if (isElectron && typeof window !== 'undefined' && window.electronAPI) {
      const loadConnectors = async () => {
        try {
          const statuses = await window.electronAPI.mcp.getServerStatus();
          const active =
            (
              statuses as Array<{ id: string; name: string; connected: boolean; toolCount: number }>
            )?.filter((s) => s.connected && s.toolCount > 0) || [];
          // Only touch state when the connector set actually changed — a new
          // array every tick re-rendered the whole chat view for nothing.
          setActiveConnectors((prev) =>
            JSON.stringify(prev) === JSON.stringify(active) ? prev : active
          );
        } catch (err) {
          console.error('Failed to load MCP connectors:', err);
        }
      };
      loadConnectors();
      // Connector status changes rarely; 15s keeps the header fresh without
      // a constant IPC + render heartbeat on the chat view.
      const interval = setInterval(loadConnectors, 15000);
      return () => clearInterval(interval);
    }
  }, [isElectron]);

  useEffect(() => {
    const titleEl = titleRef.current;
    const headerEl = headerRef.current;
    const measureEl = connectorMeasureRef.current;
    if (!titleEl || !headerEl || !measureEl) {
      setShowConnectorLabel(true);
      return;
    }
    const updateLabelVisibility = () => {
      const isTruncated = titleEl.scrollWidth > titleEl.clientWidth;
      const headerStyle = window.getComputedStyle(headerEl);
      const paddingLeft = Number.parseFloat(headerStyle.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(headerStyle.paddingRight) || 0;
      const contentWidth = headerEl.clientWidth - paddingLeft - paddingRight;
      const titleWidth = titleEl.getBoundingClientRect().width;
      const rightColumnWidth = Math.max(0, (contentWidth - titleWidth) / 2);
      const connectorFullWidth = measureEl.getBoundingClientRect().width;
      setShowConnectorLabel(!isTruncated && rightColumnWidth >= connectorFullWidth);
    };
    updateLabelVisibility();
    const observer = new ResizeObserver(() => {
      updateLabelVisibility();
    });
    observer.observe(titleEl);
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [activeSession?.title, activeConnectors.length]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();

    // Get value from ref to handle both controlled and uncontrolled cases
    const currentPrompt = textareaRef.current?.value || prompt;

    if (
      (!currentPrompt.trim() && pastedImages.length === 0 && attachedFiles.length === 0) ||
      !activeSessionId ||
      isSubmitting
    )
      return;

    // 低内存预警：附加了音视频且提交文案疑似要转写时，先给用户一次引导提示，
    // 避免本地 FunASR 加载把内存耗尽导致渲染进程白屏/崩溃。
    const hasAudioAttachments = attachedFiles.some(isAudioAttachment);
    const soundsLikeTranscribe =
      /转写|转文字|语音|录音|转录|字幕|听一下|把这段音频|识别成文字|asr/i.test(currentPrompt);
    if (
      hasAudioAttachments &&
      soundsLikeTranscribe &&
      !lowMemoryWarnedRef.current &&
      isElectron &&
      window.electronAPI
    ) {
      try {
        const memInfo = await window.electronAPI.getMemoryInfo();
        const LOW_TOTAL_GB = 8;
        const LOW_FREE_GB = 1.5;
        if (
          (memInfo.totalGB > 0 && memInfo.totalGB <= LOW_TOTAL_GB) ||
          (memInfo.freeGB > 0 && memInfo.freeGB < LOW_FREE_GB)
        ) {
          lowMemoryWarnedRef.current = true;
          setGlobalNotice({
            id: `low-memory-asr-${Date.now()}`,
            type: 'warning',
            message: t('chat.lowMemoryAsrWarning', {
              totalGB: memInfo.totalGB.toFixed(1),
              freeGB: memInfo.freeGB.toFixed(1),
            }),
            messageKey: 'chat.lowMemoryAsrWarning',
            messageValues: {
              totalGB: memInfo.totalGB.toFixed(1),
              freeGB: memInfo.freeGB.toFixed(1),
            },
          });
        }
      } catch (err) {
        console.warn('[ChatView] Failed to check memory info:', err);
      }
    }

    setIsSubmitting(true);
    try {
      // Build content blocks
      const contentBlocks: ContentBlock[] = [];

      // Add images first
      pastedImages.forEach((img) => {
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: img.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
            data: img.base64,
          },
        });
      });

      // Add file attachments
      attachedFiles.forEach((file) => {
        contentBlocks.push({
          type: 'file_attachment',
          filename: file.name,
          relativePath: file.path, // Will be processed by backend to copy to .tmp
          size: file.size,
          mimeType: file.type,
          inlineDataBase64: file.inlineDataBase64,
        });
      });

      // Add text if present
      if (currentPrompt.trim()) {
        contentBlocks.push({
          type: 'text',
          text: currentPrompt.trim(),
        });
      }

      // Send message with content blocks
      await continueSession(activeSessionId, contentBlocks);

      // Clean up
      setPrompt('');
      if (textareaRef.current) {
        textareaRef.current.value = '';
        textareaRef.current.style.height = 'auto';
      }
      setInputHeight(56);
      pastedImages.forEach((img) => URL.revokeObjectURL(img.url));
      setPastedImages([]);
      setAttachedFiles([]);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStop = () => {
    if (activeSessionId) {
      stopSession(activeSessionId);
    }
  };

  const handleResume = useCallback(async () => {
    if (!activeSessionId || canStop || isSubmitting) return;
    setIsSubmitting(true);
    try {
      // 无痕续写：不产生用户气泡，主进程直接用上一轮上下文继续生成，
      // 历史里已落库的半截回复会被自动带上，模型从断点往下写。
      await continueSession(activeSessionId, ' ', { silentUserMessage: true });
    } finally {
      setIsSubmitting(false);
    }
  }, [activeSessionId, canStop, isSubmitting, continueSession]);

  if (!activeSession) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background px-5">
        <div className="w-full max-w-[980px] space-y-8">
          <div className="flex flex-col items-center justify-center text-center space-y-5 pt-10">
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted/80">今点通</p>
              <p className="text-3xl font-semibold tracking-[-0.04em] text-text-primary">
                {t('welcome.title')}
              </p>
              <p className="text-sm text-text-muted">{t('chat.startConversation')}</p>
            </div>
          </div>

          <div className="border-t border-border-muted bg-background/92 backdrop-blur-md rounded-[2rem] shadow-soft p-4 lg:p-5">
            <div
              className="mx-auto relative flex flex-col"
              style={{
                width: `${inputBoxSize.width}px`,
                maxWidth: '100%',
                minHeight: `${Math.max(inputHeight, inputBoxSize.height)}px`,
              }}
            >
              <div className="relative w-full flex-1 flex flex-col">
                <div
                  className={`relative flex items-end gap-2 p-3.5 rounded-[1.75rem] bg-background/88 border border-border-muted shadow-soft transition-colors ${
                    isDragging ? 'ring-2 ring-accent bg-accent/5' : ''
                  }`}
                >
                  <div
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startResize('x', -1)(e);
                    }}
                    className="absolute top-2 bottom-2 -left-1.5 w-2 cursor-ew-resize group/handle"
                    title={t('chat.resizeWidth') || 'Drag to resize width'}
                  >
                    <div className="absolute inset-y-0 left-1 w-0.5 rounded-full bg-border-muted group-hover/handle:bg-accent/50 transition-colors" />
                  </div>
                  <div
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startResize('x', 1)(e);
                    }}
                    className="absolute top-2 bottom-2 -right-1.5 w-2 cursor-ew-resize group/handle"
                    title={t('chat.resizeWidth') || 'Drag to resize width'}
                  >
                    <div className="absolute inset-y-0 right-1 w-0.5 rounded-full bg-border-muted group-hover/handle:bg-accent/50 transition-colors" />
                  </div>
                  <div
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startResize('y', -1)(e);
                    }}
                    className="absolute -top-1.5 left-2 right-2 h-2 cursor-ns-resize group/handle"
                    title={t('chat.resizeHeight') || 'Drag to resize height'}
                  >
                    <div className="absolute inset-x-0 top-1 h-0.5 rounded-full bg-border-muted group-hover/handle:bg-accent/50 transition-colors" />
                  </div>
                  <div
                    onPointerDown={(e) => {
                      e.preventDefault();
                      startResize('y', 1)(e);
                    }}
                    className="absolute -bottom-1.5 left-2 right-2 h-2 cursor-ns-resize group/handle"
                    title={t('chat.resizeHeight') || 'Drag to resize height'}
                  >
                    <div className="absolute inset-x-0 bottom-1 h-0.5 rounded-full bg-border-muted group-hover/handle:bg-accent/50 transition-colors" />
                  </div>

                  <button
                    type="button"
                    onClick={handleFileSelect}
                    className="w-9 h-9 rounded-2xl flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                    title={t('welcome.attachFiles')}
                  >
                    <Plus className="w-5 h-5" />
                  </button>

                  <textarea
                    ref={textareaRef}
                    value={prompt}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    style={{ minHeight: '24px', maxHeight: '180px' }}
                    onCompositionStart={() => {
                      isComposingRef.current = true;
                    }}
                    onCompositionEnd={() => {
                      isComposingRef.current = false;
                    }}
                    onPaste={handlePaste}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        if (e.nativeEvent.isComposing || isComposingRef.current) return;
                        e.preventDefault();
                        handleSubmit();
                      }
                    }}
                    placeholder={t('welcome.placeholder')}
                    disabled={isSubmitting}
                    rows={1}
                    className="flex-1 resize-none bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted text-[15px] py-2"
                  />

                  <div className="flex items-center gap-2">
                    <div className="relative" ref={modelMenuRef}>
                      <button
                        type="button"
                        onClick={() => setModelMenuOpen((v) => !v)}
                        className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border-subtle bg-background/60 text-xs text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors"
                        title={t('chat.switchModel') || 'Switch model'}
                      >
                        <Cpu className="w-3 h-3" />
                        <span className="max-w-[120px] truncate">
                          {quickSwitchModels.find((item) => item.id === activeConfigSetId)?.label ||
                            t('chat.noConfigSet')}
                        </span>
                        <ChevronDown className="w-3 h-3 shrink-0" />
                      </button>
                      {modelMenuOpen && (
                        <div className="absolute bottom-full mb-2 right-0 w-64 bg-background border border-border rounded-xl shadow-elevated overflow-hidden z-50">
                          <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-text-muted border-b border-border-muted">
                            {t('chat.switchModel') || 'Switch model'}
                          </div>
                          <div className="py-1 max-h-60 overflow-y-auto">
                            {quickSwitchModels.map((m) => {
                              const isActive = activeConfigSetId === m.id;
                              return (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => handleModelSwitch(m.id)}
                                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors ${
                                    isActive
                                      ? 'bg-accent/10 text-accent'
                                      : 'text-text-primary hover:bg-surface-hover'
                                  }`}
                                >
                                  <span className="flex-1 truncate">{m.label}</span>
                                  {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                                </button>
                              );
                            })}
                            {appConfig?.configSets &&
                              appConfig.configSets.length > 0 &&
                              quickSwitchModels.length === 0 && (
                                <div className="px-3 py-2 flex items-center gap-2 text-sm text-text-muted">
                                  <span className="flex-1 truncate">{t('chat.noConfigSet')}</span>
                                </div>
                              )}
                          </div>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={handleSubmit}
                      disabled={
                        (!prompt.trim() &&
                          pastedImages.length === 0 &&
                          attachedFiles.length === 0) ||
                        isSubmitting
                      }
                      className="inline-flex items-center gap-2 rounded-full bg-accent px-4 py-2.5 text-white shadow-sm hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isSubmitting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <>
                          {t('welcome.letsGo')}
                          <ChevronRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between gap-3 px-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                    <span className="hidden sm:inline">{t('welcome.defaultWorkingDir')}</span>
                  </div>
                </div>
              </div>
            </div>

            {pastedImages.length > 0 && (
              <div className="w-full max-w-[760px] flex flex-wrap gap-2 justify-center mx-auto">
                {pastedImages.map((img, index) => (
                  <div key={img.url} className="relative">
                    <img
                      src={img.url}
                      alt={t('welcome.pastedImageAlt', { index: index + 1 })}
                      className="h-16 w-16 rounded-lg object-cover border border-border-muted"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(index)}
                      className="absolute -top-2 -right-2 rounded-full bg-background border border-border-muted p-1 text-text-muted hover:text-error"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {attachedFiles.length > 0 && (
              <div className="w-full max-w-[760px] space-y-2 mx-auto">
                {attachedFiles.map((file, index) => (
                  <div
                    key={file.path || `attached-file-${index}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-muted border border-border group"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{file.name}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="w-6 h-6 rounded-full bg-error/10 hover:bg-error/20 text-error flex items-center justify-center"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-background">
      {/* Header */}
      <div
        ref={headerRef}
        className="relative h-12 border-b border-border-muted grid grid-cols-[1fr_auto_1fr] items-center px-4 lg:px-8 bg-background/88 backdrop-blur-md"
      >
        <div className="text-[11px] font-medium tracking-[0.08em] uppercase text-text-muted">
          今点通
        </div>
        <h2
          ref={titleRef}
          className="text-[15px] font-medium text-text-primary text-center truncate max-w-[40vw] lg:max-w-[32rem]"
        >
          {activeSession.title}
        </h2>
        {activeConnectors.length > 0 && (
          <>
            <div
              ref={connectorMeasureRef}
              aria-hidden="true"
              className="absolute left-0 top-0 -z-10 opacity-0 pointer-events-none"
            >
              <div className="flex items-center gap-2 px-2 py-1 rounded-lg border border-mcp/20">
                <Plug className="w-3.5 h-3.5" />
                <span className="text-xs font-medium whitespace-nowrap">
                  {t('chat.connectorCount', { count: activeConnectors.length })}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-mcp/8 border border-mcp/15 justify-self-end">
              <Plug className="w-3.5 h-3.5 text-mcp" />
              <span className="text-xs text-mcp font-medium">
                {showConnectorLabel
                  ? t('chat.connectorCount', { count: activeConnectors.length })
                  : activeConnectors.length}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
        <div
          ref={messagesContainerRef}
          className="w-full max-w-[920px] mx-auto py-8 px-5 lg:px-8 space-y-5"
        >
          {isLoadingMore && messages.length > 0 && (
            <div className="flex justify-center py-2">
              <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
            </div>
          )}
          {displayedMessages.length === 0 ? (
            loadingSessionId === activeSessionId ? (
              // Session data is being loaded — show a subtle loading indicator
              <div className="flex flex-col items-center justify-center py-28 text-text-muted space-y-3 text-center">
                <Loader2 className="w-5 h-5 animate-spin text-accent" />
                <p className="text-sm text-text-secondary">{t('chat.loadingConversation')}</p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-28 text-text-muted space-y-3 text-center">
                <p className="text-[11px] uppercase tracking-[0.16em] text-text-muted/80">今点通</p>
                <p className="text-base text-text-secondary">{t('chat.startConversation')}</p>
              </div>
            )
          ) : (
            roundPlans.map((round) => (
              <div key={round.key} className="space-y-5">
                {round.userMessage && (
                  <div key={round.userMessage.id}>
                    <MessageCard message={round.userMessage} />
                  </div>
                )}
                {round.items.length > 0 && (
                  <div className="space-y-1.5">
                    <ProcessPanel
                      blocks={round.processBlocks}
                      message={round.lastAssistantMessage}
                    />
                    {round.items.map((item) => {
                      if (item.visibleBlocks.length === 0) return null;

                      return (
                        <div key={item.message.id} className="space-y-1.5">
                          {item.visibleBlocks.map((block, index) => (
                            <ContentBlockView
                              key={
                                'id' in block
                                  ? (block as { id: string }).id
                                  : `block-${block.type}-${index}`
                              }
                              block={block}
                              isUser={false}
                              isStreaming={item.isStreaming}
                              allBlocks={item.mergedBlocks}
                              message={item.message}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))
          )}

          {/* Processing indicator - show when we have an active turn but no streaming content yet */}
          {hasActiveTurn &&
            (!partialMessage || partialMessage.trim() === '') &&
            !partialThinking && (
              <div className="flex items-center gap-3 px-4 py-3 rounded-full bg-background/80 border border-border-subtle max-w-fit">
                <Loader2 className="w-4 h-4 text-accent animate-spin" />
                <span className="text-sm text-text-secondary">{t('chat.processing')}</span>
              </div>
            )}

          {/* Real-time execution timer */}
          {liveElapsed > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-text-muted mt-1 ml-0.5">
              <Clock className="w-3 h-3" />
              <span>
                {timerActive
                  ? formatExecutionTime(liveElapsed)
                  : t('messageCard.executionTime', { time: formatExecutionTime(liveElapsed) })}
              </span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border-muted bg-background/92 backdrop-blur-md">
        <div
          className="mx-auto px-5 lg:px-8 py-5 relative flex flex-col"
          style={{
            width: `${inputBoxSize.width}px`,
            maxWidth: '100%',
            minHeight: `${Math.max(inputHeight, inputBoxSize.height)}px`,
          }}
        >
          <form
            onSubmit={handleSubmit}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className="relative w-full flex-1 flex flex-col"
          >
            {/* Image previews */}
            {pastedImages.length > 0 && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 mb-3">
                {pastedImages.map((img, index) => (
                  <div key={img.url || `pasted-image-${index}`} className="relative group">
                    <img
                      src={img.url}
                      alt={t('common.pastedImageAlt', { index: index + 1 })}
                      className="w-full aspect-square object-cover rounded-lg border border-border block"
                    />
                    <button
                      type="button"
                      onClick={() => removeImage(index)}
                      className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-error text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* File attachments */}
            {attachedFiles.length > 0 && (
              <div className="space-y-2 mb-3">
                {attachedFiles.map((file, index) => (
                  <div
                    key={file.path || `attached-file-${index}`}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-surface-muted border border-border group"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text-primary truncate">{file.name}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="w-6 h-6 rounded-full bg-error/10 hover:bg-error/20 text-error flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div
              className={`relative flex items-end gap-2 p-3.5 rounded-[1.75rem] bg-background/88 border border-border-muted shadow-soft transition-colors ${
                isDragging ? 'ring-2 ring-accent bg-accent/5' : ''
              }`}
            >
              {/* Resize handles - anchored to the rounded input capsule */}
              <div
                onPointerDown={(e) => {
                  e.preventDefault();
                  startResize('x', -1)(e);
                }}
                className="absolute top-2 bottom-2 -left-1.5 w-2 cursor-ew-resize group/handle"
                title={t('chat.resizeWidth') || 'Drag to resize width'}
              >
                <div className="absolute inset-y-0 left-1 w-0.5 rounded-full bg-border-muted group-hover/handle:bg-accent/50 transition-colors" />
              </div>
              <div
                onPointerDown={(e) => {
                  e.preventDefault();
                  startResize('x', 1)(e);
                }}
                className="absolute top-2 bottom-2 -right-1.5 w-2 cursor-ew-resize group/handle"
                title={t('chat.resizeWidth') || 'Drag to resize width'}
              >
                <div className="absolute inset-y-0 right-1 w-0.5 rounded-full bg-border-muted group-hover/handle:bg-accent/50 transition-colors" />
              </div>
              <div
                onPointerDown={(e) => {
                  e.preventDefault();
                  startResize('y', -1)(e);
                }}
                className="absolute -top-1.5 left-2 right-2 h-2 cursor-ns-resize group/handle"
                title={t('chat.resizeHeight') || 'Drag to resize height'}
              >
                <div className="absolute inset-x-0 top-1 h-0.5 rounded-full bg-border-muted group-hover/handle:bg-accent/50 transition-colors" />
              </div>
              <div
                onPointerDown={(e) => {
                  e.preventDefault();
                  startResize('y', 1)(e);
                }}
                className="absolute -bottom-1.5 left-2 right-2 h-2 cursor-ns-resize group/handle"
                title={t('chat.resizeHeight') || 'Drag to resize height'}
              >
                <div className="absolute inset-x-0 bottom-1 h-0.5 rounded-full bg-border-muted group-hover/handle:bg-accent/50 transition-colors" />
              </div>

              <button
                type="button"
                onClick={handleFileSelect}
                className="w-9 h-9 rounded-2xl flex items-center justify-center text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
                title={t('welcome.attachFiles')}
              >
                <Plus className="w-5 h-5" />
              </button>

              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(e) => handlePromptChange(e.target.value)}
                style={{ minHeight: '24px', maxHeight: '180px' }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  isComposingRef.current = false;
                }}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  // Enter to send, Shift+Enter for new line
                  if (e.key === 'Enter' && !e.shiftKey) {
                    if (e.nativeEvent.isComposing || isComposingRef.current) {
                      return;
                    }
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder={t('chat.typeMessage')}
                disabled={isSubmitting}
                rows={1}
                className="flex-1 resize-none bg-transparent border-none outline-none text-text-primary placeholder:text-text-muted text-[15px] py-2"
              />

              <div className="flex items-center gap-2">
                {/* Model quick-switch dropdown */}
                <div className="relative" ref={modelMenuRef}>
                  <button
                    type="button"
                    onClick={() => setModelMenuOpen((v) => !v)}
                    className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border-subtle bg-background/60 text-xs text-text-muted hover:bg-surface-hover hover:text-text-primary transition-colors"
                    title={t('chat.switchModel') || 'Switch model'}
                  >
                    <Cpu className="w-3 h-3" />
                    <span className="max-w-[120px] truncate">
                      {appConfig?.model || t('chat.noModel')}
                    </span>
                    <ChevronDown className="w-3 h-3 shrink-0" />
                  </button>
                  {modelMenuOpen && (
                    <div className="absolute bottom-full mb-2 right-0 w-64 bg-background border border-border rounded-xl shadow-elevated overflow-hidden z-50">
                      <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-text-muted border-b border-border-muted">
                        {t('chat.switchModel') || 'Switch model'}
                      </div>
                      <div className="py-1 max-h-60 overflow-y-auto">
                        {quickSwitchModels.map((m) => {
                          const isActive = activeConfigSetId === m.id;
                          return (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() => handleModelSwitch(m.id)}
                              className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors ${
                                isActive
                                  ? 'bg-accent/10 text-accent'
                                  : 'text-text-primary hover:bg-surface-hover'
                              }`}
                            >
                              <span className="flex-1 truncate">{m.label}</span>
                              {isActive && <Check className="w-3.5 h-3.5 shrink-0" />}
                            </button>
                          );
                        })}
                        {/* Fallback: show the current active config set if the config was
                            loaded before configSets were initialized */}
                        {appConfig?.configSets &&
                          appConfig.configSets.length > 0 &&
                          quickSwitchModels.length === 0 && (
                            <div className="px-3 py-2 flex items-center gap-2 text-sm text-text-muted">
                              <span className="flex-1 truncate">
                                {appConfig.model || appConfig.activeConfigSetId}
                              </span>
                            </div>
                          )}
                      </div>
                    </div>
                  )}
                </div>

                {canStop && (
                  <button
                    type="button"
                    onClick={handleStop}
                    className="w-9 h-9 rounded-2xl flex items-center justify-center bg-error/10 text-error hover:bg-error/20 transition-colors"
                    title={t('chat.stop')}
                  >
                    <Square className="w-4 h-4" />
                  </button>
                )}
                {canResume && (
                  <button
                    type="button"
                    onClick={handleResume}
                    className="w-9 h-9 rounded-2xl flex items-center justify-center bg-success/10 text-success hover:bg-success/20 transition-colors"
                    title={t('chat.resume')}
                  >
                    <Play className="w-4 h-4" />
                  </button>
                )}
                <button
                  type="submit"
                  disabled={
                    (!prompt.trim() &&
                      !textareaRef.current?.value.trim() &&
                      pastedImages.length === 0 &&
                      attachedFiles.length === 0) ||
                    isSubmitting
                  }
                  className="w-9 h-9 rounded-2xl flex items-center justify-center bg-accent text-background disabled:opacity-50 disabled:cursor-not-allowed hover:bg-accent-hover transition-colors"
                  title={t('chat.sendMessage')}
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>

            <p className="text-[11px] text-text-muted/60 text-center mt-2.5">
              {t('chat.disclaimer')}
            </p>
          </form>
        </div>
      </div>
    </div>
  );
}
