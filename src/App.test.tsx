import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

const openOrCreateChat = vi.hoisted(() =>
  vi.fn(async () => {
    if (chatsStore.get().length === 0) {
      const chat: Chat = {
        id: "seed",
        title: "New Chat",
        model_id: "gemini-3.8-flash",
        provider: "google",
        created_at: Date.now(),
        updated_at: Date.now(),
        preview: "Ask AI anything…",
        pinned: 0,
      };
      chatsStore.set([chat]);
      return chat;
    }
    return chatsStore.get()[0];
  }),
);

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setAlwaysOnTop: vi.fn(),
    startDragging: vi.fn(),
    onFocusChanged: vi.fn(async () => () => {}),
    hide: vi.fn(),
    show: vi.fn(),
    setFocus: vi.fn(),
    isVisible: vi.fn(async () => true),
  }),
}));

vi.mock("./lib/hotkey", () => ({
  applyHotkey: vi.fn(),
  hideMainWindow: vi.fn(),
  DEFAULT_HOTKEY: "CommandOrControl+Shift+Space",
  formatHotkey: (s: string) => s,
}));

vi.mock("./lib/updater", () => ({
  checkForAppUpdate: vi.fn(async () => ({ status: "none" })),
}));

vi.mock("./lib/keys", () => ({
  hasApiKey: vi.fn(async (p: string) => p === "google"),
  setApiKey: vi.fn(),
  clearApiKey: vi.fn(),
  getApiKey: vi.fn(async () => "test-key"),
  keyErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("./lib/chat", () => ({
  streamChat: vi.fn(),
  generateChatTitle: vi.fn(async () => "Title"),
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
  listChats: vi.fn(async () => chatsStore.get()),
  getChat: vi.fn(async (id: string) =>
    chatsStore.get().find((c) => c.id === id) ?? null,
  ),
  createChat: vi.fn(async (provider: string, modelId: string) => {
    const chat: Chat = {
      id: crypto.randomUUID(),
      title: "New Chat",
      model_id: modelId,
      provider,
      created_at: Date.now(),
      updated_at: Date.now(),
      preview: "Ask AI anything…",
      pinned: 0,
    };
    chatsStore.set([chat, ...chatsStore.get()]);
    return chat;
  }),
  openOrCreateChat,
  deleteChat: vi.fn(async (id: string) => {
    chatsStore.set(chatsStore.get().filter((c) => c.id !== id));
  }),
  updateChat: vi.fn(),
  listMessages: vi.fn(async () => []),
  listRecentMessages: vi.fn(async () => []),
  listOlderMessages: vi.fn(async () => []),
  clearChatMessages: vi.fn(),
  addMessage: vi.fn(),
  branchChat: vi.fn(),
}));

import App from "./App";
import { applyHotkey } from "./lib/hotkey";

describe("App UX", () => {
  beforeEach(() => {
    chatsStore.reset();
    vi.mocked(applyHotkey).mockReset();
    vi.mocked(applyHotkey).mockResolvedValue(undefined);
    openOrCreateChat.mockClear();
    openOrCreateChat.mockImplementation(async () => {
      if (chatsStore.get().length === 0) {
        const chat: Chat = {
          id: "seed",
          title: "New Chat",
          model_id: "gemini-3.8-flash",
          provider: "google",
          created_at: Date.now(),
          updated_at: Date.now(),
          preview: "Ask AI anything…",
          pinned: 0,
        };
        chatsStore.set([chat]);
        return chat;
      }
      return chatsStore.get()[0];
    });
  });

  it("warns when global hotkey registration fails on boot", async () => {
    vi.mocked(applyHotkey).mockRejectedValue(
      new Error("Could not register ⌘/Ctrl + ⇧ + Space — already taken"),
    );
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByText(/Could not register/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("boots into empty Ask Anything state with composer", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText("Ask Anything")).toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument();
    expect(screen.getByText("Simple Chat")).toBeInTheDocument();
    expect(screen.queryByText(/^Web$/)).toBeNull();
  });

  it("discards empty New Chat when selecting another thread", async () => {
    const user = userEvent.setup();
    const kept: Chat = {
      id: "kept",
      title: "Kept chat",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 1,
      updated_at: 2,
      preview: "hello",
      pinned: 0,
    };
    const empty: Chat = {
      id: "empty",
      title: "New Chat",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 3,
      updated_at: 4,
      preview: "Ask AI anything…",
      pinned: 0,
    };
    chatsStore.set([empty, kept]);
    openOrCreateChat.mockResolvedValueOnce(empty);

    render(<App />);
    await waitFor(() => expect(screen.getByText("Kept chat")).toBeInTheDocument());
    await user.click(screen.getByText("Kept chat"));
    await waitFor(() => {
      expect(chatsStore.get().map((c) => c.id)).toEqual(["kept"]);
    });
  });

  it("shows reopen control when sidebar is closed", async () => {
    const user = userEvent.setup();
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTitle("Hide sidebar (⌘/Ctrl+B)")).toBeInTheDocument(),
    );
    await user.click(screen.getByTitle("Hide sidebar (⌘/Ctrl+B)"));
    expect(screen.getByTitle("Show sidebar (⌘/Ctrl+B)")).toBeInTheDocument();
  });

  it("deleting active chat selects the next remaining thread", async () => {
    const user = userEvent.setup();
    const a: Chat = {
      id: "a",
      title: "Alpha",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 1,
      updated_at: 2,
      preview: "a",
      pinned: 0,
    };
    const b: Chat = {
      id: "b",
      title: "Beta",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 3,
      updated_at: 4,
      preview: "b",
      pinned: 0,
    };
    chatsStore.set([a, b]);
    openOrCreateChat.mockResolvedValueOnce(a);

    render(<App />);
    await waitFor(() => expect(screen.getByText("Beta")).toBeInTheDocument());
    const row = document.querySelector('.chat-item[data-id="a"]') as HTMLElement
      ?? Array.from(document.querySelectorAll(".chat-item")).find((el) =>
        el.textContent?.includes("Alpha"),
      )!;
    await user.hover(row);
    await user.click(within(row).getByTitle("Actions"));
    await user.click(screen.getByText("Delete Chat"));
    await waitFor(() => {
      const items = Array.from(document.querySelectorAll(".chat-item"));
      expect(items).toHaveLength(1);
      expect(items[0].textContent).toContain("Beta");
      expect(items[0].textContent).not.toContain("Alpha");
    });
  });

  it("clear chat empties messages and refreshes active", async () => {
    const user = userEvent.setup();
    const { clearChatMessages, getChat } = await import("./lib/db");
    const chat: Chat = {
      id: "c",
      title: "Thread",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 1,
      updated_at: 2,
      preview: "hello",
      pinned: 0,
    };
    chatsStore.set([chat]);
    openOrCreateChat.mockResolvedValueOnce(chat);
    vi.mocked(getChat).mockResolvedValue({ ...chat, preview: "Ask AI anything…" });

    render(<App />);
    await waitFor(() => expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument());
    const row = Array.from(document.querySelectorAll(".chat-item")).find((el) =>
      el.textContent?.includes("Thread"),
    )!;
    await user.hover(row);
    await user.click(within(row).getByTitle("Actions"));
    await user.click(screen.getByText("Clear Chat"));
    await waitFor(() => expect(clearChatMessages).toHaveBeenCalledWith("c"));
  });

  it("copy chat writes transcript to clipboard", async () => {
    const user = userEvent.setup();
    const { listMessages } = await import("./lib/db");
    vi.mocked(listMessages).mockResolvedValue([
      {
        id: "m1",
        chat_id: "c",
        role: "user",
        content: "hi",
        created_at: 1,
      },
      {
        id: "m2",
        chat_id: "c",
        role: "assistant",
        content: "yo",
        created_at: 2,
      },
    ] as never);
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const chat: Chat = {
      id: "c",
      title: "Thread",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 1,
      updated_at: 2,
      preview: "hi",
      pinned: 0,
    };
    chatsStore.set([chat]);
    openOrCreateChat.mockResolvedValueOnce(chat);

    render(<App />);
    await waitFor(() => expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument());
    const row = Array.from(document.querySelectorAll(".chat-item")).find((el) =>
      el.textContent?.includes("Thread"),
    )!;
    await user.hover(row);
    await user.click(within(row).getByTitle("Actions"));
    await user.click(screen.getByText("Copy Chat"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("user:\nhi"),
      ),
    );
  });
});
