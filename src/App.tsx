import { useCallback, useEffect, useState } from "react";
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
  openOrCreateChat,
  setSetting,
  updateChat,
  type AppSettings,
  type Chat,
} from "./lib/db";
import type { ProviderId } from "./lib/models";
import { applyHotkey, formatHotkey, hideMainWindow } from "./lib/hotkey";
import { isEmptyNewChat } from "./lib/chats";
import {
  checkForAppUpdate,
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

  const refreshChats = useCallback(async () => {
    setChats(await listChats());
  }, []);

  const focusComposer = useCallback(() => {
    setComposerFocus((n) => n + 1);
  }, []);

  const notify = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    setToast({ text, kind });
  }, []);

  const selectChat = useCallback(
    async (id: string) => {
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
    const existing = chats.find(isEmptyNewChat);
    if (existing) {
      setActiveId(existing.id);
      setActive(existing);
      setShowSettings(false);
      focusComposer();
      return;
    }
    if (active && isEmptyNewChat(active)) {
      focusComposer();
      return;
    }
    const chat = await createChat(
      settings.default_provider as ProviderId,
      settings.default_model,
    );
    setActiveId(chat.id);
    setActive(chat);
    setShowSettings(false);
    await refreshChats();
    focusComposer();
  }, [settings, chats, active, focusComposer, refreshChats]);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
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
      await setSetting("last_opened_at", Date.now());
      await setSetting("last_chat_id", chat.id);
      setActiveId(chat.id);
      setActive(chat);
      await refreshChats();
      setReady(true);
      focusComposer();
      void checkForAppUpdate().then(setPendingUpdate);
    })();
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
        setShowSettings(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chats, showSettings, newChat, selectChat]);

  async function handleDelete(id: string) {
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
    if (!pendingUpdate || updating) return;
    setUpdating(true);
    try {
      await pendingUpdate.install();
    } catch (e) {
      setUpdating(false);
      notify((e as Error).message || "Update failed", "err");
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
            onOpenSettings={() => setShowSettings(true)}
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
              onClose={() => setShowSettings(false)}
              onSaved={(s) => {
                setSettings(s);
                void refreshChats();
              }}
              onNotify={notify}
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
          />
        )}
      </div>
      {pendingUpdate && (
        <div className="update-banner" role="status">
          <span>
            {updating
              ? `Installing ${pendingUpdate.version}…`
              : `Update ${pendingUpdate.version} available`}
          </span>
          <div className="update-banner-actions">
            {!updating && (
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
                  onClick={() => setPendingUpdate(null)}
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
