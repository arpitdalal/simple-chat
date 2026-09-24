import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Chat } from "../lib/db";

function dayBucket(ts: number): string {
  const now = new Date();
  const startToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startYesterday = new Date(startToday);
  startYesterday.setDate(startYesterday.getDate() - 1);
  const startWeek = new Date(startToday);
  startWeek.setDate(startWeek.getDate() - 6);
  if (ts >= startToday.getTime()) return "Today";
  if (ts >= startYesterday.getTime()) return "Yesterday";
  if (ts >= startWeek.getTime()) return "This Week";
  return "Older";
}

function shortcutLabel(index: number): string | null {
  if (index < 9) return String(index + 1);
  if (index === 9) return "0";
  return null;
}

type MenuState = { chatId: string; x: number; y: number } | null;
type ListRow =
  | { kind: "header"; key: string; label: string }
  | { kind: "chat"; key: string; chat: Chat; shortcutIndex: number };

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
  hasMore: boolean;
  loadingMore: boolean;
  loadError: string | null;
  onLoadMore: () => void;
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
  hasMore,
  loadingMore,
  loadError,
  onLoadMore,
}: Props) {
  const [menu, setMenu] = useState<MenuState>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (chat) =>
        chat.title.toLowerCase().includes(q) ||
        chat.preview.toLowerCase().includes(q),
    );
  }, [chats, query]);

  const rows = useMemo<ListRow[]>(() => {
    const result: ListRow[] = [];
    let group = "";
    filtered.forEach((chat, shortcutIndex) => {
      const nextGroup = chat.pinned ? "Pinned" : dayBucket(chat.updated_at);
      if (nextGroup !== group) {
        group = nextGroup;
        result.push({ kind: "header", key: `header:${group}`, label: group });
      }
      result.push({ kind: "chat", key: chat.id, chat, shortcutIndex });
    });
    return result;
  }, [filtered]);

  const rowCount = rows.length + (hasMore || loadingMore || loadError ? 1 : 0);
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rows[index]?.kind === "header" ? 30 : 56,
    overscan: 8,
    getItemKey: (index) => rows[index]?.key ?? "chat-list-footer",
  });
  const virtualRows = virtualizer.getVirtualItems();
  const lastVirtualIndex = virtualRows[virtualRows.length - 1]?.index ?? 0;

  useEffect(() => {
    if (hasMore && !loadingMore && lastVirtualIndex >= rows.length - 20) {
      onLoadMore();
    }
  }, [hasMore, lastVirtualIndex, loadingMore, onLoadMore, rows.length]);

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

  const menuChat = menu ? chats.find((chat) => chat.id === menu.chatId) : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-search-row">
        <input
          className="search"
          placeholder="Search Chats…"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
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
      <button type="button" hidden onClick={onNew} aria-hidden />
      <div className="chat-list" ref={scrollRef}>
        {rows.length > 0 || hasMore || loadingMore || loadError ? (
          <div
            className="chat-virtual-inner"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualRows.map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) {
                return (
                  <div
                    key="chat-list-footer"
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className="chat-virtual-row"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <div className="empty-side">
                      {loadingMore
                        ? "Loading chats…"
                        : loadError
                          ? <button type="button" onClick={onLoadMore}>Retry loading chats</button>
                          : null}
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={row.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  className="chat-virtual-row"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  {row.kind === "header" ? (
                    <div className="chat-group-label">{row.label}</div>
                  ) : (
                    <ChatItem
                      chat={row.chat}
                      active={row.chat.id === activeId && !settingsActive}
                      shortcutIndex={row.shortcutIndex}
                      showShortcuts={showShortcuts}
                      renaming={renamingId === row.chat.id}
                      renameValue={renameValue}
                      onRenameValue={setRenameValue}
                      onRenameEnd={() => setRenamingId(null)}
                      onRename={(title) => {
                        const trimmed = title.trim();
                        if (trimmed) onRename(row.chat.id, trimmed);
                        setRenamingId(null);
                      }}
                      onSelect={() => onSelect(row.chat.id)}
                      onMenu={(event) => openMenu(event, row.chat.id)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="empty-side">
            {query.trim() ? "No matching chats" : "No chats yet"}
          </div>
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

type ChatItemProps = {
  chat: Chat;
  active: boolean;
  shortcutIndex: number;
  showShortcuts: boolean;
  renaming: boolean;
  renameValue: string;
  onRenameValue: (value: string) => void;
  onRenameEnd: () => void;
  onRename: (title: string) => void;
  onSelect: () => void;
  onMenu: (event: React.MouseEvent) => void;
};

function ChatItem({
  chat,
  active,
  shortcutIndex,
  showShortcuts,
  renaming,
  renameValue,
  onRenameValue,
  onRenameEnd,
  onRename,
  onSelect,
  onMenu,
}: ChatItemProps) {
  const num = shortcutLabel(shortcutIndex);
  return (
    <div
      className={`chat-item ${active ? "active" : ""} ${showShortcuts && num ? "show-nums" : ""}`}
      onClick={onSelect}
      onContextMenu={onMenu}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect();
      }}
    >
      <div className="chat-item-body">
        {renaming ? (
          <input
            className="rename-input"
            value={renameValue}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onRenameValue(event.target.value)}
            onBlur={() => onRename(renameValue)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") onRename(renameValue);
              if (event.key === "Escape") onRenameEnd();
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
            onClick={onMenu}
          >
            ⋯
          </button>
        )}
      </div>
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
