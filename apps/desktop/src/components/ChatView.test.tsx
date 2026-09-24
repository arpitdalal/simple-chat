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
const setInitialChatTitle = vi.fn();
const replaceChatTitle = vi.fn();
const getChat = vi.fn();
const loadMessageImage = vi.fn();
const loadMessageImages = vi.fn();

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
  setInitialChatTitle: (...a: unknown[]) => setInitialChatTitle(...a),
  refreshChatPreview: vi.fn(async () => {}),
  replaceChatTitle: (...a: unknown[]) => replaceChatTitle(...a),
  getChat: (...a: unknown[]) => getChat(...a),
  loadMessageImage: (...a: unknown[]) => loadMessageImage(...a),
  loadMessageImages: (...a: unknown[]) => loadMessageImages(...a),
}));

import { ChatView } from "./ChatView";
import { getChatSession, resetChatSessions } from "../lib/chat-runtime";

function TestChatView(props: Omit<Parameters<typeof ChatView>[0], "session">) {
  return <ChatView key={props.chat?.id ?? "__empty__"} {...props} session={getChatSession(props.chat?.id ?? "__empty__")} />;
}

const pngImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
const pngBytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"), (character) => character.charCodeAt(0));

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
    images: [],
    created_at: Date.now(),
    ...partial,
  };
}

describe("ChatView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatSessions();
    hiddenListeners.clear();
    listRecentMessages.mockResolvedValue([]);
    listOlderMessages.mockResolvedValue([]);
    listMessages.mockResolvedValue([]);
    deleteMessagesAfter.mockResolvedValue(undefined);
    updateChat.mockResolvedValue(undefined);
    setInitialChatTitle.mockResolvedValue(true);
    replaceChatTitle.mockResolvedValue(true);
    getChat.mockImplementation(async (id: string) => ({ ...chat, id }));
    loadMessageImage.mockResolvedValue(null);
    loadMessageImages.mockResolvedValue(new Map());
    generateChatTitle.mockResolvedValue("Auto Title");
    addMessage.mockImplementation(async (_id, role, content, _createdAt, images: string[] = []) =>
      msg({ id: crypto.randomUUID(), role, content, images }),
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
      <TestChatView
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
      <TestChatView
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
      <TestChatView
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
    expect(setInitialChatTitle).toHaveBeenCalledWith("c1", "domains");
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
      <TestChatView
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
    await waitFor(() => expect(screen.getByPlaceholderText("Ask AI anything…")).toHaveFocus());
    expect(screen.queryByText(/aborted/i)).toBeNull();
  });

  it("notifies on stream failure", async () => {
    const user = userEvent.setup();
    const onNotify = vi.fn();
    streamChat.mockRejectedValue(new Error("No API key for google"));
    render(
      <TestChatView
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
      <TestChatView
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
      <TestChatView
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
    await user.clear(ta);
    await waitFor(() => expect(ta).toHaveValue("first"));
  });

  it("does not restore failed images into a text-only newer draft", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    let rejectAdd!: (e: Error) => void;
    addMessage.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectAdd = reject;
        }),
    );
    render(
      <TestChatView
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
    const file = new File([pngBytes], "a.png", { type: "image/png" });
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
    vi.unstubAllGlobals();
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
      <TestChatView
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
      <TestChatView
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
        value: pngImage,
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
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );

    render(
      <TestChatView
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
                  new File([pngBytes], "pic.png", {
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
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    render(
      <TestChatView
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

    const file = new File([pngBytes], "pic.png", {
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
    vi.unstubAllGlobals();
  });

  it("inspects generic clipboard files by image signature", async () => {
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: ((ev: ProgressEvent<FileReader>) => void) | null = null;
        readAsDataURL() {
          this.result = `data:application/octet-stream;base64,${btoa(
            String.fromCharCode(...pngBytes),
          )}`;
          queueMicrotask(() =>
            this.onload?.(new ProgressEvent("load") as unknown as ProgressEvent<FileReader>),
          );
        }
      },
    );
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    const textarea = await screen.findByPlaceholderText("Ask AI anything…");
    const file = new File([pngBytes], "clipboard.bin", {
      type: "application/octet-stream",
    });
    await act(async () => {
      textarea.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          clipboardData: {
            items: [{ type: file.type, getAsFile: () => file }],
          } as unknown as DataTransfer,
        }),
      );
    });

    await waitFor(() => expect(document.querySelector(".thumb img")).toBeTruthy());
    vi.unstubAllGlobals();
  });

  it("preserves selected image order across asynchronous reads", async () => {
    const user = userEvent.setup();
    let readCount = 0;
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          const index = readCount++;
          const result = index === 0
            ? "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABQUFB"
            : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABQkJC";
          window.setTimeout(() => {
            this.result = result;
            this.onload?.();
          }, index === 0 ? 20 : 0);
        }
      },
    );
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 100;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await screen.findByPlaceholderText("Ask AI anything…");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [
          new File(["first"], "first.png", { type: "image/png" }),
          new File(["second"], "second.png", { type: "image/png" }),
        ],
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(document.querySelectorAll(".thumb img")).toHaveLength(2));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(addMessage).toHaveBeenCalled());
    expect(addMessage).toHaveBeenCalledWith(
      "c1",
      "user",
      "",
      expect.any(Number),
      [
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABQUFB",
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABQkJC",
      ],
    );
    vi.unstubAllGlobals();
  });

  it("keeps a pending duplicate independent from a removed copy", async () => {
    const user = userEvent.setup();
    const pendingReaders: Array<{
      result: string | null;
      onload: (() => void) | null;
    }> = [];
    let readCount = 0;
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          readCount += 1;
          if (readCount === 1) {
            this.result = pngImage;
            queueMicrotask(() => this.onload?.());
          } else {
            pendingReaders.push(this);
          }
        }
      },
    );
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await screen.findByPlaceholderText("Ask AI anything…");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [
          new File(["same"], "same.png", { type: "image/png" }),
          new File(["same"], "same.png", { type: "image/png" }),
        ],
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(document.querySelectorAll(".thumb")).toHaveLength(1));
    await waitFor(() => expect(pendingReaders).toHaveLength(1));

    await user.click(document.querySelector(".thumb")!);
    expect(document.querySelectorAll(".thumb")).toHaveLength(0);
    await act(async () => {
      pendingReaders[0]!.result = pngImage;
      pendingReaders[0]!.onload?.();
      await Promise.resolve();
    });

    await waitFor(() => expect(document.querySelectorAll(".thumb")).toHaveLength(1));
    vi.unstubAllGlobals();
  });

  it("does not send text while selected images are still loading", async () => {
    const user = userEvent.setup();
    const onNotify = vi.fn();
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {}
      },
    );
    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={onNotify}
        focusNonce={1}
      />,
    );
    const textarea = await screen.findByPlaceholderText("Ask AI anything…");
    await user.type(textarea, "wait");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [new File(["image"], "image.png", { type: "image/png" })],
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await user.keyboard("{Enter}");

    expect(onNotify).toHaveBeenCalledWith(
      "Wait for attached images to finish loading.",
      "err",
    );
    expect(streamChat).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("wait");
    vi.unstubAllGlobals();
  });

  it("stops a cleared attachment batch without reading remaining files", async () => {
    const user = userEvent.setup();
    const readers: Array<{
      result: string | null;
      onload: ((ev: ProgressEvent<FileReader>) => void) | null;
    }> = [];
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: ((ev: ProgressEvent<FileReader>) => void) | null = null;
        readAsDataURL() {
          readers.push(this);
        }
      },
    );
    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    const textarea = await screen.findByPlaceholderText("Ask AI anything…");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [
          new File(["first"], "first.png", { type: "image/png" }),
          new File(["second"], "second.png", { type: "image/png" }),
        ],
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(readers).toHaveLength(1));
    await act(async () => {
      for (const listener of hiddenListeners) listener();
    });
    await act(async () => {
      readers[0]!.result = pngImage;
      readers[0]!.onload?.(
        new ProgressEvent("load") as unknown as ProgressEvent<FileReader>,
      );
      await Promise.resolve();
    });

    expect(readers).toHaveLength(1);
    await user.type(textarea, "still available");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(streamChat).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it("rejects image bytes that do not match a supported format", async () => {
    const onNotify = vi.fn();
    const gif = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: (() => void) | null = null;
        readAsDataURL() {
          this.result = `data:image/png;base64,${gif}`;
          queueMicrotask(() => this.onload?.());
        }
      },
    );
    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={onNotify}
        focusNonce={1}
      />,
    );
    await screen.findByPlaceholderText("Ask AI anything…");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => {
      Object.defineProperty(input, "files", {
        value: [new File(["gif"], "spoof.bin", { type: "" })],
        configurable: true,
      });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        "Attach a PNG, JPEG, or WebP image.",
        "err",
      ),
    );
    expect(document.querySelector(".thumb")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("renders literal attachment text alongside a sent image", async () => {
    const user = userEvent.setup();
    const image = pngImage;
    vi.stubGlobal(
      "FileReader",
      class {
        result: string | null = null;
        onload: ((ev: ProgressEvent<FileReader>) => void) | null = null;
        readAsDataURL() {
          this.result = image;
          this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
        }
      },
    );
    vi.stubGlobal(
      "Image",
      class {
        naturalWidth = 100;
        naturalHeight = 100;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        set src(_value: string) {
          queueMicrotask(() => this.onload?.());
        }
      },
    );

    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );
    await user.type(
      await screen.findByPlaceholderText("Ask AI anything…"),
      "[[Image attachment]",
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "photo.png", { type: "image/png" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    loadMessageImage.mockResolvedValueOnce(image);
    await user.keyboard("{Enter}");

    const sentImage = await screen.findByAltText("Attached image 1");
    expect(sentImage).toHaveAttribute("src", image);
    expect(screen.getByText("[Image attachment]")).toBeInTheDocument();
    expect(addMessage).toHaveBeenCalledWith(
      "c1",
      "user",
      "[Image attachment]",
      expect.any(Number),
      [image],
    );
    vi.unstubAllGlobals();
  });

  it("renders a literal attachment placeholder when no image exists", async () => {
    listRecentMessages.mockResolvedValue([
      msg({ id: "literal", role: "user", content: "[Image attachment]" }),
    ]);
    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );

    expect(await screen.findByText("[Image attachment]")).toBeInTheDocument();
    expect(document.querySelector(".sent-images")).toBeNull();
  });

  it("loads persisted message images only when rendered", async () => {
    const image = pngImage;
    listRecentMessages.mockResolvedValue([
      msg({ id: "saved", role: "user", content: "look", image_count: 2 }),
    ]);
    loadMessageImage
      .mockResolvedValueOnce(image)
      .mockResolvedValueOnce("data:image/webp;base64,dHdv");
    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );

    expect(await screen.findByAltText("Attached image 1")).toHaveAttribute("src", image);
    expect(await screen.findByAltText("Attached image 2")).toHaveAttribute(
      "src",
      "data:image/webp;base64,dHdv",
    );
    expect(loadMessageImage).toHaveBeenCalledWith("c1", "saved", 0);
    expect(loadMessageImage).toHaveBeenCalledWith("c1", "saved", 1);
  });

  it("rejects image files larger than 3 MB", async () => {
    const onNotify = vi.fn();
    render(
      <TestChatView
        chat={chat}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={onNotify}
        focusNonce={1}
      />,
    );
    await screen.findByPlaceholderText("Ask AI anything…");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "large.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: 3 * 1024 * 1024 + 1 });

    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onNotify).toHaveBeenCalledWith(
      "Each attached image must be 3 MB or smaller.",
      "err",
    );
    expect(document.querySelector(".thumb")).toBeNull();
  });

  it("grows composer height with multiline input up to cap", async () => {
    const user = userEvent.setup();
    render(
      <TestChatView
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
      <TestChatView
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
      <TestChatView
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
      <TestChatView
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

  it("copies an image-only message with attachment context", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    listRecentMessages.mockResolvedValue([
      msg({ id: "image-only", role: "user", content: "", image_count: 1 }),
    ]);
    render(
      <TestChatView
        chat={{ ...chat, title: "Thread" }}
        onChatUpdated={vi.fn()}
        onChatMeta={vi.fn()}
        onNew={vi.fn()}
        onBranch={vi.fn(async () => {})}
        onNotify={vi.fn()}
        focusNonce={1}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith("[Image attachment]");
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
      <TestChatView
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
      <TestChatView
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
      <TestChatView
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
      <TestChatView
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
      <TestChatView
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
