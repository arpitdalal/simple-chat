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
  listMessages,
  setSetting,
  getSettings,
  updateChat,
  branchChat,
  deleteMessagesAfter,
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

  it("pin/unpin preserves updated_at so order stays chronological", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const older = await createChat("google", "gemini-3.8-flash");
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const newer = await createChat("google", "gemini-3.8-flash");
    vi.spyOn(Date, "now").mockReturnValue(3_000);
    await updateChat(newer.id, { preview: "fresh" });

    vi.spyOn(Date, "now").mockReturnValue(9_000);
    await updateChat(older.id, { pinned: 1 });
    await updateChat(older.id, { pinned: 0 });

    const after = await getChat(older.id);
    expect(after?.updated_at).toBe(1_000);
    expect(after?.pinned).toBe(0);
    const list = await listChats();
    expect(list.map((c) => c.id)).toEqual([newer.id, older.id]);
    vi.spyOn(Date, "now").mockRestore();
  });

  it("branchChat copies messages through the selected one inclusive", async () => {
    const source = await createChat("google", "gemini-3.8-flash");
    await updateChat(source.id, { title: "Parent", preview: "c" });
    vi.spyOn(Date, "now").mockReturnValue(10);
    const a = await addMessage(source.id, "user", "one", 10);
    vi.spyOn(Date, "now").mockReturnValue(20);
    const b = await addMessage(source.id, "assistant", "two", 20);
    vi.spyOn(Date, "now").mockReturnValue(30);
    await addMessage(source.id, "user", "three", 30);
    vi.spyOn(Date, "now").mockRestore();

    const branched = await branchChat(source.id, b.id);
    expect(branched.id).not.toBe(source.id);
    expect(branched.title).toMatch(/^Branch · Parent/);
    const msgs = await listMessages(branched.id);
    expect(msgs.map((m) => m.content)).toEqual(["one", "two"]);
    expect(msgs.map((m) => m.created_at)).toEqual([10, 20]);
    // source unchanged
    const orig = await listMessages(source.id);
    expect(orig).toHaveLength(3);
  });

  it("deleteMessagesAfter keeps the anchor and drops the rest", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    const a = await addMessage(chat.id, "user", "one", 10);
    await addMessage(chat.id, "assistant", "two", 20);
    await addMessage(chat.id, "user", "three", 30);
    await deleteMessagesAfter(chat.id, a.id);
    expect((await listMessages(chat.id)).map((m) => m.content)).toEqual(["one"]);
  });
});
