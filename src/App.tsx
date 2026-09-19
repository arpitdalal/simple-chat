import { useCallback, useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/Sidebar";
import { ChatView } from "./components/ChatView";
import { Settings } from "./components/Settings";
import {
  createChat,
  getChat,
  getSettings,
  listChats,
  openOrCreateChat,
  setSetting,
  type AppSettings,
  type Chat,
} from "./lib/db";
import type { ProviderId } from "./lib/models";
import "./App.css";

function App() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<Chat | null>(null);
  const [query, setQuery] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [ready, setReady] = useState(false);

  const refreshChats = useCallback(async () => {
    setChats(await listChats());
  }, []);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setSettings(s);
      setWebSearch(s.web_search);
      await getCurrentWindow().setAlwaysOnTop(s.always_on_top);

      const chat = await openOrCreateChat(s);
      await setSetting("last_opened_at", Date.now());
      await setSetting("last_chat_id", chat.id);
      setActiveId(chat.id);
      setActive(chat);
      await refreshChats();
      setReady(true);
    })();
  }, [refreshChats]);

  useEffect(() => {
    if (!activeId) return;
    void getChat(activeId).then(setActive);
    void setSetting("last_chat_id", activeId);
    void setSetting("last_opened_at", Date.now());
  }, [activeId]);

  useEffect(() => {
    function mod(e: KeyboardEvent) {
      return e.metaKey || e.ctrlKey;
    }
    function onKey(e: KeyboardEvent) {
      if (mod(e) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void newChat();
      }
      if (mod(e) && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const idx = Number(e.key) - 1;
        const chat = chats[idx];
        if (chat) setActiveId(chat.id);
      }
      if (mod(e) && e.key === "0") {
        e.preventDefault();
        const chat = chats[9];
        if (chat) setActiveId(chat.id);
      }
      if (mod(e) && e.key === ",") {
        e.preventDefault();
        setShowSettings(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chats, settings]);

  async function newChat() {
    if (!settings) return;
    const chat = await createChat(
      settings.default_provider as ProviderId,
      settings.default_model,
    );
    setActiveId(chat.id);
    setActive(chat);
    setShowSettings(false);
    await refreshChats();
  }

  if (!ready || !settings) {
    return <div className="boot">Starting Simple Chat…</div>;
  }

  return (
    <div className="app">
      <Sidebar
        chats={chats}
        activeId={activeId}
        query={query}
        onQuery={setQuery}
        onSelect={setActiveId}
        onNew={() => void newChat()}
        onOpenSettings={() => setShowSettings(true)}
      />
      {showSettings ? (
        <Settings
          onClose={() => setShowSettings(false)}
          onSaved={(s) => {
            setSettings(s);
            setWebSearch(s.web_search);
            void refreshChats();
          }}
        />
      ) : (
        <ChatView
          chat={active}
          webSearch={webSearch}
          onWebSearch={setWebSearch}
          onChatUpdated={() => void refreshChats()}
          onNew={() => void newChat()}
        />
      )}
    </div>
  );
}

export default App;
