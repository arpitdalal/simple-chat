import Database from "@tauri-apps/plugin-sql";

export type Chat = {
  id: string;
  title: string;
  model_id: string;
  provider: string;
  created_at: number;
  updated_at: number;
  preview: string;
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
};

const DEFAULT_SETTINGS: AppSettings = {
  resume_minutes: 5,
  always_on_top: false,
  show_tray: true,
  default_provider: "openai",
  default_model: "gpt-4o-mini",
  last_opened_at: 0,
  last_chat_id: null,
  web_search: false,
};

let dbPromise: Promise<Database> | null = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:simple-chat.db").then(async (db) => {
      await migrate(db);
      return db;
    });
  }
  return dbPromise;
}

async function migrate(db: Database) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS chats (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      model_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      preview TEXT NOT NULL DEFAULT ''
    );
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY NOT NULL,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
    );
  `);
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);`,
  );
  await db.execute(
    `CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats(updated_at DESC);`,
  );
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
  return db.select<Chat[]>(
    "SELECT * FROM chats ORDER BY updated_at DESC LIMIT 200",
  );
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
  };
  await db.execute(
    `INSERT INTO chats (id, title, model_id, provider, created_at, updated_at, preview)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      chat.id,
      chat.title,
      chat.model_id,
      chat.provider,
      chat.created_at,
      chat.updated_at,
      chat.preview,
    ],
  );
  return chat;
}

export async function updateChat(
  id: string,
  patch: Partial<Pick<Chat, "title" | "preview" | "model_id" | "provider">>,
) {
  const db = await getDb();
  const current = await getChat(id);
  if (!current) return;
  const next = { ...current, ...patch, updated_at: Date.now() };
  await db.execute(
    `UPDATE chats SET title=$1, preview=$2, model_id=$3, provider=$4, updated_at=$5 WHERE id=$6`,
    [
      next.title,
      next.preview,
      next.model_id,
      next.provider,
      next.updated_at,
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

export async function addMessage(
  chatId: string,
  role: Message["role"],
  content: string,
): Promise<Message> {
  const db = await getDb();
  const msg: Message = {
    id: crypto.randomUUID(),
    chat_id: chatId,
    role,
    content,
    created_at: Date.now(),
  };
  await db.execute(
    `INSERT INTO messages (id, chat_id, role, content, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [msg.id, msg.chat_id, msg.role, msg.content, msg.created_at],
  );
  return msg;
}

export async function messageCount(chatId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) as n FROM messages WHERE chat_id = $1",
    [chatId],
  );
  return rows[0]?.n ?? 0;
}

/** Resume last chat if opened within resume_minutes; else new chat. */
export async function resolveStartupChat(
  settings: AppSettings,
): Promise<"resume" | "new"> {
  if (!settings.last_chat_id) return "new";
  const ageMs = Date.now() - settings.last_opened_at;
  if (ageMs <= settings.resume_minutes * 60 * 1000) return "resume";
  return "new";
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
    if (last && last.title === "New Chat" && (await messageCount(last.id)) === 0) {
      return last;
    }
  }

  return createChat(settings.default_provider, settings.default_model);
}
