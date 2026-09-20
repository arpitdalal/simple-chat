/**
 * In-memory stand-in for @tauri-apps/plugin-sql used by the e2e harness.
 * Not a full SQL engine — enough for Simple Chat's query shapes.
 */
import type { Chat, Message, AppSettings } from "../lib/db";

type Row = Record<string, unknown>;

const settings = new Map<string, string>();
let chats: Chat[] = [];
let messages: Message[] = [];

export function resetMemoryDb() {
  settings.clear();
  chats = [];
  messages = [];
}

function parseArgs(sql: string, args: unknown[] = []): unknown[] {
  return args;
}

class MemoryDatabase {
  async execute(query: string, bindValues: unknown[] = []) {
    const q = query.replace(/\s+/g, " ").trim();
    const args = parseArgs(q, bindValues);

    if (q.startsWith("CREATE ") || q.startsWith("CREATE INDEX") || q.startsWith("ALTER ")) {
      return { rowsAffected: 0 };
    }

    if (q.includes("INSERT INTO settings")) {
      const key = String(args[0]);
      const value = String(args[1]);
      settings.set(key, value);
      return { rowsAffected: 1 };
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

    if (q.includes("INSERT INTO messages")) {
      messages.push({
        id: String(args[0]),
        chat_id: String(args[1]),
        role: args[2] as Message["role"],
        content: String(args[3]),
        created_at: Number(args[4]),
      });
      return { rowsAffected: 1 };
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

    if (q.includes("FROM messages") && q.includes("created_at <")) {
      const chatId = String(args[0]);
      const before = Number(args[1]);
      const limit = Number(args[2] ?? 40);
      return messages
        .filter((m) => m.chat_id === chatId && m.created_at < before)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit) as unknown as T;
    }

    if (q.includes("FROM messages") && q.includes("ORDER BY created_at DESC LIMIT")) {
      const chatId = String(args[0]);
      const limit = Number(args[1] ?? 50);
      return messages
        .filter((m) => m.chat_id === chatId)
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit) as unknown as T;
    }

    if (q.includes("FROM messages")) {
      const chatId = String(args[0]);
      return messages
        .filter((m) => m.chat_id === chatId)
        .sort((a, b) => a.created_at - b.created_at) as unknown as T;
    }

    return [] as unknown as T;
  }
}

const db = new MemoryDatabase();

export default {
  load: async () => db,
};

export type { AppSettings };
