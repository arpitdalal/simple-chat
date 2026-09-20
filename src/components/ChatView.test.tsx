import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Chat, Message } from "../lib/db";

const streamChat = vi.fn();
const generateChatTitle = vi.fn();
const addMessage = vi.fn();
const listRecentMessages = vi.fn();
const listOlderMessages = vi.fn();
const updateChat = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}));

vi.mock("../lib/chat", () => ({
  streamChat: (...a: unknown[]) => streamChat(...a),
  generateChatTitle: (...a: unknown[]) => generateChatTitle(...a),
}));

vi.mock("../lib/keys", () => ({
  hasApiKey: vi.fn(async () => true),
}));

vi.mock("../lib/db", () => ({
  addMessage: (...a: unknown[]) => addMessage(...a),
  listRecentMessages: (...a: unknown[]) => listRecentMessages(...a),
  listOlderMessages: (...a: unknown[]) => listOlderMessages(...a),
  updateChat: (...a: unknown[]) => updateChat(...a),
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
    listRecentMessages.mockResolvedValue([]);
    listOlderMessages.mockResolvedValue([]);
    updateChat.mockResolvedValue(undefined);
    generateChatTitle.mockResolvedValue("Auto Title");
    addMessage.mockImplementation(async (_id, role, content) =>
      msg({ id: crypto.randomUUID(), role, content }),
    );
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

  it("sets provisional title and requests auto-title for New Chat", async () => {
    const user = userEvent.setup();
    const onChatMeta = vi.fn();
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={onChatMeta}
        onNew={vi.fn()}
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

  it("shows error banner on stream failure", async () => {
    const user = userEvent.setup();
    streamChat.mockRejectedValue(new Error("No API key for google"));
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        focusNonce={1}
      />,
    );
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Ask AI anything…")).toBeInTheDocument(),
    );
    await user.type(screen.getByPlaceholderText("Ask AI anything…"), "fail");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("No API key for google")).toBeInTheDocument();
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

  it("attaches pasted images", async () => {
    render(
      <ChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
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
});
