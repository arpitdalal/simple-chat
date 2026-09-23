import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { Settings } from "./components/Settings";
import { Toast, type ToastState } from "./components/Toast";
import {
  branchChat,
  clearChatMessages,
  createChat,
  deleteChat,
  getChat,
  getSettings,
  listChats,
  listMessages,
  messageCount,
  openOrCreateChat,
  setDefaultModel,
  setSetting,
  updateChat,
  type AppSettings,
  type Chat,
} from "./lib/db";
import type { ProviderId } from "./lib/models";
import { pickDefaultModel } from "./lib/models";
import { isKeyOpBusy, listReadyProviders, subscribeKeyBusy } from "./lib/keys";
import { applyHotkey, formatHotkey, hideMainWindow } from "./lib/hotkey";
import { emptyChatNeedsRetarget, isEmptyNewChat } from "./lib/chats";
import { createQueue, type Queue } from "./lib/queue";
import { stopChat } from "./lib/chat-runtime";
import {
  checkForAppUpdate,
  isRestartRequiredError,
  type AvailableUpdate,
} from "./lib/updater";
import "./App.css";

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<Chat | null>(null);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<ToastState>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [ready, setReady] = useState(false);
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
  /** Bumped when a chat's messages are cleared — ChatView drops local mirrors. */
  const [cleared, setCleared] = useState<{ chatId: string; nonce: number } | null>(
    null,
  );

  /** Currently offered update; dismiss before replace. */
  const pendingUpdateRef = useRef<AvailableUpdate | null>(null);
  const updateCheckGenRef = useRef(0);
  const updatingRef = useRef(false);
  const restartRequiredRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  /** Sync ref before setState so queued key-sync sees the id without waiting a render. */
  function setActiveIdNow(id: string | null) {
    activeIdRef.current = id;
    setActiveId(id);
  }
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
  function cancelNav() {
    navGenRef.current += 1;
    if (keySyncWantedRef.current) scheduleKeySync();
  }

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
        if (!isEmptyNewChat(chat)) return;

        const aligned = await alignEmptyChat(chat, alignTo, ready);
        if (isCancelled()) return;
        if (activeIdRef.current === aligned.id) {
          setActive(aligned);
          if (aligned !== chat) await refreshChats();
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

  const refreshChats = useCallback(async () => {
    setChats(await listChats());
  }, []);

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
      if (!picked || !isEmptyNewChat(chat)) return chat;
      if (!emptyChatNeedsRetarget(chat, ready)) return chat;
      if ((await messageCount(chat.id)) !== 0) return chat;
      if (
        chat.provider === picked.provider &&
        chat.model_id === picked.modelId
      ) {
        return chat;
      }
      await updateChat(chat.id, {
        provider: picked.provider,
        model_id: picked.modelId,
      });
      return {
        ...chat,
        provider: picked.provider,
        model_id: picked.modelId,
      };
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
      const toDelete = chats.filter(
        (c) => c.id !== id && isEmptyNewChat(c),
      );
      if (toDelete.length) {
        for (const c of toDelete) await deleteChat(c.id);
        await refreshChats();
      }
      focusComposer();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [activeId, chats, focusComposer, refreshChats],
  );

  const newChat = useCallback(async () => {
    if (!settings) return;
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

        const liveChats = await listChats();
        if (isCancelled()) return;
        const existing = liveChats.find(isEmptyNewChat);
        if (existing) {
          const aligned = await alignEmptyChat(existing, alignTo, readyList);
          if (isCancelled()) return;
          setActiveIdNow(aligned.id);
          setActive(aligned);
          setShowSettings(false);
          if (aligned !== existing) await refreshChats();
          else setChats(liveChats);
          focusComposer();
          return;
        }
        if (active) {
          const freshActive = await getChat(active.id);
          if (isCancelled()) return;
          if (freshActive && isEmptyNewChat(freshActive)) {
            const aligned = await alignEmptyChat(
              freshActive,
              alignTo,
              readyList,
            );
            if (isCancelled()) return;
            setActive(aligned);
            setShowSettings(false);
            if (aligned !== freshActive) await refreshChats();
            else setChats(liveChats);
            focusComposer();
            return;
          }
        }
        const chat = await createChat(
          (alignTo?.provider ?? nextSettings.default_provider) as ProviderId,
          alignTo?.modelId ?? nextSettings.default_model,
        );
        if (isCancelled()) {
          await deleteChat(chat.id);
          return;
        }
        setActiveIdNow(chat.id);
        setActive(chat);
        setShowSettings(false);
        await refreshChats();
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
    refreshChats,
    persistDefaults,
    alignEmptyChat,
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
      await setSetting("last_opened_at", Date.now());
      await setSetting("last_chat_id", chat.id);
      setActiveIdNow(chat.id);
      setActive(chat);
      await refreshChats();
      if (cancelled) return;
      setReady(true);
      focusComposer();
      scheduleKeySync();
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
      navGenRef.current += 1;
      updateCheckGenRef.current += 1;
      pendingUpdateRef.current?.dismiss();
      pendingUpdateRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshChats, focusComposer, notify]);

  useEffect(() => {
    if (!activeId) return;
    void getChat(activeId).then(setActive);
    void setSetting("last_chat_id", activeId);
    void setSetting("last_opened_at", Date.now());
  }, [activeId]);

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

  async function handleDelete(id: string) {
    cancelNav();
    await deleteChat(id);
    if (activeId === id) {
      const next = (await listChats())[0];
      if (next) {
        setActiveIdNow(next.id);
        setActive(next);
      } else if (settings) {
        await newChat();
        return;
      }
    }
    await refreshChats();
  }

  async function handleClear(id: string) {
    cancelNav();
    // Abort active + queued turns before wiping — a live turn must not
    // re-insert into the chat mid-clear.
    stopChat(id);
    await clearChatMessages(id);
    // Signal ChatView to drop localAdds/pendingSends for this chat — otherwise
    // mergeHistory resurrects wiped rows on the next history load.
    setCleared({ chatId: id, nonce: Date.now() });
    if (activeId === id) setActive(await getChat(id));
    await refreshChats();
    focusComposer();
  }

  async function handleCopy(id: string) {
    const msgs = await listMessages(id);
    const text = msgs.map((m) => `${m.role}:\n${m.content}`).join("\n\n");
    await navigator.clipboard.writeText(text);
  }

  async function handleBranch(throughMessageId: string) {
    if (!activeId) return;
    cancelNav();
    try {
      const branched = await branchChat(activeId, throughMessageId);
      setShowSettings(false);
      setActiveIdNow(branched.id);
      setActive(branched);
      await refreshChats();
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
            onQuery={setQuery}
            onSelect={(id) => void selectChat(id)}
            onNew={() => void newChat()}
            onToggleSidebar={() => setSidebarOpen(false)}
            onOpenSettings={openSettings}
            settingsActive={showSettings}
            onRename={(id, title) => {
              void updateChat(id, { title }).then(refreshChats);
              if (activeId === id) {
                setActive((c) => (c ? { ...c, title } : c));
              }
            }}
            onPin={(id, pinned) => {
              void updateChat(id, { pinned: pinned ? 1 : 0 }).then(refreshChats);
            }}
            onClear={(id) => void handleClear(id)}
            onDelete={(id) => void handleDelete(id)}
            onCopyChat={(id) => void handleCopy(id)}
            showShortcuts={showShortcuts}
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
                void refreshChats();
              }}
              onKeysChanged={scheduleKeySync}
              flushRef={settingsFlushRef}
              onNotify={notify}
              onUpdateFound={adoptUpdate}
              updateLocked={updating || restartRequired}
            />
          </div>
        ) : (
          <ChatView
            chat={active}
            onChatUpdated={() => void refreshChats()}
            onChatMeta={setActive}
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
            cleared={cleared}
          />
        )}
      </div>
      {pendingUpdate && (
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
