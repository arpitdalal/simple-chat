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
import { listReadyProviders } from "./lib/keys";
import { applyHotkey, formatHotkey, hideMainWindow } from "./lib/hotkey";
import { isEmptyNewChat } from "./lib/chats";
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
  /** null = not probed yet. */
  const [readyProviders, setReadyProviders] = useState<ProviderId[] | null>(
    null,
  );
  /** True while newChat awaits key probes / create — blocks send on old thread. */
  const [navBusy, setNavBusy] = useState(false);

  /** Currently offered update; dismiss before replace. */
  const pendingUpdateRef = useRef<AvailableUpdate | null>(null);
  const updateCheckGenRef = useRef(0);
  const updatingRef = useRef(false);
  const restartRequiredRef = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;
  /** Bumped on sidebar navigation so in-flight newChat cannot resurrect a deleted empty. */
  const navGenRef = useRef(0);
  const readyGenRef = useRef(0);
  const settingsGenRef = useRef(0);
  /** Bumped per onKeysChanged so overlapping key syncs don't retarget with a stale ready list. */
  const keysSyncGenRef = useRef(0);
  const keysSyncTailRef = useRef(Promise.resolve());

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
      if (
        settingsGen != null &&
        settingsGen !== settingsGenRef.current
      ) {
        return getSettings();
      }
      // Atomic pair write with CAS — skips if Settings already moved defaults.
      const saved = await setDefaultModel(
        picked.provider,
        picked.modelId,
        {
          provider: current.default_provider,
          modelId: current.default_model,
        },
      );
      if (
        settingsGen != null &&
        settingsGen !== settingsGenRef.current
      ) {
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
    ): Promise<Chat> => {
      if (!picked || !isEmptyNewChat(chat)) return chat;
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

  /** Latest ready list, or null if this probe was superseded / all probes failed. */
  const refreshReadyKeys = useCallback(async (): Promise<ProviderId[] | null> => {
    const gen = ++readyGenRef.current;
    const { ready, ok } = await listReadyProviders();
    if (gen !== readyGenRef.current) return null;
    if (!ok) {
      // Don't keep a prior successful list when the store is locked.
      setReadyProviders(null);
      return null;
    }
    setReadyProviders(ready);
    return ready;
  }, []);

  const openSettings = useCallback(() => {
    navGenRef.current += 1;
    setNavBusy(false);
    setShowSettings(true);
  }, []);

  // Apply ModelPicker probe. null = store unknown (locked) — clear ready list.
  // Bump readyGen so stale onClose/boot refreshes die; newChat probes directly.
  const onProvidersReady = useCallback((ready: ProviderId[] | null) => {
    readyGenRef.current += 1;
    setReadyProviders(ready);
  }, []);

  const selectChat = useCallback(
    async (id: string) => {
      navGenRef.current += 1;
      setNavBusy(false);
      setShowSettings(false);
      if (activeId === id) {
        focusComposer();
        return;
      }
      setActiveId(id);
      const toDelete = chats.filter(
        (c) => c.id !== id && isEmptyNewChat(c),
      );
      if (toDelete.length) {
        for (const c of toDelete) await deleteChat(c.id);
        await refreshChats();
      }
      focusComposer();
    },
    [activeId, chats, focusComposer, refreshChats],
  );

  const newChat = useCallback(async () => {
    if (!settings) return;
    const gen = ++navGenRef.current;
    setNavBusy(true);
    try {
      // Probe directly — refreshReadyKeys shares readyGen with onProvidersReady,
      // so a ModelPicker mount probe would cancel New Chat mid-flight.
      const { ready, ok } = await listReadyProviders();
      if (gen !== navGenRef.current) return;
      readyGenRef.current += 1;
      // Store locked: keep unknown readiness but still open a chat from
      // persisted defaults (same as boot).
      const readyList = ok ? ready : [];
      setReadyProviders(ok ? ready : null);

      // Defaults may have changed in Settings while probes ran.
      const s = await getSettings();
      if (gen !== navGenRef.current) return;
      const settingsGen = settingsGenRef.current;
      const picked = pickDefaultModel(readyList, {
        provider: s.default_provider,
        modelId: s.default_model,
      });
      const nextSettings = picked
        ? await persistDefaults(picked, s, settingsGen)
        : s;
      if (gen !== navGenRef.current) return;
      // Align from persisted defaults, not the pre-persist pick (gen may abort write).
      const alignTo = pickDefaultModel(readyList, {
        provider: nextSettings.default_provider,
        modelId: nextSettings.default_model,
      });

      const existing = chats.find(isEmptyNewChat);
      if (existing) {
        const aligned = await alignEmptyChat(existing, alignTo);
        if (gen !== navGenRef.current) return;
        setActiveId(aligned.id);
        setActive(aligned);
        setShowSettings(false);
        if (aligned !== existing) await refreshChats();
        focusComposer();
        return;
      }
      if (active && isEmptyNewChat(active)) {
        const aligned = await alignEmptyChat(active, alignTo);
        if (gen !== navGenRef.current) return;
        if (aligned !== active) {
          setActive(aligned);
          await refreshChats();
        }
        focusComposer();
        return;
      }
      const chat = await createChat(
        (alignTo?.provider ?? nextSettings.default_provider) as ProviderId,
        alignTo?.modelId ?? nextSettings.default_model,
      );
      if (gen !== navGenRef.current) {
        await deleteChat(chat.id);
        return;
      }
      setActiveId(chat.id);
      setActive(chat);
      setShowSettings(false);
      await refreshChats();
      focusComposer();
    } finally {
      if (gen === navGenRef.current) setNavBusy(false);
    }
  }, [
    settings,
    chats,
    active,
    focusComposer,
    refreshChats,
    persistDefaults,
    alignEmptyChat,
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
    // Don't replace or dismiss the in-flight installer / restart-required banner.
    if (updatingRef.current || restartRequiredRef.current) {
      update.dismiss();
      return;
    }
    setPendingUpdate((prev) => {
      if (prev && prev !== update) prev.dismiss();
      return update;
    });
  }

  useEffect(() => {
    void (async () => {
      let s = await getSettings();
      const ready = await refreshReadyKeys();
      let picked: { provider: ProviderId; modelId: string } | null = null;
      // null = superseded or store locked — do not treat as "zero keys".
      if (ready != null) {
        picked = pickDefaultModel(ready, {
          provider: s.default_provider,
          modelId: s.default_model,
        });
        if (picked) s = await persistDefaults(picked, s);
      }
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

      let chat = await openOrCreateChat(s);
      if (ready != null) {
        const alignTo = pickDefaultModel(ready, {
          provider: s.default_provider,
          modelId: s.default_model,
        });
        chat = await alignEmptyChat(chat, alignTo);
      }
      await setSetting("last_opened_at", Date.now());
      await setSetting("last_chat_id", chat.id);
      setActiveId(chat.id);
      setActive(chat);
      await refreshChats();
      setReady(true);
      focusComposer();
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
      updateCheckGenRef.current += 1;
      pendingUpdateRef.current?.dismiss();
      pendingUpdateRef.current = null;
    };
  }, [
    refreshChats,
    focusComposer,
    notify,
    refreshReadyKeys,
    persistDefaults,
    alignEmptyChat,
  ]);

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
    navGenRef.current += 1;
    setNavBusy(false);
    await deleteChat(id);
    if (activeId === id) {
      const next = (await listChats())[0];
      if (next) {
        setActiveId(next.id);
        setActive(next);
      } else if (settings) {
        await newChat();
        return;
      }
    }
    await refreshChats();
  }

  async function handleClear(id: string) {
    navGenRef.current += 1;
    setNavBusy(false);
    await clearChatMessages(id);
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
    navGenRef.current += 1;
    setNavBusy(false);
    try {
      const branched = await branchChat(activeId, throughMessageId);
      setShowSettings(false);
      setActiveId(branched.id);
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
                void refreshReadyKeys();
              }}
              onSaved={(s) => {
                settingsGenRef.current += 1;
                setSettings(s);
                void refreshChats();
              }}
              onKeysChanged={() => {
                const gen = ++keysSyncGenRef.current;
                const settingsGen = settingsGenRef.current;
                // Serialize + skip stale gens so an older alignEmptyChat cannot
                // finish after a newer key clear and retarget to a removed provider.
                keysSyncTailRef.current = keysSyncTailRef.current
                  .catch(() => undefined)
                  .then(async () => {
                    if (gen !== keysSyncGenRef.current) return;
                    // Probe here — not via refreshReadyKeys — so a ModelPicker
                    // onReady cannot cancel this sync by bumping readyGen.
                    const { ready, ok } = await listReadyProviders();
                    if (gen !== keysSyncGenRef.current) return;
                    readyGenRef.current += 1;
                    if (!ok) {
                      setReadyProviders(null);
                      return;
                    }
                    setReadyProviders(ready);
                    const s = await getSettings();
                    if (gen !== keysSyncGenRef.current) return;
                    const picked = pickDefaultModel(ready, {
                      provider: s.default_provider,
                      modelId: s.default_model,
                    });
                    const next = picked
                      ? await persistDefaults(picked, s, settingsGen)
                      : s;
                    if (gen !== keysSyncGenRef.current) return;
                    setSettings(next);
                    const alignTo = pickDefaultModel(ready, {
                      provider: next.default_provider,
                      modelId: next.default_model,
                    });
                    const id = activeIdRef.current;
                    if (!id) return;
                    const chat = await getChat(id);
                    if (gen !== keysSyncGenRef.current) return;
                    if (
                      chat &&
                      activeIdRef.current === id &&
                      isEmptyNewChat(chat)
                    ) {
                      const navGen = navGenRef.current;
                      setNavBusy(true);
                      try {
                        const aligned = await alignEmptyChat(chat, alignTo);
                        if (gen !== keysSyncGenRef.current) return;
                        if (activeIdRef.current === aligned.id) {
                          setActive(aligned);
                          if (aligned !== chat) await refreshChats();
                        }
                      } finally {
                        if (
                          gen === keysSyncGenRef.current &&
                          navGen === navGenRef.current
                        ) {
                          setNavBusy(false);
                        }
                      }
                    }
                  });
              }}
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
            hasProviderKey={
              readyProviders === null
                ? null
                : active
                  ? readyProviders.includes(active.provider as ProviderId)
                  : readyProviders.length > 0
            }
            noKeysConfigured={
              readyProviders !== null && readyProviders.length === 0
            }
            sendLocked={navBusy}
            onNeedKey={openSettings}
            onProvidersReady={onProvidersReady}
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
