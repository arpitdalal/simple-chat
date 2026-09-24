import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { Chat, Message } from "./db";

const streamChat = vi.fn();
const addMessage = vi.fn();
const getChat = vi.fn();
const listRecentMessages = vi.fn();
const listOlderMessages = vi.fn();
const listMessages = vi.fn();
const loadMessageImages = vi.fn();
const clearChatMessages = vi.fn();
const deleteChat = vi.fn();
const updateChat = vi.fn();
const setInitialChatTitle = vi.fn();
const messageCount = vi.fn();
const store = new Map<string, Message[]>();
let clock = 0;

vi.mock("./chat", () => ({
  streamChat: (...args: unknown[]) => streamChat(...args),
  generateChatTitle: vi.fn(async () => "Title"),
}));
vi.mock("./db", () => ({
  IMAGE_ATTACHMENT_PLACEHOLDER: "[Image attachment]",
  addMessage: (...args: unknown[]) => addMessage(...args),
  getChat: (...args: unknown[]) => getChat(...args),
  listRecentMessages: (...args: unknown[]) => listRecentMessages(...args),
  listOlderMessages: (...args: unknown[]) => listOlderMessages(...args),
  listMessages: (...args: unknown[]) => listMessages(...args),
  loadMessageImages: (...args: unknown[]) => loadMessageImages(...args),
  deleteMessagesAfter: vi.fn(async () => {}),
  clearChatMessages: (...args: unknown[]) => clearChatMessages(...args),
  deleteChat: (...args: unknown[]) => deleteChat(...args),
  updateChat: (...args: unknown[]) => updateChat(...args),
  setInitialChatTitle: (...args: unknown[]) => setInitialChatTitle(...args),
  refreshChatPreview: vi.fn(async () => {}),
  replaceChatTitle: vi.fn(async () => true),
  messageCount: (...args: unknown[]) => messageCount(...args),
}));

import {
  chatCanBeDiscarded,
  getChatSession,
  normalizeImageDataUrl,
  resetChatSessions,
  sessionHasWork,
} from "./chat-runtime";

const chat = (id: string): Chat => ({
  id, title: "Thread", provider: "google", model_id: "gemini-3.8-flash",
  created_at: 1, updated_at: 1, preview: "prompt", pinned: 0,
});
const callbacks = {
  onChatUpdated: vi.fn(), onChatMeta: vi.fn(), onNotify: vi.fn(),
};
const pngImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";

beforeEach(() => {
  resetChatSessions();
  vi.clearAllMocks();
  store.clear();
  clock = 0;
  getChat.mockImplementation(async (id: string) => chat(id));
  listRecentMessages.mockImplementation(async (id: string, limit: number) =>
    (store.get(id) ?? []).slice(-limit).map((message) => ({
      ...message,
      images: [],
      image_count: message.image_count ?? message.images.length,
    })),
  );
  listOlderMessages.mockResolvedValue([]);
  listMessages.mockImplementation(async (id: string) =>
    (store.get(id) ?? []).map((message) => ({
      ...message,
      images: [],
      image_count: message.image_count ?? message.images.length,
    })),
  );
  loadMessageImages.mockImplementation(async (
    id: string,
    _throughMessageId: string,
    maxChars: number,
    maxImages: number,
  ) => {
    const selected = new Map<string, string[]>();
    let chars = 0;
    let images = 0;
    for (const message of [...(store.get(id) ?? [])].reverse()) {
      if (!message.images.length) continue;
      const nextChars = chars + JSON.stringify(message.images).length;
      const nextImages = images + message.images.length;
      if (nextChars > maxChars || nextImages > maxImages) break;
      selected.set(message.id, message.images);
      chars = nextChars;
      images = nextImages;
    }
    return selected;
  });
  addMessage.mockImplementation(async (id: string, role: Message["role"], content: string, createdAt = Date.now(), images: string[] = []) => {
    const message: Message = { id: crypto.randomUUID(), chat_id: id, role, content, images, created_at: createdAt };
    store.set(id, [...(store.get(id) ?? []), message]);
    return message;
  });
  clearChatMessages.mockImplementation(async (id: string) => { store.set(id, []); });
  deleteChat.mockImplementation(async (id: string) => { store.delete(id); });
  updateChat.mockResolvedValue(undefined);
  setInitialChatTitle.mockResolvedValue(true);
  messageCount.mockImplementation(async (id: string) => (store.get(id) ?? []).length);
  streamChat.mockImplementation(async ({ onToken }: { onToken: (token: string) => void }) => {
    onToken("reply");
  });
});

describe("ChatSession", () => {
  it("normalizes generic base64 image data URLs from file pickers", () => {
    expect(normalizeImageDataUrl(
      `data:application/octet-stream;base64,${pngImage.split(",")[1]}`,
    )).toMatchObject({ image: pngImage, width: 1, height: 1 });
  });

  it("masks VP8L metadata bits when reading height", () => {
    const bytes = new Uint8Array(30);
    bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c]);
    bytes[20] = 0x2f;
    bytes[21] = 0xff;
    bytes[22] = 0x0f;
    bytes[23] = 0xff;
    bytes[24] = 0x13;
    const data = `data:image/webp;base64,${btoa(String.fromCharCode(...bytes))}`;
    expect(normalizeImageDataUrl(data)).toMatchObject({ width: 4096, height: 4093 });
  });

  it("preserves literal attachment sentinel text without images", async () => {
    const session = getChatSession("a");
    session.send(chat("a"), "[Image attachment]", [], callbacks);
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(streamChat.mock.calls[0][0].messages).toEqual([{
      role: "user",
      content: "[Image attachment]",
    }]);
  });

  it("does not reload older history after the window hides", async () => {
    const session = getChatSession("a");
    const unsubscribe = session.subscribe(() => {});
    store.set("a", Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`, chat_id: "a", role: "user" as const, content: `m${i}`, images: [], created_at: i,
    })));
    await session.loadRecent();
    let release!: (rows: Message[]) => void;
    listOlderMessages.mockImplementationOnce(() => new Promise<Message[]>((resolve) => { release = resolve; }));
    const loading = session.loadOlder();
    session.trim();
    release([{ id: "old", chat_id: "a", role: "user", content: "old", images: [], created_at: -1 }]);
    await loading;
    expect(session.getSnapshot().messages).toHaveLength(50);
    unsubscribe();
  });

  it("keeps unrestored drafts from empty-chat deletion", async () => {
    addMessage.mockRejectedValueOnce(new Error("db down"));
    const session = getChatSession("a");
    session.send(chat("a"), "keep", [], callbacks);
    await waitFor(() => expect(session.getSnapshot().drafts).toEqual([{ text: "keep", images: [] }]));
    expect(sessionHasWork("a")).toBe(true);
    expect(await chatCanBeDiscarded("a")).toBe(false);
  });

  it("does not discard a chat that already has messages", async () => {
    store.set("a", [{ id: "m", chat_id: "a", role: "user", content: "hi", images: [], created_at: 1 }]);
    expect(sessionHasWork("a")).toBe(false);
    expect(await chatCanBeDiscarded("a")).toBe(false);
  });

  it("discards an idle empty chat", async () => {
    expect(await chatCanBeDiscarded("empty")).toBe(true);
  });

  it("drops leftover drafts when a later send starts", async () => {
    addMessage.mockRejectedValueOnce(new Error("db down"));
    const session = getChatSession("a");
    session.send(chat("a"), "first", [], callbacks);
    await waitFor(() => expect(session.getSnapshot().drafts).toEqual([{ text: "first", images: [] }]));
    session.send(chat("a"), "second", [], callbacks);
    expect(session.getSnapshot().drafts).toEqual([]);
  });

  it("drops failed-send image data after the window hides", async () => {
    let failInsert!: (error: Error) => void;
    addMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => { failInsert = reject; }));
    const session = getChatSession("a");
    session.send(chat("a"), "image", [pngImage], callbacks);
    await waitFor(() => expect(failInsert).toBeTruthy());
    session.dropDraftImages();
    failInsert(new Error("database unavailable"));
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(session.getSnapshot().drafts).toEqual([{ text: "image", images: [] }]);
  });

  it("keeps sent images in optimistic, persisted, and provider messages", async () => {
    const image = pngImage;
    const session = getChatSession("a");
    const unsubscribe = session.subscribe(() => {});
    session.send(chat("a"), "describe", [image], callbacks);

    expect(session.getSnapshot().messages[0]).toMatchObject({
      content: "describe",
      images: [image],
    });
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(addMessage).toHaveBeenCalledWith(
      "a",
      "user",
      "describe",
      expect.any(Number),
      [image],
    );
    expect(store.get("a")?.[0].images).toEqual([image]);
    expect(session.getSnapshot().messages[0]).toMatchObject({
      images: [],
      image_count: 1,
    });
    expect(streamChat.mock.calls[0][0].messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "describe" },
        { type: "image", image },
      ],
    });
    unsubscribe();
  });

  it("rejects oversized image sets before sending", () => {
    const images = Array.from({ length: 5 }, () => pngImage);
    const session = getChatSession("a");
    expect(session.send(chat("a"), "look", images, callbacks)).toBe(false);
    expect(callbacks.onNotify).toHaveBeenCalledWith(
      "Attach no more than 4 images per message.",
      "err",
    );
    expect(session.getSnapshot().busy).toBe(false);
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("bounds historical images in later provider requests", async () => {
    store.set("a", Array.from({ length: 21 }, (_, index) => ({
      id: `u${index}`,
      chat_id: "a",
      role: "user" as const,
      content: index === 0 ? "compare this" : "",
      images: [pngImage],
      created_at: index,
    })));
    const session = getChatSession("a");
    session.send(chat("a"), "follow up", [], callbacks);
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));

    const messages = streamChat.mock.calls[0][0].messages;
    const imageCount = messages.flatMap((message: { content: unknown }) =>
      Array.isArray(message.content)
        ? message.content.filter((part) => (part as { type?: string }).type === "image")
        : [],
    ).length;
    expect(imageCount).toBe(20);
    expect(messages[0]).toEqual({
      role: "user",
      content: "compare this\n\nEarlier image attachment omitted due to context limits.",
    });
  });

  it("keeps provider history as a contiguous suffix when a turn exceeds budget", async () => {
    store.set("a", [
      { id: "old", chat_id: "a", role: "user", content: "oldest", images: [], image_count: 0, created_at: 1 },
      { id: "large", chat_id: "a", role: "assistant", content: "x".repeat(1_048_577), images: [], image_count: 0, created_at: 2 },
      { id: "new", chat_id: "a", role: "user", content: "newest", images: [], image_count: 0, created_at: 3 },
    ]);
    const session = getChatSession("a");
    session.send(chat("a"), "follow up", [], callbacks);
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(streamChat.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "newest" },
      { role: "user", content: "follow up" },
    ]);
  });

  it("includes persisted images when regenerating a response", async () => {
    const image = pngImage;
    store.set("a", [{
      id: "u1",
      chat_id: "a",
      role: "user",
      content: "",
      images: [image],
      created_at: 1,
    }]);
    const session = getChatSession("a");
    expect(session.regenerate(chat("a"), "u1", callbacks)).toBe(true);
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(streamChat.mock.calls[0][0].messages).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "Describe these images." },
        { type: "image", image },
      ],
    }]);
  });

  it("keeps an App-owned session canonical across view unmounts", () => {
    const session = getChatSession("a");
    const release = session.retain();
    const unsubscribe = session.subscribe(() => {});
    unsubscribe();
    expect(getChatSession("a")).toBe(session);
    release();
    expect(getChatSession("a")).not.toBe(session);
  });

  it("removes the pending stream if stopped before the request starts", async () => {
    let release!: () => void;
    getChat.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return chat("a");
    });
    const session = getChatSession("a");
    session.send(chat("a"), "one", [], callbacks);
    await waitFor(() => expect(release).toBeTruthy());
    session.stop();
    release();
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(session.getSnapshot().stream).toBeNull();
    expect(streamChat).not.toHaveBeenCalled();
  });

  it("queues turns within a chat and keeps each reply beside its prompt", async () => {
    let finishFirst!: () => void;
    streamChat.mockImplementationOnce(async ({ onToken }: { onToken: (token: string) => void }) => {
      onToken("one reply");
      await new Promise<void>((resolve) => { finishFirst = resolve; });
    }).mockImplementationOnce(async ({ onToken }: { onToken: (token: string) => void }) => {
      onToken("two reply");
    });
    const session = getChatSession("a");
    const unsubscribe = session.subscribe(() => {});
    session.send(chat("a"), "one", [], callbacks);
    session.send(chat("a"), "two", [], callbacks);
    await waitFor(() => expect(finishFirst).toBeTruthy());
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(session.getSnapshot().messages.map((m) => m.content)).toEqual(["one", "two"]);
    finishFirst();
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(session.getSnapshot().messages.map((m) => m.content)).toEqual([
      "one", "one reply", "two", "two reply",
    ]);
    unsubscribe();
  });

  it("streams different chats concurrently", async () => {
    const gates = new Map<string, () => void>();
    streamChat.mockImplementation(async ({ messages, onToken }: {
      messages: Array<{ content: string }>;
      onToken: (token: string) => void;
    }) => {
      const prompt = messages[messages.length - 1].content;
      onToken(`reply to ${prompt}`);
      await new Promise<void>((resolve) => { gates.set(prompt, resolve); });
    });
    const a = getChatSession("a");
    const b = getChatSession("b");
    a.send(chat("a"), "alpha", [], callbacks);
    b.send(chat("b"), "beta", [], callbacks);
    await waitFor(() => expect(gates.size).toBe(2));
    expect(a.getSnapshot().stream?.text).toBe("reply to alpha");
    expect(b.getSnapshot().stream?.text).toBe("reply to beta");
    gates.get("alpha")!();
    gates.get("beta")!();
    await waitFor(() => expect(a.getSnapshot().busy || b.getSnapshot().busy).toBe(false));
    expect(store.get("a")?.map((m) => m.content)).toEqual(["alpha", "reply to alpha"]);
    expect(store.get("b")?.map((m) => m.content)).toEqual(["beta", "reply to beta"]);
  });

  it("retries a failed assistant insert without losing the streamed reply", async () => {
    const insert = addMessage.getMockImplementation()!;
    let failed = false;
    addMessage.mockImplementation(async (id: string, role: Message["role"], content: string) => {
      if (role === "assistant" && !failed) {
        failed = true;
        throw new Error("temporary database error");
      }
      return insert(id, role, content);
    });
    const session = getChatSession("a");
    session.send(chat("a"), "hello", [], callbacks);
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(store.get("a")?.map((m) => m.content)).toEqual(["hello", "reply"]);
    expect(callbacks.onNotify).not.toHaveBeenCalled();
  });

  it("continues queued turns while an optional title write is pending", async () => {
    getChat.mockImplementation(async (id: string) => ({ ...chat(id), title: "New Chat" }));
    let releaseTitle!: () => void;
    setInitialChatTitle.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      releaseTitle = () => resolve(true);
    }));
    const session = getChatSession("a");
    session.send(chat("a"), "one", [], callbacks);
    session.send(chat("a"), "two", [], callbacks);
    await waitFor(() => expect(releaseTitle).toBeTruthy());
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    expect(store.get("a")?.map((m) => m.content)).toEqual(["one", "reply", "two", "reply"]);
    releaseTitle();
  });

  it("reconciles cached messages if deleting the chat partially fails", async () => {
    const session = getChatSession("a");
    const unsubscribe = session.subscribe(() => {});
    session.send(chat("a"), "one", [], callbacks);
    await waitFor(() => expect(session.getSnapshot().busy).toBe(false));
    deleteChat.mockImplementationOnce(async (id: string) => {
      store.set(id, []);
      throw new Error("delete failed");
    });
    await expect(session.delete()).rejects.toThrow("delete failed");
    expect(session.getSnapshot().phase).toBe("idle");
    expect(session.getSnapshot().messages).toEqual([]);
    unsubscribe();
  });

  it("deletes a chat that is still clearing", async () => {
    let finishClear!: () => void;
    clearChatMessages.mockImplementationOnce(async (id: string) => {
      await new Promise<void>((resolve) => { finishClear = resolve; });
      store.set(id, []);
    });
    const session = getChatSession("a");
    const unsubscribe = session.subscribe(() => {});
    store.set("a", [{ id: "m", chat_id: "a", role: "user", content: "hi", images: [], created_at: 1 }]);
    const clearing = session.clear();
    await waitFor(() => expect(session.getSnapshot().phase).toBe("clearing"));
    const deleting = session.delete();
    await waitFor(() => expect(session.getSnapshot().phase).toBe("deleting"));
    finishClear();
    await clearing;
    await deleting;
    expect(deleteChat).toHaveBeenCalledWith("a");
    expect(session.getSnapshot().phase).toBe("deleted");
    unsubscribe();
  });

  it("waits for an in-flight insert before Clear and discards queued turns", async () => {
    let finishInsert!: () => void;
    addMessage.mockImplementationOnce(async (id: string, role: Message["role"], content: string) => {
      await new Promise<void>((resolve) => { finishInsert = resolve; });
      const message: Message = { id: "u1", chat_id: id, role, content, images: [], created_at: ++clock };
      store.set(id, [...(store.get(id) ?? []), message]);
      return message;
    });
    const session = getChatSession("a");
    session.send(chat("a"), "one", [], callbacks);
    session.send(chat("a"), "two", [], callbacks);
    await waitFor(() => expect(finishInsert).toBeTruthy());
    const clearing = session.clear();
    expect(session.getSnapshot().phase).toBe("clearing");
    expect(clearChatMessages).not.toHaveBeenCalled();
    finishInsert();
    await clearing;
    expect(addMessage).toHaveBeenCalledTimes(1);
    expect(store.get("a")).toEqual([]);
    expect(session.getSnapshot().messages).toEqual([]);
    expect(session.getSnapshot().drafts).toEqual([]);
  });
});
