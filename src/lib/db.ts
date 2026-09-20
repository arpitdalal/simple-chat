import Database from "@tauri-apps/plugin-sql";

export type Chat = {
  id: string;
  title: string;
  model_id: string;
  provider: string;
  created_at: number;
  updated_at: number;
  preview: string;
  pinned: number;
};

export type Message = {
  id: string;
  chat_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
};

export type AppSettings = {
  resume_minutes: number;
  always_on_top: boolean;
  show_tray: boolean;
  default_provider: string;
  default_model: string;
  last_opened_at: number;
  last_chat_id: string | null;
  web_search: boolean;
  hotkey: string;
};

const DEFAULT_SETTINGS: AppSettings = {
  resume_minutes: 5,
  always_on_top: true,
  show_tray: true,
  default_provider: "openai",
  default_model: "gpt-5.6-luna",
  last_opened_at: 0,
  last_chat_id: null,
  web_search: true,
  hotkey: "CommandOrControl+Shift+Space",
};

let dbPromise: Promise<Database> | null = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:simple-chat.db").then(async (db) => {
      await prepareDb(db);
      return db;
    });
  }
  return dbPromise;
}

/**
 * Connection setup after load (migrations run in Rust via tauri-plugin-sql).
 * WAL cannot live in sqlx migrations — SQLite rejects journal_mode inside a txn.
 */
export async function prepareDb(db: Database) {
  await db.execute("PRAGMA journal_mode=WAL;");
  // Bridge: DBs created by the old JS CREATE (no pinned) before formal migrations.
  try {
    await db.execute(
      `ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/duplicate column/i.test(msg)) throw err;
  }
}

export async function getSettings(): Promise<AppSettings> {
  const db = await getDb();
  const rows = await db.select<{ key: string; value: string }[]>(
    "SELECT key, value FROM settings",
  );
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const key = row.key as keyof AppSettings;
    if (!(key in DEFAULT_SETTINGS)) continue;
    try {
      (settings as Record<string, unknown>)[key] = JSON.parse(row.value);
    } catch {
      /* ignore bad rows */
    }
  }
  return settings;
}

export async function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
) {
  const db = await getDb();
  await db.execute(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

export async function listChats(): Promise<Chat[]> {
  const db = await getDb();
  const rows = await db.select<Chat[]>(
    "SELECT * FROM chats ORDER BY pinned DESC, updated_at DESC LIMIT 200",
  );
  return rows.map((c) => ({ ...c, pinned: c.pinned ? 1 : 0 }));
}

export async function getChat(id: string): Promise<Chat | null> {
  const db = await getDb();
  const rows = await db.select<Chat[]>("SELECT * FROM chats WHERE id = $1", [
    id,
  ]);
  return rows[0] ?? null;
}

export async function createChat(
  provider: string,
  modelId: string,
): Promise<Chat> {
  const db = await getDb();
  const now = Date.now();
  const chat: Chat = {
    id: crypto.randomUUID(),
    title: "New Chat",
    model_id: modelId,
    provider,
    created_at: now,
    updated_at: now,
    preview: "Ask AI anything…",
    pinned: 0,
  };
  await db.execute(
    `INSERT INTO chats (id, title, model_id, provider, created_at, updated_at, preview, pinned)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      chat.id,
      chat.title,
      chat.model_id,
      chat.provider,
      chat.created_at,
      chat.updated_at,
      chat.preview,
      chat.pinned,
    ],
  );
  return chat;
}

export async function updateChat(
  id: string,
  patch: Partial<
    Pick<Chat, "title" | "preview" | "model_id" | "provider" | "pinned">
  >,
) {
  const db = await getDb();
  const current = await getChat(id);
  if (!current) return;
  // Only message activity (preview) reorders the sidebar — pin/rename/model keep place.
  const updated_at = "preview" in patch ? Date.now() : current.updated_at;
  const next = { ...current, ...patch, updated_at };
  await db.execute(
    `UPDATE chats SET title=$1, preview=$2, model_id=$3, provider=$4, updated_at=$5, pinned=$6 WHERE id=$7`,
    [
      next.title,
      next.preview,
      next.model_id,
      next.provider,
      next.updated_at,
      next.pinned ?? 0,
      id,
    ],
  );
}

export async function deleteChat(id: string) {
  const db = await getDb();
  await db.execute("DELETE FROM messages WHERE chat_id = $1", [id]);
  await db.execute("DELETE FROM chats WHERE id = $1", [id]);
}

export async function deleteChatsOlderThan(days: number) {
  const db = await getDb();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  await db.execute(
    "DELETE FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE updated_at < $1)",
    [cutoff],
  );
  await db.execute("DELETE FROM chats WHERE updated_at < $1", [cutoff]);
}

export async function listMessages(chatId: string): Promise<Message[]> {
  const db = await getDb();
  return db.select<Message[]>(
    "SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC",
    [chatId],
  );
}

/** Latest page (oldest→newest within page). */
export async function listRecentMessages(
  chatId: string,
  limit = 50,
): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.select<Message[]>(
    `SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [chatId, limit],
  );
  return rows.reverse();
}

/** Older page before a timestamp (oldest→newest within page). */
export async function listOlderMessages(
  chatId: string,
  beforeCreatedAt: number,
  limit = 40,
): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.select<Message[]>(
    `SELECT * FROM messages
     WHERE chat_id = $1 AND created_at < $2
     ORDER BY created_at DESC LIMIT $3`,
    [chatId, beforeCreatedAt, limit],
  );
  return rows.reverse();
}

export async function addMessage(
  chatId: string,
  role: Message["role"],
  content: string,
  createdAt = Date.now(),
): Promise<Message> {
  const db = await getDb();
  const msg: Message = {
    id: crypto.randomUUID(),
    chat_id: chatId,
    role,
    content,
    created_at: createdAt,
  };
  await db.execute(
    `INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [msg.id, msg.chat_id, msg.role, msg.content, msg.created_at],
  );
  return msg;
}

/** New chat with messages up through `throughMessageId` (inclusive). */
export async function branchChat(
  sourceChatId: string,
  throughMessageId: string,
): Promise<Chat> {
  const source = await getChat(sourceChatId);
  if (!source) throw new Error("Chat not found");
  const all = await listMessages(sourceChatId);
  const idx = all.findIndex((m) => m.id === throughMessageId);
  if (idx < 0) throw new Error("Message not found");
  const keep = all.slice(0, idx + 1);

  const branched = await createChat(source.provider, source.model_id);
  const base =
    source.title && source.title !== "New Chat" ? source.title : "Chat";
  const title = `Branch · ${base}`.slice(0, 60);
  const last = keep[keep.length - 1];
  const preview = last?.content.slice(0, 120) || "Ask AI anything…";
  await updateChat(branched.id, { title, preview });

  for (const m of keep) {
    await addMessage(branched.id, m.role, m.content, m.created_at);
  }
  return (await getChat(branched.id)) ?? branched;
}

/** Delete every message after `afterMessageId` in that chat (keeps the message itself). */
export async function deleteMessagesAfter(
  chatId: string,
  afterMessageId: string,
): Promise<void> {
  const all = await listMessages(chatId);
  const idx = all.findIndex((m) => m.id === afterMessageId);
  if (idx < 0) return;
  const db = await getDb();
  for (const m of all.slice(idx + 1)) {
    await db.execute("DELETE FROM messages WHERE id = $1", [m.id]);
  }
}

export async function clearChatMessages(chatId: string) {
  const db = await getDb();
  await db.execute("DELETE FROM messages WHERE chat_id = $1", [chatId]);
  await updateChat(chatId, { preview: "Ask AI anything…", title: "New Chat" });
}

export async function messageCount(chatId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) as n FROM messages WHERE chat_id = $1",
    [chatId],
  );
  return rows[0]?.n ?? 0;
}

import { isEmptyNewChat, resolveStartupMode } from "./chats";

/** Resume last chat if opened within resume_minutes; else new chat. */
export async function resolveStartupChat(
  settings: AppSettings,
): Promise<"resume" | "new"> {
  return resolveStartupMode(settings);
}

/**
 * Prefer resume; if opening "new", reuse an empty New Chat instead of spawning orphans.
 */
export async function openOrCreateChat(
  settings: AppSettings,
): Promise<Chat> {
  const mode = await resolveStartupChat(settings);
  if (mode === "resume" && settings.last_chat_id) {
    const existing = await getChat(settings.last_chat_id);
    if (existing) return existing;
  }

  if (settings.last_chat_id) {
    const last = await getChat(settings.last_chat_id);
    if (last && isEmptyNewChat(last) && (await messageCount(last.id)) === 0) {
      return last;
    }
  }

  return createChat(settings.default_provider, settings.default_model);
}
