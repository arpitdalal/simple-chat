import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Chat, Message } from "../lib/db";

const streamChat = vi.fn();
const generateChatTitle = vi.fn();
const addMessage = vi.fn();
const listRecentMessages = vi.fn();
const listOlderMessages = vi.fn();
const listMessages = vi.fn();
const deleteMessagesAfter = vi.fn();
const updateChat = vi.fn();
const getChat = vi.fn();

const hiddenListeners = vi.hoisted(() => new Set<() => void>());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}));

vi.mock("../lib/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/memory")>();
  return {
    ...actual,
    onMainWindowHidden: vi.fn(async (handler: () => void) => {
      hiddenListeners.add(handler);
      return () => hiddenListeners.delete(handler);
    }),
  };
});

vi.mock("../lib/chat", () => ({
  streamChat: (...a: unknown[]) => streamChat(...a),
  generateChatTitle: (...a: unknown[]) => generateChatTitle(...a),
}));

vi.mock("../lib/keys", () => ({
  hasApiKey: vi.fn(async () => true),
  listReadyProviders: vi.fn(async () => ({
    ready: ["openai", "anthropic", "google"],
    ok: true,
  })),
  keyErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("../lib/db", () => ({
  addMessage: (...a: unknown[]) => addMessage(...a),
  listRecentMessages: (...a: unknown[]) => listRecentMessages(...a),
  listOlderMessages: (...a: unknown[]) => listOlderMessages(...a),
  listMessages: (...a: unknown[]) => listMessages(...a),
  deleteMessagesAfter: (...a: unknown[]) => deleteMessagesAfter(...a),
  updateChat: (...a: unknown[]) => updateChat(...a),
  getChat: (...a: unknown[]) => getChat(...a),
}));

import { ChatView } from "./ChatView";

const chat: Chat = {
  id: "c1",
  title: "New Chat",
  model_id: "gemini-3.8-flash",
  provider: "google",
  created_at: 1,
  updated_at: 1,
  preview: "Ask AI anything…",
  pinned: 0,
};

function msg(
  partial: Partial<Message> & Pick<Message, "id" | "content" | "role">,
): Message {
  return {
    chat_id: "c1",
    created_at: Date.now(),
    ...partial,
  };
}

describe("ChatView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hiddenListeners.clear();
    // Persist mock: listMessages reflects what addMessage stored (send history).
    const stored = new Map<string, Message[]>();
    listRecentMessages.mockResolvedValue([]);
    listOlderMessages.mockResolvedValue([]);
    listMessages.mockImplementation(async (chatId: string) => [
      ...(stored.get(chatId) ?? []),
    ]);
    deleteMessagesAfter.mockResolvedValue(undefined);
    updateChat.mockResolvedValue(undefined);
    getChat.mockImplementation(async (id: string) => ({
      ...chat,
      id,
      title: "New Chat",
      preview: "Ask AI anything…",
    }));
    generateChatTitle.mockResolvedValue("Auto Title");
    addMessage.mockImplementation(async (chatId, role, content) => {
      const m = msg({ id: crypto.randomUUID(), chat_id: chatId, role, content });
      const list = stored.get(chatId) ?? [];
      list.push(m);
      stored.set(chatId, list);
      return m;
    });
    streamChat.mockImplementation(async (opts: { onToken: (t: string) => void }) => {
      opts.onToken("Hello ");
      opts.onToken("world");
    });
  });

  it("shows Thinking immediately and streams assistant reply", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    streamChat.mockImplementation(async (opts: { onToken: (t: string) => void }) => {
      opts.onToken("Hi");
      await gate;
    });

    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );

    await user.type(screen.getByPlaceholderText("Ask AI anything…"), "hey");
    await user.keyboard("{Enter}");

    // Stop is outside the virtualizer — reliable busy signal
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("hey")).toBeInTheDocument());
    expect(screen.getByText("Thinking…")).toBeInTheDocument();

    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryByText("Thinking…")).toBeNull());
    expect(screen.getByText("Hi")).toBeInTheDocument();
    expect(addMessage).toHaveBeenCalledWith("c1", "assistant", "Hi");
  });

  it("keeps drafting enabled while sendLocked; Enter does not send", async () => {
    const user = userEvent.setup();
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
        sendLocked
      />,
    );
    const box = await screen.findByPlaceholderText(
      "Waiting for current operation…",
    );
    expect(box).not.toHaveAttribute("readonly");
    await user.type(box, "draft while busy");
    expect(box).toHaveValue("draft while busy");
    await user.keyboard("{Enter}");
    expect(streamChat).not.toHaveBeenCalled();
    expect(addMessage).not.toHaveBeenCalled();
    expect(screen.getByText("Waiting…")).toBeInTheDocument();
  });

  it("sets provisional title and requests auto-title for New Chat", async () => {
    const user = userEvent.setup();
    const onChatMeta = vi.fn();
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={onChatMeta}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );
    await user.type(screen.getByPlaceholderText("Ask AI anything…"), "domains");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(generateChatTitle).toHaveBeenCalled());
    expect(updateChat).toHaveBeenCalledWith(
      "c1",
      expect.objectContaining({ title: "domains", preview: "domains" }),
    );
    await waitFor(() =>
      expect(onChatMeta).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Auto Title" }),
      ),
    );
  });

  it("Stop aborts in-flight stream without error banner", async () => {
    const user = userEvent.setup();
    streamChat.mockImplementation(
      async (opts: { abortSignal?: AbortSignal; onToken: (t: string) => void }) => {
        if (opts.abortSignal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        opts.onToken("partial");
        await new Promise((_r, reject) => {
          opts.abortSignal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    );

    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );
    await user.type(screen.getByPlaceholderText("Ask AI anything…"), "stop me");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(),
    );
    expect(screen.queryByText(/aborted/i)).toBeNull();
  });

  it("notifies on stream failure", async () => {
    const user = userEvent.setup();
    const onNotify = vi.fn();
    streamChat.mockRejectedValue(new Error("No API key for google"));
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={onNotify}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );
    await user.type(screen.getByPlaceholderText("Ask AI anything…"), "fail");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith("No API key for google", "err"),
    );
  });

  it("restores composer draft when send fails before user message persists", async () => {
    const user = userEvent.setup();
    addMessage.mockRejectedValueOnce(new Error("db down"));
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );
    const ta = screen.getByPlaceholderText("Ask AI anything…");
    await user.type(ta, "keep me");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(ta).toHaveValue("keep me"));
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("does not clobber newer composer text when failed send restores", async () => {
    const user = userEvent.setup();
    let rejectAdd!: (e: Error) => void;
    addMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAdd = reject;
        }),
    );
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );
    const ta = screen.getByPlaceholderText("Ask AI anything…");
    await user.type(ta, "first");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(ta).toHaveValue(""));
    await user.type(ta, "newer draft");
    await act(async () => {
      rejectAdd(new Error("db down"));
    });
    await waitFor(() => expect(ta).toHaveValue("newer draft"));
  });

  it("does not restore failed images into a text-only newer draft", async () => {
    const user = userEvent.setup();
    let rejectAdd!: (e: Error) => void;
    addMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAdd = reject;
        }),
    );
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );
    const ta = screen.getByPlaceholderText("Ask AI anything…");
    // Attach image then send
    const file = new File(["x"], "a.png", { type: "image/png" });
    await act(async () => {
      const input = document.querySelector(
        'input[type="file"]',
      ) as HTMLInputElement;
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(screen.getByTitle("Remove")).toBeInTheDocument());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByTitle("Remove")).toBeNull());
    await user.type(ta, "typed after");
    await act(async () => {
      rejectAdd(new Error("db down"));
    });
    await waitFor(() => expect(ta).toHaveValue("typed after"));
    expect(screen.queryByTitle("Remove")).toBeNull();
  });

  it("keeps partial assistant reply when stream fails mid-way", async () => {
    const user = userEvent.setup();
    streamChat.mockImplementation(
      async (opts: { onToken: (t: string) => void }) => {
        opts.onToken("Hello partial");
        throw new Error("timeout");
      },
    );
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );
    await user.type(screen.getByPlaceholderText("Ask AI anything…"), "hi");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(addMessage).toHaveBeenCalledWith("c1", "assistant", "Hello partial"),
    );
    expect(await screen.findByText("Hello partial")).toBeInTheDocument();
  });

  it("loads older messages when scrolled near top", async () => {
    // PAGE=50 — hasMore only when recent page is full
    const existing = Array.from({ length: 50 }, (_, i) =>
      msg({
        id: `m${i}`,
        role: i % 2 ? "assistant" : "user",
        content: `msg-${i}`,
        created_at: 1000 + i,
      }),
    );
    listRecentMessages.mockResolvedValue(existing);
    listOlderMessages.mockResolvedValue([
      msg({ id: "old", role: "user", content: "older", created_at: 1 }),
    ]);

    render(
      <ChatView
        chat={{ ...chat, title: "Thread" }}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() => expect(screen.getByText("msg-0")).toBeInTheDocument());

    const scroller = document.querySelector(".messages") as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    scroller.scrollTop = 10;
    scroller.dispatchEvent(new Event("scroll"));

    await waitFor(() => expect(listOlderMessages).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("older")).toBeInTheDocument());
  });

  it("trims scrolled-up history and draft images on window hide", async () => {
    const existing = Array.from({ length: 50 }, (_, i) =>
      msg({
        id: `m${i}`,
        role: i % 2 ? "assistant" : "user",
        content: `msg-${i}`,
        created_at: 1000 + i,
      }),
    );
    listRecentMessages.mockResolvedValue(existing);
    listOlderMessages.mockResolvedValue([
      msg({ id: "old", role: "user", content: "older", created_at: 1 }),
    ]);

    const readAsDataURL = vi.fn(function (this: FileReader) {
      Object.defineProperty(this, "result", {
        value: "data:image/png;base64,aaa",
      });
      this.onload?.(new ProgressEvent("load") as unknown as ProgressEvent<FileReader>);
    });
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: ((ev: ProgressEvent<FileReader>) => void) | null = null;
        readAsDataURL = readAsDataURL;
      },
    );

    render(
      <ChatView
        chat={{ ...chat, title: "Thread" }}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() => expect(screen.getByText("msg-0")).toBeInTheDocument());

    const scroller = document.querySelector(".messages") as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    scroller.scrollTop = 10;
    scroller.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(screen.getByText("older")).toBeInTheDocument());

    const ta = screen.getByPlaceholderText("Ask AI anything…");
    await act(async () => {
      ta.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          clipboardData: {
            items: [
              {
                type: "image/png",
                getAsFile: () =>
                  new File([new Uint8Array([1])], "pic.png", {
                    type: "image/png",
                  }),
              },
            ],
          } as unknown as DataTransfer,
        }),
      );
    });
    await waitFor(() => expect(document.querySelector(".thumb img")).toBeTruthy());

    await act(async () => {
      for (const fn of hiddenListeners) fn();
    });

    await waitFor(() => {
      expect(screen.queryByText("older")).toBeNull();
      expect(document.querySelector(".thumb img")).toBeNull();
    });
    expect(screen.getByText("msg-0")).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("attaches pasted images", async () => {
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );

    const file = new File([new Uint8Array([1, 2, 3])], "pic.png", {
      type: "image/png",
    });
    const ta = screen.getByPlaceholderText("Ask AI anything…");
    await act(async () => {
      ta.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          clipboardData: {
            items: [
              {
                type: "image/png",
                getAsFile: () => file,
              },
            ],
          } as unknown as DataTransfer,
        }),
      );
    });

    // FileReader is async
    await waitFor(() => expect(document.querySelector(".thumb img")).toBeTruthy());
  });

  it("grows composer height with multiline input up to cap", async () => {
    const user = userEvent.setup();
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    const ta = await screen.findByPlaceholderText("Ask AI anything…");
    await user.click(ta);
    await user.type(ta, "line1{Shift>}{Enter}{/Shift}line2{Shift>}{Enter}{/Shift}line3");
    // force resize path if scrollHeight stays flat in happy-dom
    Object.defineProperty(ta, "scrollHeight", { configurable: true, value: 88 });
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => {
      const after = (ta as HTMLTextAreaElement).style.height;
      expect(Number.parseInt(after || "0", 10)).toBeGreaterThanOrEqual(66);
    });
  });

  it("sends with webSearch always on", async () => {
    const user = userEvent.setup();
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await user.type(await screen.findByPlaceholderText("Ask AI anything…"), "hi");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(streamChat).toHaveBeenCalled());
    expect(streamChat.mock.calls[0][0]).toEqual(
      expect.objectContaining({ webSearch: true }),
    );
  });

  it("fab New Chat calls onNew", async () => {
    const user = userEvent.setup();
    const onNew = vi.fn();
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={onNew}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await user.click(await screen.findByTitle(/New Chat/i));
    expect(onNew).toHaveBeenCalled();
  });

  it("persists model change via updateChat and onChatMeta", async () => {
    const user = userEvent.setup();
    const onChatMeta = vi.fn();
    const onChatUpdated = vi.fn();

    render(
      <ChatView
        chat={chat}
        onChatUpdated={onChatUpdated}
        onChatMeta={onChatMeta}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await user.click(await screen.findByTitle("Select model"));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    await user.clear(screen.getByPlaceholderText("Search…"));
    await user.type(screen.getByPlaceholderText("Search…"), "gpt-4o");
    // Prefer exact GPT-4o over mini: click the option whose accessible name is exactly GPT-4o
    const opts = await screen.findAllByRole("option");
    const gpt4o = opts.find((o) => o.textContent?.includes("GPT-4o") && !o.textContent?.includes("mini"));
    expect(gpt4o).toBeTruthy();
    await user.click(gpt4o!);
    await waitFor(() =>
      expect(updateChat).toHaveBeenCalledWith(
        "c1",
        expect.objectContaining({ provider: "openai", model_id: "gpt-4o" }),
      ),
    );
    expect(onChatMeta).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", model_id: "gpt-4o" }),
    );
    expect(onChatUpdated).toHaveBeenCalled();
  });

  it("user messages have icon Copy and Branch with feedback", async () => {
    const user = userEvent.setup();
    const onBranch = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    listRecentMessages.mockResolvedValue([
      msg({ id: "u1", role: "user", content: "hello user" }),
      msg({ id: "a1", role: "assistant", content: "hi back" }),
    ]);

    render(
      <ChatView
        chat={{ ...chat, title: "Thread" }}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={onBranch}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() => expect(screen.getByText("hello user")).toBeInTheDocument());
    const copies = screen.getAllByRole("button", { name: "Copy" });
    expect(copies.length).toBeGreaterThanOrEqual(2);
    await user.click(copies[0]);
    expect(writeText).toHaveBeenCalledWith("hello user");
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();

    const branches = screen.getAllByRole("button", { name: "Branch" });
    await user.click(branches[0]);
    expect(onBranch).toHaveBeenCalledWith("u1");
    expect(await screen.findByRole("button", { name: "Branched" })).toBeInTheDocument();
  });

  it("does not show Thinking on another chat while one streams", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    streamChat.mockImplementation(async (opts: { onToken: (t: string) => void }) => {
      opts.onToken("partial-A");
      await gate;
    });

    const other: Chat = {
      ...chat,
      id: "c2",
      title: "Other",
      preview: "old reply",
    };
    listRecentMessages.mockImplementation(async (id: string) => {
      if (id === "c2") {
        return [msg({ id: "old", chat_id: "c2", role: "assistant", content: "old reply" })];
      }
      return [];
    });

    const { rerender } = render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await user.type(await screen.findByPlaceholderText("Ask AI anything…"), "hi");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
    expect(screen.getByText("partial-A")).toBeInTheDocument();

    rerender(
      <ChatView
        chat={other}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={2}
      />,
    );
    await waitFor(() => expect(screen.getByText("old reply")).toBeInTheDocument());
    expect(screen.queryByText("Thinking…")).toBeNull();
    expect(screen.queryByText("partial-A")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    await act(async () => {
      release();
    });
    // still on other chat — stream finish must not append into this thread
    await waitFor(() => expect(addMessage).toHaveBeenCalled());
    expect(screen.queryByText("partial-A")).toBeNull();
    expect(screen.getByText("old reply")).toBeInTheDocument();
  });

  it("regenerate drops later messages and streams a new reply", async () => {
    const user = userEvent.setup();
    const u1 = msg({ id: "u1", role: "user", content: "prompt" });
    const a1 = msg({ id: "a1", role: "assistant", content: "old answer" });
    const u2 = msg({ id: "u2", role: "user", content: "follow-up" });
    listRecentMessages.mockResolvedValue([u1, a1, u2]);
    listMessages.mockResolvedValue([u1, a1, u2]);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    streamChat.mockImplementation(async (opts: { onToken: (t: string) => void }) => {
      opts.onToken("fresh");
      await gate;
    });

    render(
      <ChatView
        chat={{ ...chat, title: "Thread" }}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() => expect(screen.getByText("old answer")).toBeInTheDocument());
    await user.click(screen.getAllByRole("button", { name: "Regenerate" })[0]);

    await waitFor(() => expect(deleteMessagesAfter).toHaveBeenCalledWith("c1", "u1"));
    await waitFor(() => expect(screen.queryByText("old answer")).toBeNull());
    expect(screen.queryByText("follow-up")).toBeNull();
    expect(await screen.findByText("Thinking…")).toBeInTheDocument();
    expect(screen.getByText("fresh")).toBeInTheDocument();

    await act(async () => {
      release();
    });
    await waitFor(() => expect(screen.queryByText("Thinking…")).toBeNull());
    expect(screen.getByText("fresh")).toBeInTheDocument();
    expect(addMessage).toHaveBeenCalledWith("c1", "assistant", "fresh");
  });

  it("accepts a second send while the first reply is still streaming", async () => {
    const user = userEvent.setup();
    const releases: Array<() => void> = [];
    const streamCalls: Array<{ onToken: (t: string) => void }> = [];
    streamChat.mockImplementation(async (opts: { onToken: (t: string) => void }) => {
      streamCalls.push(opts);
      const n = streamCalls.length;
      opts.onToken(`reply-${n}-part`);
      await new Promise<void>((r) => {
        releases[n - 1] = r;
      });
    });

    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    const box = await screen.findByPlaceholderText("Ask AI anything…");
    await user.type(box, "first");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("first")).toBeInTheDocument());

    // Second send must not be blocked by the in-flight stream
    await user.type(box, "second");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("second")).toBeInTheDocument());
    expect(box).toHaveValue("");

    // First stream still active — Stop remains for the viewed stream
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => {
      releases[0]?.();
    });
    await waitFor(() =>
      expect(addMessage).toHaveBeenCalledWith("c1", "assistant", "reply-1-part"),
    );
    // Second turn starts only after the first settles (per-chat FIFO)
    await waitFor(() => expect(streamCalls.length).toBe(2));
    await act(async () => {
      releases[1]?.();
    });
    await waitFor(() =>
      expect(addMessage).toHaveBeenCalledWith("c1", "assistant", "reply-2-part"),
    );
    await waitFor(() => expect(screen.queryByText("Thinking…")).toBeNull());

    // Order: first user → first reply → second user → second reply
    const texts = Array.from(
      document.querySelectorAll(".msg-content"),
    ).map((el) => el.textContent ?? "");
    const firstIdx = texts.findIndex((t) => t.includes("first"));
    const reply1Idx = texts.findIndex((t) => t.includes("reply-1-part"));
    const secondIdx = texts.findIndex((t) => t.includes("second"));
    const reply2Idx = texts.findIndex((t) => t.includes("reply-2-part"));
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(reply1Idx).toBeGreaterThan(firstIdx);
    expect(secondIdx).toBeGreaterThan(reply1Idx);
    expect(reply2Idx).toBeGreaterThan(secondIdx);
  });

  it("Stop cancels a queued second send before it streams", async () => {
    const user = userEvent.setup();
    const streamCalls: Array<{ onToken: (t: string) => void }> = [];
    streamChat.mockImplementation(async (opts: { onToken: (t: string) => void }) => {
      streamCalls.push(opts);
      opts.onToken(`reply-${streamCalls.length}`);
      if (streamCalls.length === 1) {
        await new Promise((_r, reject) => {
          const abort = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          };
          if (opts.abortSignal?.aborted) abort();
          else opts.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      }
    });

    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    const box = await screen.findByPlaceholderText("Ask AI anything…");
    await user.type(box, "first");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("first")).toBeInTheDocument());

    await user.type(box, "queued");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("queued")).toBeInTheDocument());
    expect(streamCalls.length).toBe(1);

    // Stop aborts the live stream AND the turn still waiting in the FIFO
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull(),
    );
    // Give the queue a chance to (incorrectly) start turn 2
    await act(async () => {
      await Promise.resolve();
    });
    expect(streamCalls.length).toBe(1);
    expect(screen.queryByText(/aborted/i)).toBeNull();
    // Abort before persist → temp row removed, draft restored to composer
    const list = document.querySelector(".messages")!;
    expect(list.textContent).not.toContain("queued");
    await waitFor(() => expect(box).toHaveValue("queued"));
  });

  it("regenerate notifies when the message is no longer in the chat", async () => {
    const user = userEvent.setup();
    const onNotify = vi.fn();
    const u1 = msg({ id: "u1", role: "user", content: "prompt" });
    const a1 = msg({ id: "a1", role: "assistant", content: "old answer" });
    listRecentMessages.mockResolvedValue([u1, a1]);
    listMessages.mockResolvedValue([u1, a1]);

    render(
      <ChatView
        chat={{ ...chat, title: "Thread" }}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={onNotify}
        focusNonce={1}
      />,
    );
    await waitFor(() => expect(screen.getByText("old answer")).toBeInTheDocument());
    listMessages.mockResolvedValue([]);
    await user.click(screen.getAllByRole("button", { name: "Regenerate" })[0]);
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        "That message is no longer in this chat.",
        "err",
      ),
    );
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("keeps optimistic pending sends after a history reload race", async () => {
    const user = userEvent.setup();
    const stored: Message[] = [];
    addMessage.mockImplementation(async (chatId, role, content) => {
      const m = msg({
        id: crypto.randomUUID(),
        chat_id: chatId,
        role,
        content,
        // Persisted reply is *older* than the second paint — sort would lie
        created_at: role === "assistant" ? Date.now() - 10_000 : Date.now(),
      });
      stored.push(m);
      return m;
    });
    listMessages.mockImplementation(async () => [...stored]);
    // Racing load while "second" is still unpersisted: page lacks it
    listRecentMessages.mockImplementation(async () =>
      stored.filter((m) => m.content !== "second"),
    );

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    streamChat.mockImplementation(async (opts: { onToken: (t: string) => void }) => {
      opts.onToken("reply-one");
      await gate;
    });

    const other: Chat = { ...chat, id: "c2", title: "Other" };
    const props = {
      onChatUpdated: vi.fn(),
      onChatMeta: vi.fn(),
      onNew: vi.fn(),
      onBranch: vi.fn(async () => {}),
      onNotify: vi.fn(),
      focusNonce: 1,
    };
    const { rerender } = render(<ChatView chat={chat} {...props} />);
    const box = await screen.findByPlaceholderText("Ask AI anything…");
    await user.type(box, "first");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    await user.type(box, "second");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("second")).toBeInTheDocument());

    // Leave mid-stream so the load effect re-runs mergeHistory on return
    rerender(<ChatView chat={other} {...props} focusNonce={2} />);
    rerender(<ChatView chat={chat} {...props} focusNonce={3} />);
    await waitFor(() => expect(screen.getByText("first")).toBeInTheDocument());

    await act(async () => {
      release();
    });
    await waitFor(() =>
      expect(addMessage).toHaveBeenCalledWith("c1", "assistant", "reply-one"),
    );
    await waitFor(() => expect(screen.queryByText("Thinking…")).toBeNull());

    // mergeHistory must keep pending "second" after the reload + reply
    const texts = Array.from(
      document.querySelectorAll(".msg-content"),
    ).map((el) => el.textContent ?? "");
    const replyIdx = texts.findIndex((t) => t.includes("reply-one"));
    const secondIdx = texts.findIndex((t) => t.includes("second"));
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(replyIdx);
  });

  it("streams a new chat's send while another chat's reply is in flight", async () => {
    const user = userEvent.setup();
    const gates: Record<string, (() => void) | undefined> = {};
    const chatSeen: string[] = [];
    streamChat.mockImplementation(
      async (opts: {
        messages: Array<{ content: unknown }>;
        onToken: (t: string) => void;
      }) => {
        const last = opts.messages[opts.messages.length - 1];
        const text =
          typeof last?.content === "string"
            ? last.content
            : JSON.stringify(last?.content);
        chatSeen.push(text);
        opts.onToken(`echo:${text}`);
        await new Promise<void>((r) => {
          gates[text] = r;
        });
      },
    );

    listRecentMessages.mockImplementation(async (id: string) => {
      if (id === "c2") {
        return [msg({ id: "old-c2", chat_id: "c2", role: "user", content: "hi c2" })];
      }
      return [];
    });
    // Default listMessages (beforeEach) already returns what addMessage stored;
    // seed c2 history on top of that via the stored list in the default mock.
    const baseListMessages = listMessages.getMockImplementation()!;
    listMessages.mockImplementation(async (id: string) => {
      const storedMsgs = await baseListMessages(id);
      if (id === "c2" && storedMsgs.length === 0) {
        return [msg({ id: "old-c2", chat_id: "c2", role: "user", content: "hi c2" })];
      }
      if (id === "c2") {
        return [
          msg({ id: "old-c2", chat_id: "c2", role: "user", content: "hi c2" }),
          ...storedMsgs,
        ];
      }
      return storedMsgs;
    });

    const other: Chat = { ...chat, id: "c2", title: "Other" };
    const { rerender } = render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    const box = await screen.findByPlaceholderText("Ask AI anything…");
    await user.type(box, "alpha");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    // Switch to another chat while stream A is still running — send must work
    rerender(
      <ChatView
        chat={other}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={2}
      />,
    );
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    const box2 = await screen.findByPlaceholderText("Ask AI anything…");
    await user.type(box2, "beta");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText("beta")).toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByText("echo:beta")).toBeInTheDocument();

    // Finish stream B — still on chat B, must not touch chat A's turn
    await act(async () => {
      gates["beta"]?.();
    });
    await waitFor(() =>
      expect(addMessage).toHaveBeenCalledWith("c2", "assistant", "echo:beta"),
    );
    await waitFor(() => expect(screen.queryByText("Thinking…")).toBeNull());

    // Return to chat A — stream A still live, Stop back
    rerender(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={3}
      />,
    );
    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByText("echo:alpha")).toBeInTheDocument();

    await act(async () => {
      gates["alpha"]?.();
    });
    await waitFor(() =>
      expect(addMessage).toHaveBeenCalledWith("c1", "assistant", "echo:alpha"),
    );
    expect(chatSeen).toContain("alpha");
    expect(chatSeen.some((t) => t.includes("beta"))).toBe(true);
  });

  it("shows scroll-to-bottom when scrolled up and jumps on click", async () => {
    const user = userEvent.setup();
    listRecentMessages.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) =>
        msg({
          id: `m${i}`,
          role: i % 2 ? "assistant" : "user",
          content: `line-${i}`,
        }),
      ),
    );

    render(
      <ChatView
        chat={{ ...chat, title: "Thread" }}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() => expect(screen.getByText("line-0")).toBeInTheDocument());

    const scroller = document.querySelector(".messages") as HTMLDivElement;
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      get: () => 2000,
    });
    Object.defineProperty(scroller, "clientHeight", {
      configurable: true,
      get: () => 400,
    });
    scroller.scrollTop = 10;
    scroller.dispatchEvent(new Event("scroll"));

    expect(
      await screen.findByRole("button", { name: "Scroll to bottom" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Scroll to bottom" }));
    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
    expect(
      screen.queryByRole("button", { name: "Scroll to bottom" }),
    ).toBeNull();
  });
});
