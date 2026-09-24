import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-sql", () => import("../test/memory-sql"));

import {
  createChat,
  getSettings,
  openOrCreateChat,
  setSetting,
  addMessage,
  type AppSettings,
} from "./db";
import { resetMemoryDb } from "../test/memory-sql";

const baseSettings = (): AppSettings => ({
  resume_minutes: 5,
  always_on_top: false,
  show_tray: true,
  default_provider: "google",
  default_model: "gemini-3.8-flash",
  last_opened_at: 0,
  last_chat_id: null,
  web_search: true,
  hotkey: "CommandOrControl+Shift+Space",
  autostart_prompted: false,
});

describe("openOrCreateChat", () => {
  beforeEach(() => {
    resetMemoryDb();
  });

  it("creates a new chat when nothing to resume", async () => {
    const chat = await openOrCreateChat(baseSettings());
    expect(chat.title).toBe("New Chat");
    expect(chat.provider).toBe("google");
  });

  it("resumes last chat within window", async () => {
    const existing = await createChat("google", "gemini-3.8-flash");
    await setSetting("last_chat_id", existing.id);
    const chat = await openOrCreateChat({
      ...baseSettings(),
      last_chat_id: existing.id,
      last_opened_at: Date.now(),
      resume_minutes: 5,
    });
    expect(chat.id).toBe(existing.id);
  });

  it("uses the configured one-minute window", async () => {
    const prior = await createChat("google", "gemini-3.8-flash");
    await addMessage(prior.id, "user", "hello");
    const chat = await openOrCreateChat({
      ...baseSettings(),
      last_chat_id: prior.id,
      last_opened_at: Date.now() - 61_000,
      resume_minutes: 1,
    });
    expect(chat.id).not.toBe(prior.id);
  });

  it("reuses empty New Chat instead of creating another when expired", async () => {
    const empty = await createChat("google", "gemini-3.8-flash");
    const chat = await openOrCreateChat({
      ...baseSettings(),
      last_chat_id: empty.id,
      last_opened_at: Date.now() - 60 * 60 * 1000,
      resume_minutes: 5,
    });
    expect(chat.id).toBe(empty.id);
  });

  it("creates new when last chat has messages and resume expired", async () => {
    const prior = await createChat("google", "gemini-3.8-flash");
    await addMessage(prior.id, "user", "hi");
    const chat = await openOrCreateChat({
      ...baseSettings(),
      last_chat_id: prior.id,
      last_opened_at: Date.now() - 60 * 60 * 1000,
      resume_minutes: 5,
    });
    expect(chat.id).not.toBe(prior.id);
  });
});

describe("getSettings defaults", () => {
  beforeEach(() => resetMemoryDb());

  it("returns defaults when empty", async () => {
    const s = await getSettings();
    expect(s.web_search).toBe(true);
    expect(s.resume_minutes).toBe(5);
  });
});
