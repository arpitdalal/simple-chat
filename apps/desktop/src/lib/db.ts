import Database from "@tauri-apps/plugin-sql";
import {
  EMPTY_CHAT_PREVIEW,
  isEmptyNewChat,
  NEW_CHAT_TITLE,
  resolveStartupMode,
} from "./chats";

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

export function chatMatchesQuery(chat: Pick<Chat, "title" | "preview">, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return !normalized ||
    chat.title.toLowerCase().includes(normalized) ||
    chat.preview.toLowerCase().includes(normalized);
}

export type Message = {
  id: string;
  chat_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  images: string[];
  image_count?: number;
  created_at: number;
};

type MessageImageRow = { id: string; images: unknown };
type MessageImageResult = { id: string; image: string | null };

const MESSAGE_COLUMNS = `id, chat_id, role, content, image_count, created_at`;

function parseImages(value: unknown): string[] {
  let images: unknown = value;
  if (typeof images === "string") {
    try {
      images = JSON.parse(images);
    } catch {
      images = [];
    }
  }
  return Array.isArray(images)
    ? images.filter((image): image is string => typeof image === "string")
    : [];
}

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
  /** True after the first-run login-item prompt (or a Settings toggle). */
  autostart_prompted: boolean;
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
  autostart_prompted: false,
};

let dbPromise: Promise<Database> | null = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = Database.load("sqlite:simple-chat.db")
      .then(async (db) => {
        await prepareDb(db);
        return db;
      })
      .catch((err) => {
        dbPromise = null;
        throw err;
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
  const modeRows = await db.select<{ journal_mode: string }[]>(
    "PRAGMA journal_mode;",
  );
  const mode = String(modeRows[0]?.journal_mode ?? "").toLowerCase();
  if (mode !== "wal") {
    throw new Error(
      `SQLite journal_mode is ${mode || "unknown"}, expected wal`,
    );
  }

  // Bridge: DBs created by the old JS CREATE (no pinned) before formal migrations.
  const cols = await db.select<{ name: string }[]>(
    "SELECT name FROM pragma_table_info('chats')",
  );
  if (!cols.some((c) => c.name === "pinned")) {
    await db.execute(
      `ALTER TABLE chats ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`,
    );
  }

  const searchRows = await db.select<{ id: string; title: string; preview: string }[]>(
    "SELECT id, title, preview FROM chats WHERE search_normalized = 0",
  );
  for (let offset = 0; offset < searchRows.length; offset += 50) {
    await Promise.all(
      searchRows.slice(offset, offset + 50).map((row) =>
        db.execute(
          "UPDATE chats SET title_search = $1, preview_search = $2, search_normalized = 1 WHERE id = $3",
          [row.title.toLowerCase(), row.preview.toLowerCase(), row.id],
        ),
      ),
    );
  }
}

export async function getSettings(): Promise<AppSettings> {
  return runSettingsWrite(() => readSettings());
}

async function readSettings(): Promise<AppSettings> {
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

/** Serialize settings writes so App/Settings defaults cannot interleave mid-pair. */
let settingsWriteTail: Promise<unknown> = Promise.resolve();

function runSettingsWrite<T>(op: () => Promise<T>): Promise<T> {
  const next = settingsWriteTail.catch(() => undefined).then(op);
  settingsWriteTail = next;
  return next as Promise<T>;
}

async function writeSetting<K extends keyof AppSettings>(
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

export async function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
) {
  return runSettingsWrite(() => writeSetting(key, value));
}

/**
 * Write default provider+model together. If `onlyIf` is set, skip when live
 * defaults already differ (Settings won the race).
 */
export async function setDefaultModel(
  provider: string,
  modelId: string,
  onlyIf?: { provider: string; modelId: string },
): Promise<AppSettings> {
  return runSettingsWrite(async () => {
    const live = await readSettings();
    if (
      onlyIf &&
      (live.default_provider !== onlyIf.provider ||
        live.default_model !== onlyIf.modelId)
    ) {
      return live;
    }
    if (
      live.default_provider === provider &&
      live.default_model === modelId
    ) {
      return live;
    }
    // One execute — pool-safe atomic upsert (BEGIN/COMMIT across executes is not).
    const db = await getDb();
    await db.execute(
      `INSERT INTO settings (key, value) VALUES ($1, $2), ($3, $4)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [
        "default_provider",
        JSON.stringify(provider),
        "default_model",
        JSON.stringify(modelId),
      ],
    );
    return {
      ...live,
      default_provider: provider,
      default_model: modelId,
    };
  });
}

export type ChatCursor = Pick<Chat, "id" | "updated_at" | "pinned">;
export type ChatPage = {
  chats: Chat[];
  cursor: ChatCursor | null;
  hasMore: boolean;
};

export async function listChatPage(
  options: { limit?: number; cursor?: ChatCursor | null; query?: string } = {},
): Promise<ChatPage> {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 250));
  const query = options.query?.trim() ?? "";
  const args: unknown[] = [limit + 1];
  const conditions: string[] = [];

  if (options.cursor) {
    args.push(
      options.cursor.pinned ? 1 : 0,
      options.cursor.updated_at,
      options.cursor.id,
    );
    conditions.push("(pinned, updated_at, id) < ($2, $3, $4)");
  }
  if (query) {
    args.push(query.toLowerCase());
    const queryParameter = `$${args.length}`;
    conditions.push(
      `(instr(title_search, ${queryParameter}) > 0 OR instr(preview_search, ${queryParameter}) > 0)`,
    );
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const db = await getDb();
  const rows = await db.select<Chat[]>(
    `SELECT * FROM chats ${where}
     ORDER BY pinned DESC, updated_at DESC, id DESC
     LIMIT $1`,
    args,
  );
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).map((chat) => ({
    ...chat,
    pinned: chat.pinned ? 1 : 0,
  }));
  const last = page[page.length - 1];
  return {
    chats: page,
    cursor: hasMore && last
      ? { id: last.id, updated_at: last.updated_at, pinned: last.pinned }
      : null,
    hasMore,
  };
}

export async function listChats(): Promise<Chat[]> {
  return (await listChatPage({ limit: 200 })).chats;
}

export async function listReusableChats(limit = 20): Promise<Chat[]> {
  const db = await getDb();
  const rows = await db.select<Chat[]>(
    `SELECT chats.* FROM chats
     WHERE chats.title = '${NEW_CHAT_TITLE}'
       AND (trim(chats.preview) = '' OR chats.preview = '${EMPTY_CHAT_PREVIEW}')
       AND NOT EXISTS (
         SELECT 1 FROM messages WHERE messages.chat_id = chats.id
       )
     ORDER BY chats.pinned DESC, chats.updated_at DESC, chats.id DESC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 100))],
  );
  return rows.map((chat) => ({ ...chat, pinned: chat.pinned ? 1 : 0 }));
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
    title: NEW_CHAT_TITLE,
    model_id: modelId,
    provider,
    created_at: now,
    updated_at: now,
    preview: EMPTY_CHAT_PREVIEW,
    pinned: 0,
  };
  await db.execute(
    `INSERT INTO chats (
       id, title, model_id, provider, created_at, updated_at, preview, pinned,
       title_search, preview_search, search_normalized
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)`,
    [
      chat.id,
      chat.title,
      chat.model_id,
      chat.provider,
      chat.created_at,
      chat.updated_at,
      chat.preview,
      chat.pinned,
      chat.title.toLowerCase(),
      chat.preview.toLowerCase(),
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
  if (!current) throw new Error("Chat not found");
  // Only message activity (preview) reorders the sidebar — pin/rename/model keep place.
  const updated_at = "preview" in patch ? Date.now() : current.updated_at;
  const next = { ...current, ...patch, updated_at };
  const result = await db.execute(
    `UPDATE chats SET
       title=$1, preview=$2, model_id=$3, provider=$4, updated_at=$5,
       pinned=$6, title_search=$7, preview_search=$8, search_normalized=1
     WHERE id=$9`,
    [
      next.title,
      next.preview,
      next.model_id,
      next.provider,
      next.updated_at,
      next.pinned ?? 0,
      next.title.toLowerCase(),
      next.preview.toLowerCase(),
      id,
    ],
  );
  if (result.rowsAffected === 0) throw new Error("Chat no longer exists");
  return next;
}

/** Set the first prompt title only while this is still an unnamed chat. */
export async function setInitialChatTitle(id: string, title: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE chats SET
       title = $1, title_search = $2, updated_at = $3, search_normalized = 1
     WHERE id = $4 AND title = '${NEW_CHAT_TITLE}'`,
    [title, title.toLowerCase(), Date.now(), id],
  );
  return result.rowsAffected > 0;
}

/** Recompute preview from stored messages so delayed writes cannot restore an old preview. */
export async function refreshChatPreview(id: string): Promise<void> {
  const db = await getDb();
  const updatedAt = Date.now();
  const result = await db.execute(
    `UPDATE chats SET updated_at = $2, preview = COALESCE(
       (SELECT CASE
          WHEN content = '' AND image_count > 0 THEN 'Image'
          ELSE substr(content, 1, 120)
        END
        FROM messages WHERE chat_id = $1 ORDER BY created_at DESC, rowid DESC LIMIT 1),
       '${EMPTY_CHAT_PREVIEW}'
     ) WHERE id = $1`,
    [id, updatedAt],
  );
  if (result.rowsAffected === 0) return;
  const rows = await db.select<{ preview: string }[]>(
    "SELECT preview FROM chats WHERE id = $1",
    [id],
  );
  const preview = rows[0]?.preview;
  if (preview !== undefined) {
    await db.execute(
      `UPDATE chats SET preview_search = $2, search_normalized = 1
       WHERE id = $1 AND preview = $3 AND updated_at = $4`,
      [id, preview.toLowerCase(), preview, updatedAt],
    );
  }
}

/** A generated title must not overwrite a later manual rename or Clear. */
export async function replaceChatTitle(id: string, previous: string, title: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    "UPDATE chats SET title = $1, title_search = $2, search_normalized = 1 WHERE id = $3 AND title = $4",
    [title, title.toLowerCase(), id, previous],
  );
  return result.rowsAffected > 0;
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
  const rows = await db.select<Message[]>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE chat_id = $1 ORDER BY created_at ASC, rowid ASC`,
    [chatId],
  );
  return rows.map((message) => ({ ...message, images: [] }));
}

/** Latest page (oldest→newest within page). */
export async function listRecentMessages(
  chatId: string,
  limit = 50,
): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.select<Message[]>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE chat_id = $1 ORDER BY created_at DESC, rowid DESC LIMIT $2`,
    [chatId, limit],
  );
  return rows.reverse().map((message) => ({ ...message, images: [] }));
}

/** Older page before a message in (created_at, rowid) order. */
export async function listOlderMessages(
  chatId: string,
  beforeMessageId: string,
  limit = 40,
): Promise<Message[]> {
  const db = await getDb();
  const rows = await db.select<Message[]>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE chat_id = $1 AND (created_at, rowid) <
       (SELECT created_at, rowid FROM messages WHERE id = $2 AND chat_id = $1)
     ORDER BY created_at DESC, rowid DESC LIMIT $3`,
    [chatId, beforeMessageId, limit],
  );
  return rows.reverse().map((message) => ({ ...message, images: [] }));
}

export async function loadMessageImage(
  chatId: string,
  messageId: string,
  index: number,
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<MessageImageResult[]>(
    `SELECT json_extract(images, '$[' || $3 || ']') AS image
     FROM messages WHERE chat_id = $1 AND id = $2 LIMIT 1`,
    [chatId, messageId, index],
  );
  return rows[0]?.image ?? null;
}

export async function loadMessageImages(
  chatId: string,
  fromMessageId: string,
  throughMessageId: string,
  maxChars: number,
  maxImages: number,
): Promise<Map<string, string[]>> {
  const db = await getDb();
  const rows = await db.select<MessageImageRow[]>(
    `SELECT id, images FROM (
       SELECT id, images, created_at, rowid,
         SUM(length(images)) OVER (
           ORDER BY created_at DESC, rowid DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS total_chars,
         SUM(image_count) OVER (
           ORDER BY created_at DESC, rowid DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) AS total_images
       FROM messages
       WHERE chat_id = $1 AND image_count > 0
         AND (created_at, rowid) >=
           (SELECT created_at, rowid FROM messages WHERE id = $2 AND chat_id = $1)
         AND (created_at, rowid) <=
           (SELECT created_at, rowid FROM messages WHERE id = $3 AND chat_id = $1)
     )
     WHERE total_chars <= $4 AND total_images <= $5
     ORDER BY created_at DESC, rowid DESC`,
    [chatId, fromMessageId, throughMessageId, maxChars, maxImages],
  );
  return new Map(rows.map((row) => [row.id, parseImages(row.images)]));
}

export async function addMessage(
  chatId: string,
  role: Message["role"],
  content: string,
  createdAt = Date.now(),
  images: string[] = [],
): Promise<Message> {
  const db = await getDb();
  const msg: Message = {
    id: crypto.randomUUID(),
    chat_id: chatId,
    role,
    content,
    images,
    image_count: images.length,
    created_at: createdAt,
  };
  await db.execute(
    `INSERT INTO messages (id, chat_id, role, content, images, image_count, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      msg.id,
      msg.chat_id,
      msg.role,
      msg.content,
      JSON.stringify(msg.images),
      msg.images.length,
      msg.created_at,
    ],
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
  const base =
    source.title && source.title !== NEW_CHAT_TITLE ? source.title : "Chat";
  const title = `Branch · ${base}`.slice(0, 60);
  const last = keep[keep.length - 1];
  const preview = last?.content
    ? last.content.slice(0, 120)
    : last?.image_count
      ? "Image"
      : EMPTY_CHAT_PREVIEW;
  const branched = await createChat(source.provider, source.model_id);
  try {
    await updateChat(branched.id, { title, preview });
    const db = await getDb();
    const copied = await db.execute(
      `INSERT INTO messages (id, chat_id, role, content, images, image_count, created_at)
       SELECT lower(hex(randomblob(16))), $1, role, content, images, image_count, created_at
       FROM messages
       WHERE chat_id = $2 AND (created_at, rowid) <=
         (SELECT created_at, rowid FROM messages WHERE id = $3 AND chat_id = $2)
       ORDER BY created_at, rowid`,
      [branched.id, sourceChatId, throughMessageId],
    );
    if (copied.rowsAffected === 0) throw new Error("Message not found");
    return (await getChat(branched.id)) ?? { ...branched, title, preview };
  } catch (error) {
    try {
      const db = await getDb();
      await db.execute("DELETE FROM chats WHERE id = $1", [branched.id]);
    } catch (cleanupError) {
      throw new Error(
        `Failed to create branch and clean up the incomplete chat: ${String(cleanupError)}`,
      );
    }
    throw error;
  }
}

/** Delete every message after `afterMessageId` in that chat (keeps the message itself). */
export async function deleteMessagesAfter(
  chatId: string,
  afterMessageId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM messages WHERE chat_id = $1
     AND (created_at, rowid) >
       (SELECT created_at, rowid FROM messages WHERE id = $2 AND chat_id = $1)`,
    [chatId, afterMessageId],
  );
}

export async function clearChatMessages(chatId: string) {
  const db = await getDb();
  await db.execute("DELETE FROM messages WHERE chat_id = $1", [chatId]);
  return updateChat(chatId, {
    preview: EMPTY_CHAT_PREVIEW,
    title: NEW_CHAT_TITLE,
  });
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
