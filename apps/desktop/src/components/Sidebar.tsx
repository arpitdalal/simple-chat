import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Chat } from "../lib/db";

function dayBucket(ts: number): string {
  const now = new Date();
  const startToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startYesterday = startToday - 86400000;
  const startWeek = startToday - 6 * 86400000;
  if (ts >= startToday) return "Today";
  if (ts >= startYesterday) return "Yesterday";
  if (ts >= startWeek) return "This Week";
  return "Older";
}

function shortcutLabel(index: number): string | null {
  if (index < 9) return String(index + 1);
  if (index === 9) return "0";
  return null;
}

type MenuState = { chatId: string; x: number; y: number } | null;

type Props = {
  chats: Chat[];
  activeId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onToggleSidebar: () => void;
  onOpenSettings: () => void;
  settingsActive: boolean;
  onRename: (id: string, title: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onClear: (id: string) => void;
  onDelete: (id: string) => void;
  onCopyChat: (id: string) => void;
  showShortcuts: boolean;
};

const MENU_W = 200;
const MENU_H = 220;

export function Sidebar({
  chats,
  activeId,
  query,
  onQuery,
  onSelect,
  onNew,
  onToggleSidebar,
  onOpenSettings,
  settingsActive,
  onRename,
  onPin,
  onClear,
  onDelete,
  onCopyChat,
  showShortcuts,
}: Props) {
  const [menu, setMenu] = useState<MenuState>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.preview.toLowerCase().includes(q),
    );
  }, [chats, query]);

  const flatIndex = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach((c, i) => map.set(c.id, i));
    return map;
  }, [filtered]);

  const groups = useMemo(() => {
    const map = new Map<string, Chat[]>();
    for (const chat of filtered) {
      const key = chat.pinned ? "Pinned" : dayBucket(chat.updated_at);
      const list = map.get(key) ?? [];
      list.push(chat);
      map.set(key, list);
    }
    const entries = [...map.entries()];
    entries.sort(([a], [b]) => {
      if (a === "Pinned") return -1;
      if (b === "Pinned") return 1;
      return 0;
    });
    return entries;
  }, [filtered]);

  useEffect(() => {
    function close(e: MouseEvent) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setMenu(null);
    }
    if (menu) {
      window.addEventListener("mousedown", close);
      return () => window.removeEventListener("mousedown", close);
    }
  }, [menu]);

  function openMenu(e: React.MouseEvent, chatId: string) {
    e.preventDefault();
    e.stopPropagation();
    let x = e.clientX;
    let y = e.clientY;
    if (x + MENU_W > window.innerWidth - 8) x = window.innerWidth - MENU_W - 8;
    if (y + MENU_H > window.innerHeight - 8) y = window.innerHeight - MENU_H - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    setMenu({ chatId, x, y });
  }

  function startRename(chat: Chat) {
    setRenamingId(chat.id);
    setRenameValue(chat.title);
    setMenu(null);
  }

  const menuChat = menu ? chats.find((c) => c.id === menu.chatId) : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-search-row">
        <input
          className="search"
          placeholder="Search Chats…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn side-toggle"
          onClick={onToggleSidebar}
          title="Hide sidebar (⌘/Ctrl+B)"
        >
          <SidebarToggleIcon />
        </button>
      </div>
      {/* keep onNew wired for keyboard; titlebar owns the visible + */}
      <button type="button" hidden onClick={onNew} aria-hidden />
      <div className="chat-list">
        {groups.map(([label, items]) => (
          <div key={label} className="chat-group">
            <div className="chat-group-label">{label}</div>
            {items.map((chat) => {
              const idx = flatIndex.get(chat.id) ?? 99;
              const num = shortcutLabel(idx);
              return (
                <div
                  key={chat.id}
                  className={`chat-item ${chat.id === activeId && !settingsActive ? "active" : ""} ${showShortcuts && num ? "show-nums" : ""}`}
                  onClick={() => onSelect(chat.id)}
                  onContextMenu={(e) => openMenu(e, chat.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelect(chat.id);
                  }}
                >
                  <div className="chat-item-body">
                    {renamingId === chat.id ? (
                      <input
                        className="rename-input"
                        value={renameValue}
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => {
                          const t = renameValue.trim();
                          if (t) onRename(chat.id, t);
                          setRenamingId(null);
                        }}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") {
                            const t = renameValue.trim();
                            if (t) onRename(chat.id, t);
                            setRenamingId(null);
                          }
                          if (e.key === "Escape") setRenamingId(null);
                        }}
                      />
                    ) : (
                      <>
                        <div className="chat-item-title">
                          {chat.pinned ? "📌 " : ""}
                          {chat.title}
                        </div>
                        <div className="chat-item-preview">{chat.preview}</div>
                      </>
                    )}
                  </div>
                  <div className="chat-item-trail">
                    {showShortcuts && num ? (
                      <span className="cmd-num">{num}</span>
                    ) : (
                      <button
                        type="button"
                        className="chat-more"
                        title="Actions"
                        onClick={(e) => openMenu(e, chat.id)}
                      >
                        ⋯
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="empty-side">No chats yet</div>
        )}
      </div>

      <button
        type="button"
        className={`sidebar-settings-tab ${settingsActive ? "active" : ""}`}
        onClick={onOpenSettings}
      >
        Settings
      </button>

      {menu &&
        menuChat &&
        createPortal(
          <div
            ref={menuRef}
            className="action-menu"
            style={{ left: menu.x, top: menu.y }}
          >
            <button type="button" onClick={() => startRename(menuChat)}>
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                onPin(menuChat.id, !menuChat.pinned);
                setMenu(null);
              }}
            >
              {menuChat.pinned ? "Unpin Chat" : "Pin Chat"}
            </button>
            <button
              type="button"
              onClick={() => {
                onCopyChat(menuChat.id);
                setMenu(null);
              }}
            >
              Copy Chat
            </button>
            <hr />
            <button
              type="button"
              onClick={() => {
                onClear(menuChat.id);
                setMenu(null);
              }}
            >
              Clear Chat
            </button>
            <button
              type="button"
              className="danger-item"
              onClick={() => {
                onDelete(menuChat.id);
                setMenu(null);
              }}
            >
              Delete Chat
            </button>
          </div>,
          document.body,
        )}
    </aside>
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
