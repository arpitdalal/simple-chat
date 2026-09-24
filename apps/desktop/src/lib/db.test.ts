import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => import("../test/memory-sql"));

import {
  createChat,
  deleteChat,
  getChat,
  listChats,
  listChatPage,
  listReusableChats,
  listRecentMessages,
  addMessage,
  listOlderMessages,
  listMessages,
  loadMessageImage,
  loadMessageImages,
  setSetting,
  setDefaultModel,
  getSettings,
  updateChat,
  branchChat,
  deleteMessagesAfter,
  setInitialChatTitle,
  replaceChatTitle,
  refreshChatPreview,
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

  it("lazily pages through every chat with stable cursors", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      for (let i = 0; i < 205; i++) {
        await createChat("google", "gemini-3.8-flash");
      }
      const first = await listChatPage({ limit: 100 });
      expect(first.chats).toHaveLength(100);
      expect(first.hasMore).toBe(true);
      expect(first.cursor).toEqual({
        id: first.chats[99].id,
        pinned: 0,
        updated_at: first.chats[99].updated_at,
      });

      const second = await listChatPage({ limit: 100, cursor: first.cursor });
      const third = await listChatPage({ limit: 100, cursor: second.cursor });
      const ids = [...first.chats, ...second.chats, ...third.chats].map(
        (chat) => chat.id,
      );
      expect(ids).toHaveLength(205);
      expect(new Set(ids).size).toBe(205);
      expect(third.hasMore).toBe(false);
    } finally {
      vi.spyOn(Date, "now").mockRestore();
    }
  });

  it("groups search matching inside the cursor predicate", async () => {
    const anchor = await createChat("google", "gemini-3.8-flash");
    const { default: Database } = await import("../test/memory-sql");
    const db = await Database.load();
    const realSelect = db.select.bind(db);
    let captured = "";
    db.select = async (query: string, values: unknown[] = []) => {
      captured = query;
      expect(values).toEqual([
        101,
        0,
        anchor.updated_at,
        anchor.id,
        "needle",
      ]);
      return realSelect(query, values);
    };
    await listChatPage({
      query: "needle",
      cursor: {
        id: anchor.id,
        updated_at: anchor.updated_at,
        pinned: 0,
      },
    });
    db.select = realSelect;
    expect(captured).toContain(
      "(pinned, updated_at, id) < ($2, $3, $4) AND (instr(title_search",
    );
    expect(captured).toContain("OR instr(preview_search, $5) > 0)");
  });

  it("searches non-ASCII text with the same normalization as retained rows", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    await updateChat(chat.id, { title: "École" });
    const page = await listChatPage({ query: "école" });
    expect(page.chats.map((item) => item.id)).toEqual([chat.id]);
  });

  it("finds an empty chat beyond the first 200 rows", async () => {
    const created: Awaited<ReturnType<typeof createChat>>[] = [];
    for (let i = 0; i < 205; i++) {
      created.push(await createChat("google", "gemini-3.8-flash"));
    }
    for (const chat of created.slice(2)) {
      await addMessage(chat.id, "user", "started", 1);
    }
    await updateChat(created[1].id, { preview: "not a placeholder" });
    const reusable = await listReusableChats();
    expect(reusable.map((chat) => chat.id)).toEqual([created[0].id]);
  });

  it("searches chat metadata beyond the first page", async () => {
    let now = 1;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    try {
      const created: Awaited<ReturnType<typeof createChat>>[] = [];
      for (let i = 0; i < 205; i++) {
        created.push(await createChat("google", "gemini-3.8-flash"));
      }
      const target = created[0];
      await updateChat(target.id, { title: "Archived needle" });
      const page = await listChatPage({ query: "needle" });
      expect(page.chats.map((chat) => chat.id)).toEqual([target.id]);
    } finally {
      vi.spyOn(Date, "now").mockRestore();
    }
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

    const older = await listOlderMessages(chat.id, recent[0].id, 10);
    expect(older.map((m) => m.content)).toEqual(["m100", "m200", "m300"]);
  });

  it("pages through messages with the same timestamp", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    for (let i = 0; i < 60; i++) await addMessage(chat.id, "user", `m${i}`, 100);
    const recent = await listRecentMessages(chat.id, 20);
    const middle = await listOlderMessages(chat.id, recent[0].id, 20);
    const oldest = await listOlderMessages(chat.id, middle[0].id, 20);
    expect([...oldest, ...middle, ...recent].map((m) => m.content)).toEqual(
      Array.from({ length: 60 }, (_, i) => `m${i}`),
    );
  });

  it("deletes chat and persists settings", async () => {
    const chat = await createChat("openai", "gpt-4o");
    await deleteChat(chat.id);
    expect(await getChat(chat.id)).toBeNull();
    await setSetting("resume_minutes", 9);
    await setSetting("autostart_prompted", true);
    const s = await getSettings();
    expect(s.resume_minutes).toBe(9);
    expect(s.autostart_prompted).toBe(true);
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
    const image = "data:image/png;base64,AAA";
    const a = await addMessage(source.id, "user", "one", 10, [image]);
    vi.spyOn(Date, "now").mockReturnValue(20);
    const b = await addMessage(source.id, "assistant", "two", 20);
    vi.spyOn(Date, "now").mockReturnValue(30);
    await addMessage(source.id, "user", "three", 30);
    vi.spyOn(Date, "now").mockRestore();

    vi.spyOn(Date, "now").mockReturnValue(999);
    const branched = await branchChat(source.id, b.id);
    vi.spyOn(Date, "now").mockRestore();
    expect(branched.id).not.toBe(source.id);
    expect(branched.updated_at).toBe(999);
    expect(branched.title).toMatch(/^Branch · Parent/);
    const msgs = await listMessages(branched.id);
    expect(msgs.map((m) => m.content)).toEqual(["one", "two"]);
    expect(msgs[0]).toMatchObject({ images: [], image_count: 1 });
    expect((await loadMessageImages(branched.id, msgs[0].id, msgs[1].id, 5_000_000, 4)).get(msgs[0].id)).toEqual([image]);
    expect(await loadMessageImage(branched.id, msgs[0].id, 0)).toBe(image);
    expect(msgs.map((m) => m.created_at)).toEqual([10, 20]);
    // source unchanged
    const orig = await listMessages(source.id);
    expect(orig).toHaveLength(3);
  });

  it("keeps image-only and literal attachment previews distinct when branching", async () => {
    const source = await createChat("google", "gemini-3.8-flash");
    const image = "data:image/png;base64,AAA";
    const imageOnly = await addMessage(source.id, "user", "", 10, [image]);
    const literal = await addMessage(
      source.id,
      "user",
      "[Image attachment]",
      20,
      [image],
    );

    const imageBranch = await branchChat(source.id, imageOnly.id);
    const literalBranch = await branchChat(source.id, literal.id);
    expect(imageBranch.preview).toBe("Image");
    expect(literalBranch.preview).toBe("[Image attachment]");
  });

  it("rolls back a branch when copying an image message fails", async () => {
    const source = await createChat("google", "gemini-3.8-flash");
    const message = await addMessage(
      source.id,
      "user",
      "look",
      10,
      ["data:image/png;base64,AAA"],
    );
    const { default: Database } = await import("../test/memory-sql");
    const db = await Database.load();
    const realExecute = db.execute.bind(db);
    let failed = false;
    db.execute = async (query: string, bindValues: unknown[] = []) => {
      if (query.includes("INSERT INTO messages") && !failed) {
        failed = true;
        throw new Error("copy failed");
      }
      return realExecute(query, bindValues);
    };

    await expect(branchChat(source.id, message.id)).rejects.toThrow("copy failed");
    db.execute = realExecute;
    expect((await listChats()).map((chat) => chat.id)).toEqual([source.id]);
  });

  it("deleteMessagesAfter keeps the anchor and drops the rest", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    const a = await addMessage(chat.id, "user", "one", 10);
    await addMessage(chat.id, "assistant", "two", 20);
    await addMessage(chat.id, "user", "three", 30);
    await deleteMessagesAfter(chat.id, a.id);
    expect((await listMessages(chat.id)).map((m) => m.content)).toEqual(["one"]);
  });

  it("generated titles do not overwrite a manual rename", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    expect(await setInitialChatTitle(chat.id, "Prompt")).toBe(true);
    await updateChat(chat.id, { title: "Mine" });
    expect(await replaceChatTitle(chat.id, "Prompt", "Generated")).toBe(false);
    expect((await getChat(chat.id))?.title).toBe("Mine");
  });

  it("refreshes activity time when a message changes the preview", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    await addMessage(chat.id, "user", "later message", 200);
    vi.spyOn(Date, "now").mockReturnValue(500);
    await refreshChatPreview(chat.id);
    vi.spyOn(Date, "now").mockRestore();
    expect(await getChat(chat.id)).toMatchObject({ preview: "later message", updated_at: 500 });
  });

  it("previews image-only messages without relabeling literal text", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    const image = "data:image/png;base64,BBB";
    const message = await addMessage(chat.id, "user", "", 200, [image]);
    vi.spyOn(Date, "now").mockReturnValue(500);
    await refreshChatPreview(chat.id);
    vi.spyOn(Date, "now").mockRestore();

    const [stored] = await listMessages(chat.id);
    expect(stored).toMatchObject({
      id: message.id,
      images: [],
      image_count: 1,
    });
    expect(await loadMessageImage(chat.id, message.id, 0)).toBe(image);
    expect(await getChat(chat.id)).toMatchObject({ preview: "Image", updated_at: 500 });
    await addMessage(chat.id, "user", "[Image attachment]", 210, [image]);
    await refreshChatPreview(chat.id);
    expect(await getChat(chat.id)).toMatchObject({ preview: "[Image attachment]" });
  });

  it("loads only the newest images within provider budgets", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    const first = await addMessage(
      chat.id,
      "user",
      "first",
      10,
      ["data:image/png;base64,AAA"],
    );
    const second = await addMessage(
      chat.id,
      "user",
      "second",
      20,
      ["data:image/png;base64,BBB"],
    );
    const third = await addMessage(
      chat.id,
      "user",
      "third",
      30,
      ["data:image/png;base64,CCC"],
    );
    const loaded = await loadMessageImages(chat.id, second.id, third.id, 5_000_000, 2);
    expect(new Set(loaded.keys())).toEqual(new Set([second.id, third.id]));
    expect(loaded.has(first.id)).toBe(false);
  });

  it("does not load images before the retained history boundary", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    const old = await addMessage(
      chat.id,
      "user",
      "old image",
      10,
      ["data:image/png;base64,OLD"],
    );
    const boundary = await addMessage(chat.id, "assistant", "boundary", 20);
    const recent = await addMessage(
      chat.id,
      "user",
      "recent image",
      30,
      ["data:image/png;base64,NEW"],
    );
    const anchor = await addMessage(chat.id, "assistant", "anchor", 40);

    const loaded = await loadMessageImages(
      chat.id,
      boundary.id,
      anchor.id,
      5_000_000,
      4,
    );
    expect([...loaded.keys()]).toEqual([recent.id]);
    expect(loaded.has(old.id)).toBe(false);
  });

  it("does not label an empty text response as an image", async () => {
    const chat = await createChat("google", "gemini-3.8-flash");
    await addMessage(chat.id, "assistant", "", 200);
    await refreshChatPreview(chat.id);
    expect(await getChat(chat.id)).toMatchObject({ preview: "" });
  });

  it("setDefaultModel CAS skips when live defaults already moved", async () => {
    await setDefaultModel("openai", "gpt-5.6-luna");
    await setDefaultModel("anthropic", "claude-haiku-4-5");
    const stale = await setDefaultModel("google", "gemini-3.8-flash", {
      provider: "openai",
      modelId: "gpt-5.6-luna",
    });
    expect(stale.default_provider).toBe("anthropic");
    expect(stale.default_model).toBe("claude-haiku-4-5");
    const live = await getSettings();
    expect(live.default_provider).toBe("anthropic");
    expect(live.default_model).toBe("claude-haiku-4-5");
  });

  it("setDefaultModel writes provider and model in one statement", async () => {
    await setDefaultModel("openai", "gpt-5.6-luna");
    const { default: Database } = await import("../test/memory-sql");
    const db = await Database.load();
    const realExecute = db.execute.bind(db);
    const calls: unknown[][] = [];
    db.execute = async (query: string, bindValues: unknown[] = []) => {
      const q = query.replace(/\s+/g, " ").trim();
      if (q.includes("INSERT INTO settings")) calls.push([...bindValues]);
      return realExecute(query, bindValues);
    };
    await setDefaultModel("google", "gemini-3.8-flash");
    db.execute = realExecute;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "default_provider",
      JSON.stringify("google"),
      "default_model",
      JSON.stringify("gemini-3.8-flash"),
    ]);
    const after = await getSettings();
    expect(after.default_provider).toBe("google");
    expect(after.default_model).toBe("gemini-3.8-flash");
  });

  it("setDefaultModel leaves prior defaults if the upsert fails", async () => {
    await setDefaultModel("openai", "gpt-5.6-luna");
    const { default: Database } = await import("../test/memory-sql");
    const db = await Database.load();
    const realExecute = db.execute.bind(db);
    db.execute = async (query: string, bindValues: unknown[] = []) => {
      const q = query.replace(/\s+/g, " ").trim();
      if (q.includes("INSERT INTO settings") && bindValues.length >= 4) {
        throw new Error("disk full");
      }
      return realExecute(query, bindValues);
    };
    await expect(
      setDefaultModel("google", "gemini-3.8-flash"),
    ).rejects.toThrow(/disk full/);
    db.execute = realExecute;
    const live = await getSettings();
    expect(live.default_provider).toBe("openai");
    expect(live.default_model).toBe("gpt-5.6-luna");
  });
});
