import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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

vi.mock("@tauri-apps/api/event", () => import("./test/mock-event"));

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

const isAutostartEnabled = vi.hoisted(() => vi.fn(async () => false));
const setAutostartEnabled = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./lib/autostart", () => ({
  isAutostartEnabled,
  setAutostartEnabled,
  shouldPromptAutostart: (prompted: boolean, enabled: boolean) =>
    !prompted && !enabled,
}));

vi.mock("./lib/keys", () => ({
  hasApiKey: vi.fn(async (p: string) => p === "google"),
  listReadyProviders: vi.fn(async () => ({ ready: ["google"], ok: true })),
  setApiKey: vi.fn(),
  clearApiKey: vi.fn(),
  getApiKey: vi.fn(async () => "test-key"),
  isKeyOpBusy: vi.fn(() => false),
  subscribeKeyBusy: vi.fn(() => () => {}),
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
    autostart_prompted: true,
  })),
  setSetting: vi.fn(),
  setResumeState: vi.fn(async () => {}),
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
    autostart_prompted: true,
  })),
  chatMatchesQuery: (chat: Chat, query: string) => {
    const normalized = query.trim().toLowerCase();
    return !normalized ||
      chat.title.toLowerCase().includes(normalized) ||
      chat.preview.toLowerCase().includes(normalized);
  },
  listReusableChats: vi.fn(async () =>
    chatsStore.get().filter((chat) => chat.title === "New Chat"),
  ),
  listChatPage: vi.fn(async ({ query = "" } = {}) => {
    const normalized = query.trim().toLowerCase();
    const chats = chatsStore.get().filter((chat) =>
      !normalized ||
      chat.title.toLowerCase().includes(normalized) ||
      chat.preview.toLowerCase().includes(normalized),
    );
    return { chats, cursor: null, hasMore: false };
  }),
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
  updateChat: vi.fn(async (id: string, patch: Partial<Chat>) => {
    const current = chatsStore.get().find((chat) => chat.id === id);
    if (!current) throw new Error("Chat not found");
    const updated = { ...current, ...patch };
    chatsStore.set(
      chatsStore.get().map((chat) => chat.id === id ? updated : chat),
    );
    return updated;
  }),
  setInitialChatTitle: vi.fn(async () => true),
  refreshChatPreview: vi.fn(async () => {}),
  replaceChatTitle: vi.fn(async () => true),
  messageCount: vi.fn(async () => 0),
  listMessages: vi.fn(async () => []),
  listRecentMessages: vi.fn(async () => []),
  listOlderMessages: vi.fn(async () => []),
  clearChatMessages: vi.fn(async (id: string) => {
    const current = chatsStore.get().find((chat) => chat.id === id);
    if (!current) throw new Error("Chat not found");
    return { ...current, title: "New Chat", preview: "Ask AI anything…" };
  }),
  addMessage: vi.fn(),
  branchChat: vi.fn(),
}));

import App from "./App";
import { applyHotkey } from "./lib/hotkey";
import {
  emitMainWindowHiddenForTests,
  emitMainWindowShownForTests,
  mainWindowShownListenerCountForTests,
} from "./test/mock-event";

describe("App UX", () => {
  beforeEach(async () => {
    const { resetChatSessions } = await import("./lib/chat-runtime");
    resetChatSessions();
    chatsStore.reset();
    vi.mocked(applyHotkey).mockReset();
    vi.mocked(applyHotkey).mockResolvedValue(undefined);
    const { listReadyProviders } = await import("./lib/keys");
    vi.mocked(listReadyProviders).mockResolvedValue({
      ready: ["google"],
      ok: true,
    });
    const { listChatPage, messageCount, setSetting } = await import("./lib/db");
    vi.mocked(listChatPage).mockReset();
    vi.mocked(listChatPage).mockImplementation(async ({ query = "" } = {}) => {
      const normalized = query.trim().toLowerCase();
      return {
        chats: chatsStore.get().filter((chat) =>
          !normalized ||
          chat.title.toLowerCase().includes(normalized) ||
          chat.preview.toLowerCase().includes(normalized),
        ),
        cursor: null,
        hasMore: false,
      };
    });
    vi.mocked(messageCount).mockReset();
    vi.mocked(messageCount).mockResolvedValue(0);
    vi.mocked(setSetting).mockReset();
    vi.mocked(setSetting).mockResolvedValue(undefined);
    isAutostartEnabled.mockReset().mockResolvedValue(false);
    setAutostartEnabled.mockReset().mockResolvedValue(undefined);
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

  it("starts a new chat when a hidden prior chat's resume window expires", async () => {
    const { getSettings, openOrCreateChat, setSetting } = await import("./lib/db");
    const prior: Chat = {
      id: "prior",
      title: "Previous chat",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 1,
      updated_at: 1,
      preview: "Previous message",
      pinned: 0,
    };
    const fresh: Chat = {
      ...prior,
      id: "fresh",
      title: "New Chat",
      preview: "Ask AI anything…",
      created_at: 2,
      updated_at: 2,
    };
    chatsStore.set([prior]);
    openOrCreateChat.mockResolvedValueOnce(prior).mockResolvedValueOnce(fresh);

    render(<App />);
    await waitFor(() => expect(openOrCreateChat).toHaveBeenCalledTimes(1));
    expect(document.querySelector(".title-pill")).toHaveTextContent("Previous chat");
    await waitFor(() => expect(mainWindowShownListenerCountForTests()).toBeGreaterThan(0));
    vi.mocked(setSetting).mockClear();
    emitMainWindowHiddenForTests();
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith("last_opened_at", expect.any(Number)),
    );

    vi.mocked(getSettings).mockImplementation(async () => ({
      resume_minutes: 1,
      always_on_top: false,
      show_tray: true,
      default_provider: "google",
      default_model: "gemini-3.8-flash",
      last_opened_at: Date.now() - 61_000,
      last_chat_id: prior.id,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
      autostart_prompted: true,
    }));
    emitMainWindowShownForTests();

    await waitFor(() => expect(openOrCreateChat).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(document.querySelector(".title-pill")).toHaveTextContent("New Chat"),
    );
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

  it("loads the next chat page with the previous cursor", async () => {
    const { listChatPage } = await import("./lib/db");
    const first: Chat = {
      id: "first",
      title: "First",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 2,
      updated_at: 2,
      preview: "first",
      pinned: 0,
    };
    const second: Chat = {
      ...first,
      id: "second",
      title: "Second",
      created_at: 1,
      updated_at: 1,
      preview: "second",
    };
    chatsStore.set([first, second]);
    openOrCreateChat.mockResolvedValueOnce(first);
    vi.mocked(listChatPage)
      .mockResolvedValueOnce({
        chats: [first],
        cursor: {
          id: first.id,
          updated_at: first.updated_at,
          pinned: first.pinned,
        },
        hasMore: true,
      })
      .mockResolvedValueOnce({ chats: [second], cursor: null, hasMore: false });

    render(<App />);

    await waitFor(() => expect(listChatPage).toHaveBeenCalledTimes(2));
    expect(listChatPage.mock.calls[1][0]).toEqual({
      limit: 100,
      cursor: {
        id: first.id,
        updated_at: first.updated_at,
        pinned: first.pinned,
      },
      query: "",
    });
    expect(screen.getByText("Second")).toBeInTheDocument();
  });

  it("does not restore a deleted chat from an in-flight page", async () => {
    const user = userEvent.setup();
    const { listChatPage } = await import("./lib/db");
    const first: Chat = {
      id: "first",
      title: "First",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 2,
      updated_at: 2,
      preview: "first",
      pinned: 0,
    };
    const second: Chat = {
      ...first,
      id: "second",
      title: "Second",
      created_at: 1,
      updated_at: 1,
      preview: "second",
    };
    let resolveSecondPage:
      | ((page: { chats: Chat[]; cursor: null; hasMore: boolean }) => void)
      | undefined;
    const secondPage = new Promise<{
      chats: Chat[];
      cursor: null;
      hasMore: boolean;
    }>((resolve) => {
      resolveSecondPage = resolve;
    });
    chatsStore.set([first, second]);
    openOrCreateChat.mockResolvedValueOnce(first);
    vi.mocked(listChatPage)
      .mockResolvedValueOnce({
        chats: [first],
        cursor: {
          id: first.id,
          updated_at: first.updated_at,
          pinned: first.pinned,
        },
        hasMore: true,
      })
      .mockImplementationOnce(() => secondPage)
      .mockResolvedValueOnce({ chats: [second], cursor: null, hasMore: false });

    render(<App />);
    await waitFor(() => expect(listChatPage).toHaveBeenCalledTimes(2));
    await user.click(screen.getByTitle("Actions"));
    await user.click(screen.getByText("Delete Chat"));
    await waitFor(() => expect(listChatPage).toHaveBeenCalledTimes(3));
    resolveSecondPage?.({
      chats: [first, second],
      cursor: null,
      hasMore: false,
    });

    await waitFor(() => expect(screen.queryByText("First")).toBeNull());
    expect(document.querySelector(".chat-item")?.textContent).toContain("Second");
  });

  it("clears a filter when deleting its final matching chat", async () => {
    const user = userEvent.setup();
    const matching: Chat = {
      id: "matching",
      title: "Needle",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 2,
      updated_at: 2,
      preview: "matching",
      pinned: 0,
    };
    const remaining: Chat = {
      ...matching,
      id: "remaining",
      title: "Other",
      created_at: 1,
      updated_at: 1,
      preview: "remaining",
    };
    chatsStore.set([matching, remaining]);
    openOrCreateChat.mockResolvedValueOnce(matching);

    render(<App />);
    const search = await screen.findByPlaceholderText("Search Chats…");
    await user.type(search, "needle");
    await waitFor(() => expect(screen.queryByText("Other")).toBeNull());
    await user.click(await screen.findByTitle("Actions"));
    await user.click(screen.getByText("Delete Chat"));

    await waitFor(() => expect(search).toHaveValue(""));
    expect(document.querySelector(".chat-item")?.textContent).toContain("Other");
  });

  it("clears a filter after deleting the final inactive match", async () => {
    const user = userEvent.setup();
    const matching: Chat = {
      id: "matching",
      title: "Needle",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 2,
      updated_at: 2,
      preview: "matching",
      pinned: 0,
    };
    const remaining: Chat = {
      ...matching,
      id: "remaining",
      title: "Other",
      created_at: 1,
      updated_at: 1,
      preview: "remaining",
    };
    chatsStore.set([matching, remaining]);
    openOrCreateChat.mockResolvedValueOnce(remaining);

    render(<App />);
    const search = await screen.findByPlaceholderText("Search Chats…");
    await user.type(search, "needle");
    await user.click(await screen.findByTitle("Actions"));
    await user.click(screen.getByText("Delete Chat"));

    await waitFor(() => expect(search).toHaveValue(""));
    expect(document.querySelector(".chat-item")?.textContent).toContain("Other");
  });

  it("disables composer when no API keys are present", async () => {
    const { listReadyProviders } = await import("./lib/keys");
    vi.mocked(listReadyProviders).mockResolvedValue({ ready: [], ok: true });
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText("Add key to start chatting"),
      ).toBeInTheDocument(),
    );
  });

  it("retargets empty chat to a keyed provider on boot", async () => {
    const { listReadyProviders } = await import("./lib/keys");
    const { getSettings, updateChat, messageCount } = await import("./lib/db");
    vi.mocked(listReadyProviders).mockResolvedValue({
      ready: ["google"],
      ok: true,
    });
    vi.mocked(getSettings).mockResolvedValue({
      resume_minutes: 5,
      always_on_top: false,
      show_tray: true,
      default_provider: "openai",
      default_model: "gpt-5.6-luna",
      last_opened_at: Date.now(),
      last_chat_id: null,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
      autostart_prompted: true,
    });
    const empty: Chat = {
      id: "empty-openai",
      title: "New Chat",
      model_id: "gpt-5.6-luna",
      provider: "openai",
      created_at: 1,
      updated_at: 1,
      preview: "Ask AI anything…",
      pinned: 0,
    };
    chatsStore.set([empty]);
    openOrCreateChat.mockResolvedValueOnce(empty);
    vi.mocked(messageCount).mockResolvedValue(0);
    vi.mocked(updateChat).mockImplementation(async (id, patch) => {
      const cur = chatsStore.get().find((c) => c.id === id);
      if (!cur) return;
      chatsStore.set(
        chatsStore.get().map((c) => (c.id === id ? { ...c, ...patch } : c)),
      );
    });

    render(<App />);
    await waitFor(() =>
      expect(updateChat).toHaveBeenCalledWith("empty-openai", {
        provider: "google",
        model_id: expect.stringMatching(/^gemini/),
      }),
    );
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

  it("does not discard a New Chat that already has messages", async () => {
    const user = userEvent.setup();
    const { messageCount, deleteChat } = await import("./lib/db");
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
    const emptyLooking: Chat = {
      id: "empty-looking",
      title: "New Chat",
      model_id: "gemini-3.8-flash",
      provider: "google",
      created_at: 3,
      updated_at: 4,
      preview: "Ask AI anything…",
      pinned: 0,
    };
    chatsStore.set([emptyLooking, kept]);
    openOrCreateChat.mockResolvedValueOnce(emptyLooking);
    vi.mocked(messageCount).mockImplementation(async (id: string) =>
      id === "empty-looking" ? 1 : 0,
    );

    render(<App />);
    await waitFor(() => expect(screen.getByText("Kept chat")).toBeInTheDocument());
    await user.click(screen.getByText("Kept chat"));
    await waitFor(() => expect(screen.getAllByText("Kept chat").length).toBeGreaterThan(1));
    expect(chatsStore.get().map((c) => c.id)).toEqual(["empty-looking", "kept"]);
    expect(deleteChat).not.toHaveBeenCalled();
    expect(screen.getByText("New Chat")).toBeInTheDocument();
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
        images: [],
        image_count: 0,
        created_at: 1,
      },
      {
        id: "m2",
        chat_id: "c",
        role: "user",
        content: "",
        images: [],
        image_count: 1,
        created_at: 2,
      },
      {
        id: "m3",
        chat_id: "c",
        role: "assistant",
        content: "yo",
        images: [],
        image_count: 0,
        created_at: 3,
      },
    ]);
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
        "user:\nhi\n\nuser:\n[Image attachment]\n\nassistant:\nyo",
      ),
    );
  });

  it("asks to start on login after install, then Enable writes the login item", async () => {
    const user = userEvent.setup();
    const { getSettings, setSetting } = await import("./lib/db");
    vi.mocked(getSettings).mockResolvedValue({
      resume_minutes: 5,
      always_on_top: false,
      show_tray: true,
      default_provider: "google",
      default_model: "gemini-3.8-flash",
      last_opened_at: Date.now(),
      last_chat_id: null,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
      autostart_prompted: false,
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    setAutostartEnabled.mockImplementation(async () => {
      await gate;
    });
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByText("Start Simple Chat when you log in?"),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Enable" }));
    expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
    release();
    await waitFor(() => expect(setAutostartEnabled).toHaveBeenCalledWith(true));
    expect(setSetting).toHaveBeenCalledWith("autostart_prompted", true);
    await waitFor(() =>
      expect(
        screen.queryByText("Start Simple Chat when you log in?"),
      ).toBeNull(),
    );
  });

  it("hides the login-item prompt while Settings is open", async () => {
    const user = userEvent.setup();
    const { getSettings } = await import("./lib/db");
    vi.mocked(getSettings).mockResolvedValue({
      resume_minutes: 5,
      always_on_top: false,
      show_tray: true,
      default_provider: "google",
      default_model: "gemini-3.8-flash",
      last_opened_at: Date.now(),
      last_chat_id: null,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
      autostart_prompted: false,
    });
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByText("Start Simple Chat when you log in?"),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Start Simple Chat when you log in?"),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.getByText("Start Simple Chat when you log in?"),
      ).toBeInTheDocument(),
    );
  });

  it("ignores a stale boot login-item probe after Settings settles", async () => {
    const user = userEvent.setup();
    const { getSettings } = await import("./lib/db");
    vi.mocked(getSettings).mockResolvedValue({
      resume_minutes: 5,
      always_on_top: false,
      show_tray: true,
      default_provider: "google",
      default_model: "gemini-3.8-flash",
      last_opened_at: Date.now(),
      last_chat_id: null,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
      autostart_prompted: false,
    });
    let resolveBoot!: (enabled: boolean) => void;
    const bootProbe = new Promise<boolean>((r) => {
      resolveBoot = r;
    });
    let calls = 0;
    isAutostartEnabled.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? bootProbe : Promise.resolve(false);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText("Ask Anything")).toBeInTheDocument());
    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(1));
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const box = await screen.findByRole("checkbox", { name: /start on login/i });
    await waitFor(() => expect(box).not.toBeDisabled());
    await user.click(box);
    await waitFor(() => expect(setAutostartEnabled).toHaveBeenCalledWith(true));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByText("Ask Anything")).toBeInTheDocument());
    expect(
      screen.queryByText("Start Simple Chat when you log in?"),
    ).toBeNull();
    await act(async () => {
      resolveBoot(false);
    });
    expect(
      screen.queryByText("Start Simple Chat when you log in?"),
    ).toBeNull();
  });

  it("Settings login-item toggle dismisses the first-run prompt", async () => {
    const user = userEvent.setup();
    const { getSettings } = await import("./lib/db");
    vi.mocked(getSettings).mockResolvedValue({
      resume_minutes: 5,
      always_on_top: false,
      show_tray: true,
      default_provider: "google",
      default_model: "gemini-3.8-flash",
      last_opened_at: Date.now(),
      last_chat_id: null,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
      autostart_prompted: false,
    });
    render(<App />);
    await waitFor(() =>
      expect(
        screen.getByText("Start Simple Chat when you log in?"),
      ).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const box = await screen.findByRole("checkbox", { name: /start on login/i });
    await waitFor(() => expect(box).not.toBeDisabled());
    await user.click(box);
    await waitFor(() => expect(setAutostartEnabled).toHaveBeenCalledWith(true));
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.getByText("Ask Anything")).toBeInTheDocument(),
    );
    expect(
      screen.queryByText("Start Simple Chat when you log in?"),
    ).toBeNull();
  });

  it("Not now dismisses the login-item prompt without enabling", async () => {
    const user = userEvent.setup();
    const { getSettings, setSetting } = await import("./lib/db");
    vi.mocked(getSettings).mockResolvedValue({
      resume_minutes: 5,
      always_on_top: false,
      show_tray: true,
      default_provider: "google",
      default_model: "gemini-3.8-flash",
      last_opened_at: Date.now(),
      last_chat_id: null,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
      autostart_prompted: false,
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(setAutostartEnabled).not.toHaveBeenCalled();
    expect(setSetting).toHaveBeenCalledWith("autostart_prompted", true);
    await waitFor(() =>
      expect(
        screen.queryByText("Start Simple Chat when you log in?"),
      ).toBeNull(),
    );
  });

  it("keeps the login-item prompt when Not now cannot persist", async () => {
    const user = userEvent.setup();
    const { getSettings, setSetting } = await import("./lib/db");
    vi.mocked(getSettings).mockResolvedValue({
      resume_minutes: 5,
      always_on_top: false,
      show_tray: true,
      default_provider: "google",
      default_model: "gemini-3.8-flash",
      last_opened_at: Date.now(),
      last_chat_id: null,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
      autostart_prompted: false,
    });
    vi.mocked(setSetting).mockImplementation(async (key: string) => {
      if (key === "autostart_prompted") throw new Error("db locked");
    });
    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(screen.getByText(/db locked/)).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Start Simple Chat when you log in?"),
    ).toBeInTheDocument();
  });
});
