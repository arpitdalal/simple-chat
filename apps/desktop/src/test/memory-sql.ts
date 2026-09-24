/**
 * In-memory stand-in for @tauri-apps/plugin-sql used by the e2e harness.
 * Not a full SQL engine — enough for Simple Chat's query shapes.
 */
import type { Chat, Message, AppSettings } from "../lib/db";

type Row = Record<string, unknown>;
type MessageImageRow = { id: string; images: unknown };

const settings = new Map<string, string>();
let chats: Chat[] = [];
let messages: Message[] = [];
let tx: {
  settings: Map<string, string>;
  chats: Chat[];
  messages: Message[];
} | null = null;

export function resetMemoryDb() {
  settings.clear();
  chats = [];
  messages = [];
  tx = null;
}

function parseArgs(sql: string, args: unknown[] = []): unknown[] {
  return args;
}

function snapshot() {
  return {
    settings: new Map(settings),
    chats: chats.map((c) => ({ ...c })),
    messages: messages.map((m) => ({ ...m, images: [...m.images] })),
  };
}

function messageMetadata(message: Message): Message {
  return {
    ...message,
    images: [],
    image_count: message.image_count ?? message.images.length,
  };
}

class MemoryDatabase {
  async execute(query: string, bindValues: unknown[] = []) {
    const q = query.replace(/\s+/g, " ").trim();
    const args = parseArgs(q, bindValues);

    if (
      q.startsWith("CREATE ") ||
      q.startsWith("CREATE INDEX") ||
      q.startsWith("ALTER ") ||
      q.startsWith("PRAGMA ")
    ) {
      return { rowsAffected: 0 };
    }

    if (q === "BEGIN" || q.startsWith("BEGIN ")) {
      if (tx) throw new Error("nested transaction");
      tx = snapshot();
      return { rowsAffected: 0 };
    }

    if (q === "COMMIT") {
      tx = null;
      return { rowsAffected: 0 };
    }

    if (q === "ROLLBACK") {
      if (tx) {
        settings.clear();
        for (const [k, v] of tx.settings) settings.set(k, v);
        chats = tx.chats;
        messages = tx.messages;
        tx = null;
      }
      return { rowsAffected: 0 };
    }

    if (q.includes("INSERT INTO settings")) {
      for (let i = 0; i + 1 < args.length; i += 2) {
        settings.set(String(args[i]), String(args[i + 1]));
      }
      return { rowsAffected: Math.floor(args.length / 2) };
    }

    if (q.includes("INSERT INTO chats")) {
      chats.push({
        id: String(args[0]),
        title: String(args[1]),
        model_id: String(args[2]),
        provider: String(args[3]),
        created_at: Number(args[4]),
        updated_at: Number(args[5]),
        preview: String(args[6]),
        pinned: Number(args[7] ?? 0),
      });
      return { rowsAffected: 1 };
    }

    if (q.includes("INSERT INTO messages") && q.includes("randomblob(16)")) {
      const branchedId = String(args[0]);
      const sourceId = String(args[1]);
      const throughId = String(args[2]);
      const sourceMessages = messages
        .filter((candidate) => candidate.chat_id === sourceId)
        .sort((a, b) => a.created_at - b.created_at || messages.indexOf(a) - messages.indexOf(b));
      const throughIndex = sourceMessages.findIndex(
        (message) => message.id === throughId,
      );
      if (throughIndex < 0) throw new Error("Message not found");
      for (const message of sourceMessages.slice(0, throughIndex + 1)) {
        messages.push({ ...message, id: crypto.randomUUID(), chat_id: branchedId });
      }
      return { rowsAffected: throughIndex + 1 };
    }

    if (q.includes("INSERT INTO messages")) {
      const images = JSON.parse(String(args[4])) as string[];
      messages.push({
        id: String(args[0]),
        chat_id: String(args[1]),
        role: args[2] as Message["role"],
        content: String(args[3]),
        images,
        image_count: Number(args[5]),
        created_at: Number(args[6]),
      });
      return { rowsAffected: 1 };
    }

    if (q.includes("UPDATE chats SET title = $1, updated_at = $2")) {
      const id = String(args[2]);
      const i = chats.findIndex((c) => c.id === id && c.title === "New Chat");
      if (i >= 0) chats[i] = { ...chats[i], title: String(args[0]), updated_at: Number(args[1]) };
      return { rowsAffected: i >= 0 ? 1 : 0 };
    }

    if (q.includes("UPDATE chats SET updated_at = $2, preview = COALESCE")) {
      const id = String(args[0]);
      const i = chats.findIndex((c) => c.id === id);
      const latest = messages.filter((m) => m.chat_id === id)
        .sort((a, b) => b.created_at - a.created_at || messages.indexOf(b) - messages.indexOf(a))[0];
      if (i >= 0) {
        const preview = latest
          ? latest.content
            ? Array.from(latest.content).slice(0, 120).join("")
            : (latest.image_count ?? latest.images.length)
              ? "Image"
              : ""
          : "Ask AI anything…";
        chats[i] = { ...chats[i], updated_at: Number(args[1]), preview };
      }
      return { rowsAffected: i >= 0 ? 1 : 0 };
    }

    if (q.includes("UPDATE chats SET title = $1 WHERE id = $2 AND title = $3")) {
      const i = chats.findIndex((c) => c.id === String(args[1]) && c.title === String(args[2]));
      if (i >= 0) chats[i] = { ...chats[i], title: String(args[0]) };
      return { rowsAffected: i >= 0 ? 1 : 0 };
    }

    if (q.includes("UPDATE chats SET")) {
      const id = String(args[6]);
      const i = chats.findIndex((c) => c.id === id);
      if (i >= 0) {
        chats[i] = {
          ...chats[i],
          title: String(args[0]),
          preview: String(args[1]),
          model_id: String(args[2]),
          provider: String(args[3]),
          updated_at: Number(args[4]),
          pinned: Number(args[5] ?? 0),
        };
      }
      return { rowsAffected: i >= 0 ? 1 : 0 };
    }

    if (q.includes("DELETE FROM messages WHERE chat_id IN")) {
      const cutoff = Number(args[0]);
      const ids = new Set(chats.filter((c) => c.updated_at < cutoff).map((c) => c.id));
      messages = messages.filter((m) => !ids.has(m.chat_id));
      return { rowsAffected: 0 };
    }

    if (q.includes("DELETE FROM messages WHERE chat_id =") && q.includes("(created_at, rowid) >")) {
      const chatId = String(args[0]);
      const afterId = String(args[1]);
      const index = messages.findIndex((m) => m.id === afterId && m.chat_id === chatId);
      if (index < 0) return { rowsAffected: 0 };
      const before = messages.length;
      const anchor = messages[index];
      messages = messages.filter((m, i) => m.chat_id !== chatId || m.created_at < anchor.created_at || (m.created_at === anchor.created_at && i <= index));
      return { rowsAffected: before - messages.length };
    }

    if (q.includes("DELETE FROM messages WHERE id =")) {
      const id = String(args[0]);
      const before = messages.length;
      messages = messages.filter((m) => m.id !== id);
      return { rowsAffected: before - messages.length };
    }

    if (q.includes("DELETE FROM messages WHERE chat_id =")) {
      const id = String(args[0]);
      const before = messages.length;
      messages = messages.filter((m) => m.chat_id !== id);
      return { rowsAffected: before - messages.length };
    }

    if (q.includes("DELETE FROM chats WHERE updated_at <")) {
      const cutoff = Number(args[0]);
      const before = chats.length;
      chats = chats.filter((c) => c.updated_at >= cutoff);
      return { rowsAffected: before - chats.length };
    }

    if (q.includes("DELETE FROM chats WHERE id =")) {
      const id = String(args[0]);
      const before = chats.length;
      chats = chats.filter((c) => c.id !== id);
      return { rowsAffected: before - chats.length };
    }

    return { rowsAffected: 0 };
  }

  async select<T extends Row[]>(query: string, bindValues: unknown[] = []): Promise<T> {
    const q = query.replace(/\s+/g, " ").trim();
    const args = bindValues;

    if (/^PRAGMA journal_mode/i.test(q)) {
      return [{ journal_mode: "wal" }] as unknown as T;
    }

    if (/pragma_table_info\(['"]?chats['"]?\)/i.test(q)) {
      return [
        { name: "id" },
        { name: "title" },
        { name: "model_id" },
        { name: "provider" },
        { name: "created_at" },
        { name: "updated_at" },
        { name: "preview" },
        { name: "pinned" },
      ] as unknown as T;
    }

    if (q.includes("FROM settings")) {
      return [...settings.entries()].map(([key, value]) => ({ key, value })) as T;
    }

    if (q.includes("FROM chats WHERE id =")) {
      const id = String(args[0]);
      return chats.filter((c) => c.id === id) as unknown as T;
    }

    if (q.includes("FROM chats") && q.includes("ORDER BY pinned")) {
      return [...chats]
        .sort((a, b) => b.pinned - a.pinned || b.updated_at - a.updated_at)
        .slice(0, 200) as unknown as T;
    }

    if (q.includes("COUNT(*)") && q.includes("FROM messages")) {
      const chatId = String(args[0]);
      return [{ n: messages.filter((m) => m.chat_id === chatId).length }] as unknown as T;
    }

    if (q.includes("json_extract(images")) {
      const message = messages.find(
        (candidate) =>
          candidate.chat_id === String(args[0]) && candidate.id === String(args[1]),
      );
      return [{
        image: message?.images[Number(args[2])] ?? null,
      }] as unknown as T;
    }

    if (q.includes("SELECT id, images FROM (") && q.includes("total_chars")) {
      const chatId = String(args[0]);
      const fromId = String(args[1]);
      const throughId = String(args[2]);
      const maxChars = Number(args[3]);
      const maxImages = Number(args[4]);
      const sourceMessages = messages
        .filter((message) => message.chat_id === chatId)
        .sort((a, b) => a.created_at - b.created_at || messages.indexOf(a) - messages.indexOf(b));
      const fromIndex = sourceMessages.findIndex(
        (message) => message.id === fromId,
      );
      const throughIndex = sourceMessages.findIndex(
        (message) => message.id === throughId,
      );
      if (fromIndex < 0 || throughIndex < fromIndex) return [] as unknown as T;
      const source = sourceMessages
        .slice(fromIndex, throughIndex + 1)
        .reverse()
        .filter((message) => message.images.length);
      const selected: MessageImageRow[] = [];
      let chars = 0;
      let images = 0;
      for (const message of source) {
        const nextChars = chars + JSON.stringify(message.images).length;
        const nextImages = images + message.images.length;
        if (nextChars > maxChars || nextImages > maxImages) break;
        selected.push({ id: message.id, images: message.images });
        chars = nextChars;
        images = nextImages;
      }
      return selected as unknown as T;
    }

    if (q.includes("FROM messages") && q.includes("(created_at, rowid) <")) {
      const chatId = String(args[0]);
      const anchor = messages.find((m) => m.id === String(args[1]) && m.chat_id === chatId);
      if (!anchor) return [] as unknown as T;
      const index = messages.indexOf(anchor);
      const limit = Number(args[2] ?? 40);
      return messages
        .filter((m) => m.chat_id === chatId && (m.created_at < anchor.created_at || (m.created_at === anchor.created_at && messages.indexOf(m) < index)))
        .sort((a, b) => b.created_at - a.created_at || messages.indexOf(b) - messages.indexOf(a))
        .slice(0, limit)
        .map(messageMetadata) as unknown as T;
    }

    if (q.includes("FROM messages") && q.includes("ORDER BY created_at DESC")) {
      const chatId = String(args[0]);
      const limit = Number(args[1] ?? 50);
      return messages
        .filter((m) => m.chat_id === chatId)
        .sort((a, b) => b.created_at - a.created_at || messages.indexOf(b) - messages.indexOf(a))
        .slice(0, limit)
        .map(messageMetadata) as unknown as T;
    }

    if (q.includes("FROM messages")) {
      const chatId = String(args[0]);
      return messages
        .filter((m) => m.chat_id === chatId)
        .sort((a, b) => a.created_at - b.created_at || messages.indexOf(a) - messages.indexOf(b))
        .map(messageMetadata) as unknown as T;
    }

    return [] as unknown as T;
  }
}

const db = new MemoryDatabase();

export default {
  load: async () => db,
};

export type { AppSettings };
