import { useMemo } from "react";
import type { Chat } from "../lib/db";

function dayBucket(ts: number): string {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 86400000;
  const startWeek = startToday - 6 * 86400000;
  if (ts >= startToday) return "Today";
  if (ts >= startYesterday) return "Yesterday";
  if (ts >= startWeek) return "This Week";
  return "Older";
}

type Props = {
  chats: Chat[];
  activeId: string | null;
  query: string;
  onQuery: (q: string) => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
};

export function Sidebar({
  chats,
  activeId,
  query,
  onQuery,
  onSelect,
  onNew,
  onOpenSettings,
}: Props) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.preview.toLowerCase().includes(q),
    );
  }, [chats, query]);

  const groups = useMemo(() => {
    const map = new Map<string, Chat[]>();
    for (const chat of filtered) {
      const key = dayBucket(chat.updated_at);
      const list = map.get(key) ?? [];
      list.push(chat);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [filtered]);

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <input
          className="search"
          placeholder="Search Chats…"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <div className="sidebar-actions">
        <button type="button" className="ghost" onClick={onNew}>
          New Chat
        </button>
        <button type="button" className="ghost" onClick={onOpenSettings}>
          Settings
        </button>
      </div>
      <div className="chat-list">
        {groups.map(([label, items]) => (
          <div key={label} className="chat-group">
            <div className="chat-group-label">{label}</div>
            {items.map((chat) => (
              <button
                key={chat.id}
                type="button"
                className={`chat-item ${chat.id === activeId ? "active" : ""}`}
                onClick={() => onSelect(chat.id)}
              >
                <div className="chat-item-title">{chat.title}</div>
                <div className="chat-item-preview">{chat.preview}</div>
              </button>
            ))}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="empty-side">No chats yet</div>
        )}
      </div>
    </aside>
  );
}
