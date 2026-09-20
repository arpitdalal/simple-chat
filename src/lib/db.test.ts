import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => import("../test/memory-sql"));

import {
  createChat,
  deleteChat,
  getChat,
  listChats,
  listRecentMessages,
  addMessage,
  listOlderMessages,
  setSetting,
  getSettings,
} from "./db";
import { resetMemoryDb } from "../test/memory-sql";

describe("db (memory sql integration)", () => {
  beforeEach(() => {
    resetMemoryDb();
    // reset module-level dbPromise by re-importing is hard; memory db is singleton reset
  });

  it("creates and lists chats", async () => {
    const a = await createChat("google", "gemini-3.8-flash");
    expect(a.title).toBe("New Chat");
    const list = await listChats();
    expect(list.map((c) => c.id)).toContain(a.id);
    expect(await getChat(a.id)).toMatchObject({ id: a.id, provider: "google" });
  });

  it("pages recent and older messages", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    const times = [100, 200, 300, 400, 500];
    for (const t of times) {
      vi.spyOn(Date, "now").mockReturnValue(t);
      await addMessage(chat.id, "user", `m${t}`);
    }
    vi.spyOn(Date, "now").mockRestore();

    // fix created_at by direct re-add is awkward; memory uses Date.now at insert.
    // Re-seed with controlled timestamps via multiple adds after mocking now each time — already done.
    const recent = await listRecentMessages(chat.id, 2);
    expect(recent).toHaveLength(2);
    expect(recent[0].content).toBe("m400");
    expect(recent[1].content).toBe("m500");

    const older = await listOlderMessages(chat.id, recent[0].created_at, 10);
    expect(older.map((m) => m.content)).toEqual(["m100", "m200", "m300"]);
  });

  it("deletes chat and persists settings", async () => {
    const chat = await createChat("openai", "gpt-4o");
    await deleteChat(chat.id);
    expect(await getChat(chat.id)).toBeNull();
    await setSetting("resume_minutes", 9);
    const s = await getSettings();
    expect(s.resume_minutes).toBe(9);
  });
});
