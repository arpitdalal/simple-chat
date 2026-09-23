import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Chat } from "./lib/db";

const chatsStore = vi.hoisted(() => {
  let chats: Chat[] = [];
  return {
    get: () => chats,
    set: (next: Chat[]) => {
      chats = next;
    },
    reset: () => {
      chats = [];
    },
  };
});

const hideMainWindow = vi.hoisted(() => vi.fn());
const openOrCreateChat = vi.hoisted(() =>
  vi.fn(async () => {
    if (!chatsStore.get().length) {
      const c: Chat = {
        id: "seed",
        title: "New Chat",
        model_id: "gemini-3.8-flash",
        provider: "google",
        created_at: 1,
        updated_at: 1,
        preview: "Ask AI anything…",
        pinned: 0,
      };
      chatsStore.set([c]);
      return c;
    }
    return chatsStore.get()[0];
  }),
);
const createChat = vi.hoisted(() =>
  vi.fn(async (provider: string, modelId: string) => {
    const c: Chat = {
      id: crypto.randomUUID(),
      title: "New Chat",
      model_id: modelId,
      provider,
      created_at: Date.now(),
      updated_at: Date.now(),
      preview: "Ask AI anything…",
      pinned: 0,
    };
    chatsStore.set([c, ...chatsStore.get()]);
    return c;
  }),
);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setAlwaysOnTop: vi.fn(),
    startDragging: vi.fn(),
    onFocusChanged: vi.fn(async () => () => {}),
  }),
}));

vi.mock("./lib/hotkey", () => ({
  applyHotkey: vi.fn(),
  hideMainWindow,
  DEFAULT_HOTKEY: "CommandOrControl+Shift+Space",
  formatHotkey: (s: string) => s,
  eventToAccelerator: vi.fn(() => null),
}));

vi.mock("./lib/updater", () => ({
  checkForAppUpdate: vi.fn(async () => ({ status: "none" })),
}));

vi.mock("./lib/keys", () => ({
  hasApiKey: vi.fn(async (p: string) => p === "google"),
  listReadyProviders: vi.fn(async () => ({ ready: ["google"], ok: true })),
  setApiKey: vi.fn(),
  clearApiKey: vi.fn(),
  getApiKey: vi.fn(async () => "k"),
  isKeyOpBusy: vi.fn(() => false),
  subscribeKeyBusy: vi.fn(() => () => {}),
  keyErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("./lib/chat", () => ({
  streamChat: vi.fn(),
  generateChatTitle: vi.fn(async () => "T"),
  withWebSearch: vi.fn(),
  TITLE_MODELS: {},
}));

vi.mock("./lib/db", () => ({
  getSettings: vi.fn(async () => ({
    resume_minutes: 5,
    always_on_top: false,
    show_tray: true,
    default_provider: "google",
    default_model: "gemini-3.8-flash",
    last_opened_at: Date.now(),
    last_chat_id: null,
    web_search: true,
    hotkey: "CommandOrControl+Shift+Space",
  })),
  setSetting: vi.fn(),
  setDefaultModel: vi.fn(async (provider: string, modelId: string) => ({
    resume_minutes: 5,
    always_on_top: false,
    show_tray: true,
    default_provider: provider,
    default_model: modelId,
    last_opened_at: Date.now(),
    last_chat_id: null,
    web_search: true,
    hotkey: "CommandOrControl+Shift+Space",
  })),
  listChats: vi.fn(async () => chatsStore.get()),
  getChat: vi.fn(async (id: string) =>
    chatsStore.get().find((c) => c.id === id) ?? null,
  ),
  createChat,
  openOrCreateChat,
  deleteChat: vi.fn(async (id: string) => {
    chatsStore.set(chatsStore.get().filter((c) => c.id !== id));
  }),
  updateChat: vi.fn(),
  messageCount: vi.fn(async () => 0),
  listMessages: vi.fn(async () => []),
  listRecentMessages: vi.fn(async () => []),
  listOlderMessages: vi.fn(async () => []),
  clearChatMessages: vi.fn(),
  addMessage: vi.fn(),
  branchChat: vi.fn(),
}));

import App from "./App";

describe("App shortcuts", () => {
  beforeEach(async () => {
    chatsStore.reset();
    hideMainWindow.mockClear();
    createChat.mockClear();
    const { resetChatRuntime } = await import("./lib/chat-runtime");
    resetChatRuntime();
  });

  async function boot(chats: Chat[] = []) {
    if (chats.length) {
      chatsStore.set(chats);
      openOrCreateChat.mockResolvedValueOnce(chats[0]);
    }
    render(<App />);
    await waitFor(() => expect(screen.getByText("Simple Chat")).toBeInTheDocument());
  }

  it("Esc hides window when not in settings", async () => {
    const user = userEvent.setup();
    await boot();
    await user.keyboard("{Escape}");
    expect(hideMainWindow).toHaveBeenCalled();
  });

  it("Esc closes settings before hiding", async () => {
    const user = userEvent.setup();
    await boot();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument(),
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull(),
    );
    expect(hideMainWindow).not.toHaveBeenCalled();
  });

  it("⌘, opens settings", async () => {
    const user = userEvent.setup();
    await boot();
    await user.keyboard("{Meta>}{,}{/Meta}");
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument(),
    );
  });

  it("⌘1 selects first chat", async () => {
    const user = userEvent.setup();
    await boot([
      {
        id: "a",
        title: "First",
        model_id: "gemini-3.8-flash",
        provider: "google",
        created_at: 1,
        updated_at: 2,
        preview: "x",
        pinned: 0,
      },
      {
        id: "b",
        title: "Second",
        model_id: "gemini-3.8-flash",
        provider: "google",
        created_at: 1,
        updated_at: 1,
        preview: "y",
        pinned: 0,
      },
    ]);
    await user.keyboard("{Meta>}1{/Meta}");
    await waitFor(() => {
      const active = document.querySelector(".chat-item.active");
      expect(active?.textContent).toContain("First");
    });
  });

  it("⌘N reuses existing empty New Chat instead of creating", async () => {
    const user = userEvent.setup();
    const empty: Chat = {
      id: "empty",
      title: "New Chat",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 1,
      updated_at: 1,
      preview: "Ask AI anything…",
      pinned: 0,
    };
    await boot([empty]);
    await user.keyboard("{Meta>}n{/Meta}");
    expect(createChat).not.toHaveBeenCalled();
    expect(chatsStore.get()).toHaveLength(1);
  });

  it("⌘B toggles sidebar", async () => {
    const user = userEvent.setup();
    await boot();
    await waitFor(() =>
      expect(screen.getByTitle("Hide sidebar (⌘/Ctrl+B)")).toBeInTheDocument(),
    );
    await user.keyboard("{Meta>}b{/Meta}");
    expect(screen.getByTitle("Show sidebar (⌘/Ctrl+B)")).toBeInTheDocument();
  });
});
