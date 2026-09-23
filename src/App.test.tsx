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
  setInitialChatTitle: vi.fn(async () => true),
  refreshChatPreview: vi.fn(async () => {}),
  replaceChatTitle: vi.fn(async () => true),
  messageCount: vi.fn(async () => 0),
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
    const { messageCount, setSetting } = await import("./lib/db");
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

  it("boots into empty Ask Anything state with composer", async () => {
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText("Ask Anything")).toBeInTheDocument(),
    );
    expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument();
    expect(screen.getByText("Simple Chat")).toBeInTheDocument();
    expect(screen.queryByText(/^Web$/)).toBeNull();
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
