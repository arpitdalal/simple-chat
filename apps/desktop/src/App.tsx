import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { Settings } from "./components/Settings";
import { Toast, type ToastState } from "./components/Toast";
import {
  branchChat,
  chatMatchesQuery,
  createChat,
  getChat,
  getSettings,
  listChatPage,
  listMessages,
  listReusableChats,
  messageCount,
  openOrCreateChat,
  setDefaultModel,
  setResumeState,
  setSetting,
  updateChat,
  type AppSettings,
  type Chat,
  type ChatCursor,
} from "./lib/db";
import type { ProviderId } from "./lib/models";
import { pickDefaultModel } from "./lib/models";
import { isKeyOpBusy, listReadyProviders, subscribeKeyBusy } from "./lib/keys";
import { applyHotkey, formatHotkey, hideMainWindow } from "./lib/hotkey";
import { emptyChatNeedsRetarget, isEmptyNewChat } from "./lib/chats";
import { onMainWindowHidden, onMainWindowShown } from "./lib/memory";
import { createQueue, type Queue } from "./lib/queue";
import {
  ChatSession,
  chatCanBeDiscarded,
  getChatSession,
  messageCopyText,
  sessionHasWork,
} from "./lib/chat-runtime";
import {
  checkForAppUpdate,
  isRestartRequiredError,
  type AvailableUpdate,
} from "./lib/updater";
import {
  isAutostartEnabled,
  setAutostartEnabled,
  shouldPromptAutostart,
} from "./lib/autostart";
import "./App.css";

function compareChats(a: Chat, b: Chat): number {
  return b.pinned - a.pinned ||
    b.updated_at - a.updated_at ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function useChatList(ready: boolean, retainedChat: Chat | null) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [query, setQuery] = useState("");
  const [hasMore, setHasMore] = useState(false);
  const [pendingGeneration, setPendingGeneration] = useState<number | null>(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const queryRef = useRef("");
  const generationRef = useRef(0);
  const cursorRef = useRef<ChatCursor | null>(null);
  const hasMoreRef = useRef(false);
  const loadingRef = useRef(false);
  const lastLoadedQueryRef = useRef<string | null>(null);
  const retainedChatRef = useRef<Chat | null>(retainedChat);
  const removedIdsRef = useRef(new Set<string>());

  useEffect(() => {
    retainedChatRef.current = retainedChat;
  }, [retainedChat]);

  const refresh = useCallback(async (search = queryRef.current) => {
    const generation = ++generationRef.current;
    loadingRef.current = true;
    setPendingGeneration(generation);
    setLoadError(null);
    try {
      const page = await listChatPage({ limit: 100, query: search });
      if (generation !== generationRef.current) return;
      cursorRef.current = page.cursor;
      hasMoreRef.current = page.hasMore;
      lastLoadedQueryRef.current = search;
      const retained = retainedChatRef.current;
      const next = new Map(
        page.chats
          .filter((chat) => !removedIdsRef.current.has(chat.id))
          .map((chat) => [chat.id, chat]),
      );
      if (retained && !removedIdsRef.current.has(retained.id)) {
        if (chatMatchesQuery(retained, search)) {
          next.set(retained.id, retained);
        } else {
          next.delete(retained.id);
        }
      }
      setChats([...next.values()].sort(compareChats));
      setHasMore(page.hasMore);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current) {
        loadingRef.current = false;
        setPendingGeneration(null);
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    if (!hasMoreRef.current) {
      await refresh();
      return;
    }
    const generation = generationRef.current;
    loadingRef.current = true;
    setPendingGeneration(generation);
    setLoadError(null);
    try {
      const page = await listChatPage({
        limit: 100,
        cursor: cursorRef.current,
        query: queryRef.current,
      });
      if (generation !== generationRef.current) return;
      cursorRef.current = page.cursor;
      hasMoreRef.current = page.hasMore;
      setChats((current) => {
        const merged = new Map(current.map((chat) => [chat.id, chat]));
        for (const chat of page.chats) {
          if (!merged.has(chat.id) && !removedIdsRef.current.has(chat.id)) {
            merged.set(chat.id, chat);
          }
        }
        return [...merged.values()].sort(compareChats);
      });
      setHasMore(page.hasMore);
    } catch (error) {
      if (generation !== generationRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === generationRef.current) {
        loadingRef.current = false;
        setPendingGeneration(null);
      }
    }
  }, [refresh]);

  const upsert = useCallback((chat: Chat) => {
    if (removedIdsRef.current.has(chat.id)) return;
    setChats((current) => {
      const remaining = current.filter((item) => item.id !== chat.id);
      return chatMatchesQuery(chat, queryRef.current)
        ? [chat, ...remaining].sort(compareChats)
        : remaining;
    });
  }, []);

  const remove = useCallback((id: string) => {
    removedIdsRef.current.add(id);
    setChats((current) => current.filter((chat) => chat.id !== id));
  }, []);

  const changeQuery = useCallback((value: string) => {
    queryRef.current = value;
    setQuery(value);
    const generation = ++generationRef.current;
    setPendingGeneration(generation);
    loadingRef.current = true;
    cursorRef.current = null;
    hasMoreRef.current = false;
    lastLoadedQueryRef.current = null;
    setChats([]);
    setHasMore(false);
    setLoadError(null);
  }, []);

  useEffect(() => {
    if (!ready || lastLoadedQueryRef.current === query) return;
    const timeout = window.setTimeout(() => {
      void refresh(query);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [query, ready, refresh]);

  return {
    chats,
    query,
    queryRef,
    hasMore,
    loading: pendingGeneration !== null,
    loadError,
    refresh,
    loadMore,
    upsert,
    remove,
    changeQuery,
  };
}

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<Chat | null>(null);
  const [activeSession, setActiveSession] = useState(() => new ChatSession("__empty__"));
  const [toast, setToast] = useState<ToastState>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const suppressResumeTimestampRef = useRef(false);
  const bootWasHiddenRef = useRef(false);
  const showResumeGenRef = useRef(0);
  const pendingShowRef = useRef(false);
  const resumeShowRef = useRef<(() => void) | null>(null);
  const lastHiddenWriteRef = useRef<Promise<unknown> | null>(null);
  const [showResumeChain] = useState(() => ({ current: Promise.resolve() }));
  const [composerFocus, setComposerFocus] = useState(0);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<AvailableUpdate | null>(
    null,
  );
  const [updating, setUpdating] = useState(false);
  /** Install succeeded; only quit/reopen left — do not re-offer Install. */
  const [restartRequired, setRestartRequired] = useState(false);
  /** null = not probed yet (unknown — do not block send). */
  const [readyProviders, setReadyProviders] = useState<ProviderId[] | null>(
    null,
  );
  /** Derived from nav queue pending count — no separate lock flags. */
  const [navBusy, setNavBusy] = useState(false);
  /** Derived from keychain queue pending count (OS prompts included). */
  const [keyBusy, setKeyBusy] = useState(false);
  const [autostartPrompt, setAutostartPrompt] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const autostartPromptGenRef = useRef(0);
  const {
    chats,
    query,
    queryRef: currentQueryRef,
    hasMore: hasMoreChats,
    loading: chatsLoading,
    loadError: chatLoadError,
    refresh: refreshChats,
    loadMore: loadMoreChats,
    upsert: upsertChat,
    remove: removeChat,
    changeQuery,
  } = useChatList(ready, active);

  useEffect(() => activeSession.retain(), [activeSession]);

  function setActiveChat(chat: Chat | null) {
    setActive(chat);
    setActiveSession(chat ? getChatSession(chat.id) : new ChatSession("__empty__"));
  }

  /** Currently offered update; dismiss before replace. */
  const pendingUpdateRef = useRef<AvailableUpdate | null>(null);
  const updateCheckGenRef = useRef(0);
  const updatingRef = useRef(false);
  const restartRequiredRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  /** Sync ref before setState so queued key-sync sees the id without waiting a render. */
  const setActiveIdNow = useCallback((id: string | null) => {
    activeIdRef.current = id;
    setActiveId(id);
  }, []);
  /** Cancel generation for nav tasks (newChat / key sync). */
  const navGenRef = useRef(0);
  /** Claims the latest readiness probe so a stale one cannot clobber UI. */
  const readyGenRef = useRef(0);
  /** Bumped when Settings onSaved — persistDefaults CAS observes user edits. */
  const settingsGenRef = useRef(0);
  /** True while a key sync is queued/running (or was cancelled mid-flight). */
  const keySyncWantedRef = useRef(false);
  /** Latest Settings debounce flush — drain target while Settings is open. */
  const settingsFlushRef = useRef<(() => Promise<void>) | null>(null);
  const scheduleKeySyncRef = useRef<() => void>(() => {});

  // One FIFO for all nav work. busy ⇔ pending > 0 (queued or running).
  const navQueueRef = useRef<Queue | null>(null);
  if (navQueueRef.current === null) navQueueRef.current = createQueue();
  const navQueue = navQueueRef.current;

  useEffect(() => {
    const unsubNav = navQueue.subscribe(() => setNavBusy(navQueue.isBusy()));
    const unsubKey = subscribeKeyBusy(() => setKeyBusy(isKeyOpBusy()));
    setNavBusy(navQueue.isBusy());
    setKeyBusy(isKeyOpBusy());
    return () => {
      unsubNav();
      unsubKey();
    };
  }, [navQueue]);

  /**
   * Enqueue nav work. Cancel = bump navGen — queued tasks no-op at dequeue;
   * running tasks stop at the next isCancelled() check. No epoch locks.
   */
  function runNav<T>(
    op: (isCancelled: () => boolean) => Promise<T>,
  ): Promise<T | undefined> {
    const gen = navGenRef.current;
    const isCancelled = () => gen !== navGenRef.current;
    return navQueue.run(async () => {
      if (isCancelled()) return undefined;
      return op(isCancelled);
    });
  }

  /**
   * Invalidate in-flight newChat/key-sync. If a key sync was wanted,
   * re-enqueue it under the fresh gen so defaults/align still finish.
   */
  const cancelNav = useCallback(() => {
    navGenRef.current += 1;
    showResumeGenRef.current += 1;
    if (keySyncWantedRef.current) scheduleKeySyncRef.current();
  }, []);

  /** Apply a probe result only when it is still the latest claim. */
  function claimReady(list: ProviderId[] | null) {
    readyGenRef.current += 1;
    setReadyProviders(list);
  }

  /**
   * Probe → retarget defaults (CAS) → align active empty chat.
   * Serialized on the nav queue with newChat — never interleaves.
   */
  function scheduleKeySync() {
    keySyncWantedRef.current = true;
    const genAtEnqueue = navGenRef.current;
    void runNav(async (isCancelled) => {
      try {
        const readyGen = ++readyGenRef.current;
        const { ready, ok } = await listReadyProviders();
        if (isCancelled()) return;
        if (readyGen === readyGenRef.current) {
          setReadyProviders(ok ? ready : null);
        }
        // Store locked — unknown readiness; skip destructive align.
        if (!ok) return;

        const s = await getSettings();
        if (isCancelled()) return;
        const settingsGen = settingsGenRef.current;
        const picked = pickDefaultModel(ready, {
          provider: s.default_provider,
          modelId: s.default_model,
        });
        const next = picked
          ? await persistDefaults(picked, s, settingsGen)
          : s;
        if (isCancelled()) return;

        const alignTo = pickDefaultModel(ready, {
          provider: next.default_provider,
          modelId: next.default_model,
        });
        const id = activeIdRef.current;
        if (!id) return;
        const chat = await getChat(id);
        if (isCancelled() || !chat || activeIdRef.current !== id) return;
        if (!isEmptyNewChat(chat) || sessionHasWork(chat.id)) return;

        const aligned = await alignEmptyChat(chat, alignTo, ready);
        if (isCancelled()) return;
        if (activeIdRef.current === aligned.id) {
          setActiveChat(aligned);
          if (aligned !== chat) upsertChat(aligned);
        }
      } catch (err) {
        console.error("key sync failed", err);
        notify((err as Error)?.message || String(err), "err");
      } finally {
        if (navGenRef.current === genAtEnqueue) {
          keySyncWantedRef.current = false;
        }
      }
    });
  }

  useEffect(() => {
    scheduleKeySyncRef.current = scheduleKeySync;
  });

  const focusComposer = useCallback(() => {
    setComposerFocus((n) => n + 1);
  }, []);

  const notify = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    setToast({ text, kind });
  }, []);

  const persistDefaults = useCallback(
    async (
      picked: { provider: ProviderId; modelId: string },
      current: AppSettings,
      settingsGen?: number,
    ): Promise<AppSettings> => {
      if (
        picked.provider === current.default_provider &&
        picked.modelId === current.default_model
      ) {
        return current;
      }
      if (settingsGen != null && settingsGen !== settingsGenRef.current) {
        return getSettings();
      }
      const saved = await setDefaultModel(picked.provider, picked.modelId, {
        provider: current.default_provider,
        modelId: current.default_model,
      });
      if (settingsGen != null && settingsGen !== settingsGenRef.current) {
        return getSettings();
      }
      setSettings(saved);
      return saved;
    },
    [],
  );

  const alignEmptyChat = useCallback(
    async (
      chat: Chat,
      picked: { provider: ProviderId; modelId: string } | null,
      ready: readonly ProviderId[],
    ): Promise<Chat> => {
      if (!picked || !isEmptyNewChat(chat) || sessionHasWork(chat.id)) return chat;
      if (!emptyChatNeedsRetarget(chat, ready)) return chat;
      if ((await messageCount(chat.id)) !== 0) return chat;
      if (
        chat.provider === picked.provider &&
        chat.model_id === picked.modelId
      ) {
        return chat;
      }
      return updateChat(chat.id, {
        provider: picked.provider,
        model_id: picked.modelId,
      });
    },
    [],
  );

  const openSettings = useCallback(() => {
    cancelNav();
    setShowSettings(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onProvidersReady = useCallback((list: ProviderId[] | null) => {
    claimReady(list);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectChat = useCallback(
    async (id: string) => {
      cancelNav();
      setShowSettings(false);
      if (activeId === id) {
        focusComposer();
        return;
      }
      setActiveIdNow(id);
      const candidates = active && !chats.some((chat) => chat.id === active.id)
        ? [...chats, active]
        : chats;
      const toDelete = (
        await Promise.all(
          candidates
            .filter((chat) => chat.id !== id && isEmptyNewChat(chat))
            .map(async (chat) =>
              await chatCanBeDiscarded(chat.id) ? chat : null,
            ),
        )
      ).filter((chat): chat is Chat => chat !== null);
      await Promise.all(
        toDelete.map(async (chat) => {
          await getChatSession(chat.id).delete();
          removeChat(chat.id);
        }),
      );
      focusComposer();
    },
    [active, activeId, cancelNav, chats, focusComposer, removeChat, setActiveIdNow],
  );

  const newChat = useCallback(async () => {
    if (!settings) return;
    cancelNav();
    try {
      await runNav(async (isCancelled) => {
        // Drain Settings debounce so a just-picked default is visible.
        try {
          await settingsFlushRef.current?.();
        } catch (err) {
          // Persist failure must not block New Chat — defaults may be stale.
          console.error("settings flush failed", err);
        }
        if (isCancelled()) return;

        const readyGen = ++readyGenRef.current;
        const { ready, ok } = await listReadyProviders();
        if (isCancelled()) return;
        if (readyGen === readyGenRef.current) {
          setReadyProviders(ok ? ready : null);
        }
        const readyList = ok ? ready : [];

        const s = await getSettings();
        if (isCancelled()) return;
        const settingsGen = settingsGenRef.current;
        const picked = pickDefaultModel(readyList, {
          provider: s.default_provider,
          modelId: s.default_model,
        });
        const nextSettings = picked
          ? await persistDefaults(picked, s, settingsGen)
          : s;
        if (isCancelled()) return;
        const alignTo = pickDefaultModel(readyList, {
          provider: nextSettings.default_provider,
          modelId: nextSettings.default_model,
        });

        const reusableChats = await listReusableChats();
        if (isCancelled()) return;
        let existing: (typeof reusableChats)[number] | undefined;
        for (const c of reusableChats) {
          if (isEmptyNewChat(c) && await chatCanBeDiscarded(c.id)) {
            existing = c;
            break;
          }
        }
        if (existing) {
          const aligned = await alignEmptyChat(existing, alignTo, readyList);
          if (isCancelled()) return;
          setActiveIdNow(aligned.id);
          setActiveChat(aligned);
          setShowSettings(false);
          upsertChat(aligned);
          focusComposer();
          return;
        }
        if (active) {
          const freshActive = await getChat(active.id);
          if (isCancelled()) return;
          if (freshActive && isEmptyNewChat(freshActive) && await chatCanBeDiscarded(freshActive.id)) {
            const aligned = await alignEmptyChat(
              freshActive,
              alignTo,
              readyList,
            );
            if (isCancelled()) return;
            setActiveChat(aligned);
            setShowSettings(false);
            upsertChat(aligned);
            focusComposer();
            return;
          }
        }
        const chat = await createChat(
          (alignTo?.provider ?? nextSettings.default_provider) as ProviderId,
          alignTo?.modelId ?? nextSettings.default_model,
        );
        if (isCancelled()) {
          await getChatSession(chat.id).delete();
          return;
        }
        setActiveIdNow(chat.id);
        setActiveChat(chat);
        setShowSettings(false);
        upsertChat(chat);
        focusComposer();
      });
    } catch (err) {
      console.error("new chat failed", err);
      notify((err as Error)?.message || String(err), "err");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    settings,
    active,
    focusComposer,
    upsertChat,
    persistDefaults,
    alignEmptyChat,
    cancelNav,
    notify,
  ]);

  useEffect(() => {
    pendingUpdateRef.current = pendingUpdate;
  }, [pendingUpdate]);
  useEffect(() => {
    updatingRef.current = updating;
  }, [updating]);
  useEffect(() => {
    restartRequiredRef.current = restartRequired;
  }, [restartRequired]);

  function adoptUpdate(update: AvailableUpdate) {
    if (updatingRef.current || restartRequiredRef.current) {
      update.dismiss();
      return;
    }
    setPendingUpdate((prev) => {
      if (prev && prev !== update) prev.dismiss();
      return update;
    });
  }

  // Boot: never await the keychain — OS prompts must not block setReady.
  // Defaults/empty-chat align run after UI is up via scheduleKeySync.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await getSettings();
      if (cancelled) return;
      setSettings(s);
      await getCurrentWindow().setAlwaysOnTop(s.always_on_top);
      try {
        await applyHotkey(s.hotkey);
      } catch (err) {
        console.error("hotkey register failed", err);
        notify(
          (err as Error).message ||
            `Hotkey ${formatHotkey(s.hotkey)} failed — rebind in Settings.`,
          "err",
        );
      }

      const chat = await openOrCreateChat(s);
      if (cancelled) return;
      const visibleAtBoot = await getCurrentWindow().isVisible().catch(() => false);
      if (visibleAtBoot) {
        await setResumeState(Date.now(), chat.id);
      } else {
        suppressResumeTimestampRef.current = true;
        bootWasHiddenRef.current = true;
        await setSetting("last_chat_id", chat.id);
      }
      setActiveIdNow(chat.id);
      setActiveChat(chat);
      await refreshChats();
      upsertChat(chat);
      if (cancelled) return;
      readyRef.current = true;
      setReady(true);
      if (pendingShowRef.current) {
        pendingShowRef.current = false;
        resumeShowRef.current?.();
      }
      focusComposer();
      scheduleKeySync();
      const promptGen = ++autostartPromptGenRef.current;
      void (async () => {
        try {
          const enabled = await isAutostartEnabled();
          if (cancelled || promptGen !== autostartPromptGenRef.current) return;
          if (shouldPromptAutostart(s.autostart_prompted, enabled)) {
            setAutostartPrompt(true);
          }
        } catch {
          /* plugin missing — skip */
        }
      })();
      const gen = ++updateCheckGenRef.current;
      void checkForAppUpdate().then((result) => {
        if (gen !== updateCheckGenRef.current) {
          if (result.status === "available") result.update.dismiss();
          return;
        }
        if (result.status === "available") adoptUpdate(result.update);
      });
    })();
    return () => {
      cancelled = true;
      readyRef.current = false;
      navGenRef.current += 1;
      updateCheckGenRef.current += 1;
      autostartPromptGenRef.current += 1;
      pendingUpdateRef.current?.dismiss();
      pendingUpdateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshChats, upsertChat, focusComposer, notify]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void getChat(activeId).then((chat) => {
      if (!cancelled && activeIdRef.current === activeId) setActiveChat(chat);
    });
    if (suppressResumeTimestampRef.current) {
      void setSetting("last_chat_id", activeId);
    } else {
      void setResumeState(Date.now(), activeId);
    }
    return () => { cancelled = true; };
  }, [activeId]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onMainWindowHidden((hiddenAt) => {
      showResumeGenRef.current += 1;
      pendingShowRef.current = false;
      const write = setSetting(
        "last_opened_at",
        typeof hiddenAt === "number" ? hiddenAt : Date.now(),
      );
      lastHiddenWriteRef.current = write;
      void write.catch((err) => {
        console.error("resume timestamp failed", err);
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    const onShown = () => {
      if (!readyRef.current) {
        pendingShowRef.current = true;
        return;
      }
      const gen = navGenRef.current;
      const resumeGen = showResumeGenRef.current;
      const isStale = () =>
        cancelled || gen !== navGenRef.current || resumeGen !== showResumeGenRef.current;
      showResumeChain.current = showResumeChain.current
        .catch(() => undefined)
        .then(async () => {
          if (isStale()) return;
          await navQueue.run(async () => {
            if (isStale()) return;
            let chat: Chat | null = null;
            let priorChatId: string | null = null;
            try {
              const hiddenWrite = lastHiddenWriteRef.current;
              if (hiddenWrite) {
                try {
                  await hiddenWrite;
                } finally {
                  if (lastHiddenWriteRef.current === hiddenWrite) {
                    lastHiddenWriteRef.current = null;
                  }
                }
              }
              try {
                await settingsFlushRef.current?.();
              } catch (err) {
                console.error("settings flush failed", err);
              }
              if (isStale()) return;
              const settingsSnapshot = await getSettings();
              if (isStale()) return;
              setSettings(settingsSnapshot);
              priorChatId = settingsSnapshot.last_chat_id;
              const resumedChat = await openOrCreateChat(settingsSnapshot);
              chat = resumedChat;
              const discardStaleChat = async () => {
                if (resumedChat.id === priorChatId) return;
                try {
                  await getChatSession(resumedChat.id).delete();
                } catch (err) {
                  console.error("stale resume cleanup failed", err);
                }
                await setSetting("last_chat_id", activeIdRef.current);
              };
              if (isStale()) {
                await discardStaleChat();
                return;
              }
              suppressResumeTimestampRef.current = false;
              await setResumeState(Date.now(), resumedChat.id);
              if (isStale()) {
                await discardStaleChat();
                return;
              }
              setActiveIdNow(resumedChat.id);
              setActiveChat(resumedChat);
              await refreshChats();
              if (isStale()) return;
              upsertChat(resumedChat);
              focusComposer();
            } catch (err) {
              if (chat && chat.id !== priorChatId) {
                try {
                  await getChatSession(chat.id).delete();
                } catch (cleanupError) {
                  console.error("stale resume cleanup failed", cleanupError);
                }
                await setSetting("last_chat_id", activeIdRef.current).catch(() => undefined);
              }
              console.error("resume on show failed", err);
              notify((err as Error).message || String(err), "err");
             }
           });

        });
    };
    resumeShowRef.current = onShown;
    void onMainWindowShown(onShown).then(async (fn) => {
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
      if (!bootWasHiddenRef.current) return;
      const visible = await getCurrentWindow().isVisible().catch(() => false);
      if (!cancelled && visible) onShown();
    });
    return () => {
      cancelled = true;
      resumeShowRef.current = null;
      unlisten?.();
    };
  }, [focusComposer, navQueue, notify, refreshChats, setActiveIdNow, showResumeChain, upsertChat]);

  useEffect(() => {
    if (!showSettings) focusComposer();
  }, [showSettings, focusComposer]);

  useEffect(() => {
    let un: (() => void) | undefined;
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) focusComposer();
      })
      .then((fn) => {
        un = fn;
      });
    return () => un?.();
  }, [focusComposer]);

  useEffect(() => {
    function onDown(e: KeyboardEvent) {
      setShowShortcuts(e.metaKey || e.ctrlKey);
    }
    function onUp(e: KeyboardEvent) {
      setShowShortcuts(e.metaKey || e.ctrlKey);
    }
    function onBlur() {
      setShowShortcuts(false);
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    function mod(e: KeyboardEvent) {
      return e.metaKey || e.ctrlKey;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (document.querySelector(".model-menu")) return;
        e.preventDefault();
        if (showSettings) {
          setShowSettings(false);
          return;
        }
        void hideMainWindow();
        return;
      }
      if (mod(e) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newChat();
      }
      if (mod(e) && e.key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
      if (mod(e) && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const chat = chats[Number(e.key) - 1];
        if (chat) void selectChat(chat.id);
      }
      if (mod(e) && e.key === "0") {
        e.preventDefault();
        const chat = chats[9];
        if (chat) void selectChat(chat.id);
      }
      if (mod(e) && e.key === ",") {
        e.preventDefault();
        openSettings();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chats, showSettings, newChat, selectChat, openSettings]);

  async function updateChatInList(
    id: string,
    patch: Partial<Pick<Chat, "title" | "pinned" | "provider" | "model_id">>,
  ) {
    try {
      const updated = await updateChat(id, patch);
      upsertChat(updated);
      if (activeIdRef.current === id) setActiveChat(updated);
    } catch (error) {
      notify((error as Error).message || String(error), "err");
    }
  }

  async function handleDelete(id: string) {
    cancelNav();
    try {
      await getChatSession(id).delete();
    } catch (err) {
      notify((err as Error).message || String(err), "err");
      return;
    }
    removeChat(id);
    const deletedWasActive = activeIdRef.current === id;
    const hadQuery = Boolean(currentQueryRef.current.trim());
    if (!deletedWasActive && !hadQuery) return;
    const readFirst = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const search = currentQueryRef.current;
        const next = (await listChatPage({ limit: 1, query: search })).chats[0];
        if (currentQueryRef.current === search) return { next, search };
      }
      return null;
    };
    try {
      const current = await readFirst();
      if (!current) {
        if (deletedWasActive && activeIdRef.current === id) {
          setActiveIdNow(null);
          setActiveChat(null);
        }
        return;
      }
      let { next } = current;
      const keptQuery = Boolean(next);
      if (!next && current.search.trim()) {
        changeQuery("");
        const fallback = await readFirst();
        if (!fallback) {
          if (deletedWasActive && activeIdRef.current === id) {
            setActiveIdNow(null);
            setActiveChat(null);
          }
          return;
        }
        next = fallback.next;
      }
      if (deletedWasActive && activeIdRef.current === id) {
        if (next) {
          setActiveIdNow(next.id);
          setActiveChat(next);
          upsertChat(next);
        } else {
          setActiveIdNow(null);
          setActiveChat(null);
          if (settings) await newChat();
        }
      } else if (!deletedWasActive && !keptQuery && next) {
        upsertChat(next);
      }
    } catch (error) {
      if (deletedWasActive && activeIdRef.current === id) {
        setActiveIdNow(null);
        setActiveChat(null);
      }
      notify((error as Error).message || String(error), "err");
    }
  }

  async function handleClear(id: string) {
    cancelNav();
    try {
      const updated = await getChatSession(id).clear();
      if (!updated) throw new Error("Chat is busy");
      upsertChat(updated);
      if (activeId === id) setActiveChat(updated);
    } catch (error) {
      notify((error as Error).message || String(error), "err");
      return;
    }
    focusComposer();
  }

  async function handleCopy(id: string) {
    const msgs = await listMessages(id);
    const text = msgs.map((m) => `${m.role}:\n${messageCopyText(m)}`).join("\n\n");
    await navigator.clipboard.writeText(text);
  }

  async function handleBranch(throughMessageId: string) {
    if (!activeId) return;
    cancelNav();
    try {
      const branched = await branchChat(activeId, throughMessageId);
      setShowSettings(false);
      setActiveIdNow(branched.id);
      setActiveChat(branched);
      upsertChat(branched);
      focusComposer();
      notify("Branched chat", "ok");
    } catch (e) {
      notify((e as Error).message || String(e), "err");
      throw e;
    }
  }

  async function installPendingUpdate() {
    if (!pendingUpdate || updating || restartRequired) return;
    setUpdating(true);
    try {
      await pendingUpdate.install();
    } catch (e) {
      setUpdating(false);
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "string"
            ? e
            : "Update failed";
      if (isRestartRequiredError(e)) {
        setRestartRequired(true);
        pendingUpdate.dismiss();
      }
      notify(msg, "err");
    }
  }

  function settleAutostartPrompt() {
    autostartPromptGenRef.current += 1;
    setAutostartPrompt(false);
    setSettings((prev) =>
      prev ? { ...prev, autostart_prompted: true } : prev,
    );
  }

  async function persistAutostartPrompted() {
    await setSetting("autostart_prompted", true);
    settleAutostartPrompt();
  }

  function beginDrag(e: React.MouseEvent) {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest("button, input, textarea, select, a, .action-menu, [data-no-drag]"))
      return;
    e.preventDefault();
    void getCurrentWindow().startDragging();
  }

  if (!ready || !settings) {
    return <div className="boot">Starting Simple Chat…</div>;
  }

  const sendLocked = navBusy || keyBusy;
  const hasProviderKey =
    readyProviders === null
      ? null
      : active
        ? readyProviders.includes(active.provider as ProviderId)
        : readyProviders.length > 0;

  return (
    <div className={`app ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
      <div
        className="top-chrome"
        data-tauri-drag-region
        onMouseDown={beginDrag}
      >
        <div className="app-title">Simple Chat</div>
      </div>

      <div className="layout">
        {!sidebarOpen && (
          <button
            type="button"
            className="sidebar-reopen glass"
            onClick={() => setSidebarOpen(true)}
            title="Show sidebar (⌘/Ctrl+B)"
          >
            <SidebarToggleIcon />
          </button>
        )}
        {sidebarOpen && (
          <Sidebar
            chats={chats}
            activeId={activeId}
            query={query}
            onQuery={changeQuery}
            onSelect={(id) => void selectChat(id)}
            onNew={() => void newChat()}
            onToggleSidebar={() => setSidebarOpen(false)}
            onOpenSettings={openSettings}
            settingsActive={showSettings}
            onRename={(id, title) => {
              void updateChatInList(id, { title });
            }}
            onPin={(id, pinned) => {
              void updateChatInList(id, { pinned: pinned ? 1 : 0 });
            }}
            onClear={(id) => void handleClear(id)}
            onDelete={(id) => void handleDelete(id)}
            onCopyChat={(id) => void handleCopy(id)}
            showShortcuts={showShortcuts}
            hasMore={hasMoreChats}
            loadingMore={chatsLoading}
            loadError={chatLoadError}
            onLoadMore={() => void loadMoreChats()}
          />
        )}
        {showSettings ? (
          <div className="chat-stage settings-stage glass-panel">
            <Settings
              onClose={() => {
                setShowSettings(false);
                scheduleKeySync();
              }}
              onSaved={(s) => {
                settingsGenRef.current += 1;
                setSettings(s);
              }}
              onKeysChanged={scheduleKeySync}
              flushRef={settingsFlushRef}
              onNotify={notify}
              onUpdateFound={adoptUpdate}
              updateLocked={updating || restartRequired}
              onAutostartSettled={settleAutostartPrompt}
            />
          </div>
        ) : (
          <ChatView
            key={active?.id ?? "__empty__"}
            chat={active}
            session={activeSession}
            onChatUpdated={() => {
              const chatId = active?.id;
              if (!chatId) return;
              void getChat(chatId)
                .then((chat) => {
                  if (!chat) return;
                  upsertChat(chat);
                  if (activeIdRef.current === chatId) setActiveChat(chat);
                })
                .catch((error) => {
                  notify((error as Error).message || String(error), "err");
                });
            }}
            onChatMeta={(updated) => {
              if (activeIdRef.current === updated.id) setActive(updated);
              upsertChat(updated);
            }}
            onNew={() => void newChat()}
            onBranch={handleBranch}
            onNotify={notify}
            focusNonce={composerFocus}
            hasProviderKey={hasProviderKey}
            noKeysConfigured={
              readyProviders !== null && readyProviders.length === 0
            }
            sendLocked={sendLocked}
            onNeedKey={openSettings}
            onProvidersReady={onProvidersReady}
          />
        )}
      </div>
      {autostartPrompt && !showSettings ? (
        <div className="update-banner autostart-banner" role="status">
          <span>Start Simple Chat when you log in?</span>
          <div className="update-banner-actions">
            <button
              type="button"
              className="ghost"
              disabled={autostartBusy}
              onClick={() => {
                if (autostartBusy) return;
                void (async () => {
                  setAutostartBusy(true);
                  try {
                    await setAutostartEnabled(true);
                    await persistAutostartPrompted();
                  } catch (err) {
                    notify(
                      (err as Error).message ||
                        "Could not enable start on login.",
                      "err",
                    );
                  } finally {
                    setAutostartBusy(false);
                  }
                })();
              }}
            >
              Enable
            </button>
            <button
              type="button"
              className="ghost"
              disabled={autostartBusy}
              onClick={() => {
                if (autostartBusy) return;
                void (async () => {
                  setAutostartBusy(true);
                  try {
                    await persistAutostartPrompted();
                  } catch (err) {
                    notify(
                      (err as Error).message ||
                        "Could not save that choice.",
                      "err",
                    );
                  } finally {
                    setAutostartBusy(false);
                  }
                })();
              }}
            >
              Not now
            </button>
          </div>
        </div>
      ) : (
        pendingUpdate && (
          <div className="update-banner" role="status">
            <span>
              {restartRequired
                ? `Update ${pendingUpdate.version} installed — quit and reopen`
                : updating
                  ? `Installing ${pendingUpdate.version}…`
                  : `Update ${pendingUpdate.version} available`}
            </span>
            <div className="update-banner-actions">
              {!updating && !restartRequired && (
                <>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void installPendingUpdate()}
                  >
                    Install &amp; restart
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      pendingUpdate.dismiss();
                      setPendingUpdate(null);
                    }}
                  >
                    Later
                  </button>
                </>
              )}
            </div>
          </div>
        )
      )}
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

function SidebarToggleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M9 4v16" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export default App;
