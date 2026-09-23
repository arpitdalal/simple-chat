import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { Chat, Message } from "./db";

const streamChat = vi.fn();
const addMessage = vi.fn();
const getChat = vi.fn();
const listRecentMessages = vi.fn();
const clearChatMessages = vi.fn();
const deleteChat = vi.fn();
const updateChat = vi.fn();
const store = new Map<string, Message[]>();
let clock = 0;

vi.mock("./chat", () => ({
  streamChat: (...args: unknown[]) => streamChat(...args),
  generateChatTitle: vi.fn(async () => "Title"),
}));
vi.mock("./db", () => ({
  addMessage: (...args: unknown[]) => addMessage(...args),
  getChat: (...args: unknown[]) => getChat(...args),
  listRecentMessages: (...args: unknown[]) => listRecentMessages(...args),
  listOlderMessages: vi.fn(async () => []),
  listMessages: vi.fn(async () => []),
  deleteMessagesAfter: vi.fn(async () => {}),
  clearChatMessages: (...args: unknown[]) => clearChatMessages(...args),
  deleteChat: (...args: unknown[]) => deleteChat(...args),
  updateChat: (...args: unknown[]) => updateChat(...args),
  setInitialChatTitle: vi.fn(async () => true),
  replaceChatTitle: vi.fn(async () => true),
}));

import { getChatSession, resetChatSessions } from "./chat-runtime";

const chat = (id: string): Chat => ({
  id, title: "Thread", provider: "google", model_id: "gemini-3.8-flash",
  created_at: 1, updated_at: 1, preview: "prompt", pinned: 0,
});
const callbacks = {
  onChatUpdated: vi.fn(), onChatMeta: vi.fn(), onNotify: vi.fn(),
};

beforeEach(() => {
  resetChatSessions();
  vi.clearAllMocks();
  store.clear();
  clock = 0;
  getChat.mockImplementation(async (id: string) => chat(id));
  listRecentMessages.mockImplementation(async (id: string, limit: number) =>
    (store.get(id) ?? []).slice(-limit),
  );
  addMessage.mockImplementation(async (id: string, role: Message["role"], content: string) => {
    const message: Message = { id: crypto.randomUUID(), chat_id: id, role, content, created_at: ++clock };
    store.set(id, [...(store.get(id) ?? []), message]);
    return message;
  });
  clearChatMessages.mockImplementation(async (id: string) => { store.set(id, []); });
  deleteChat.mockImplementation(async (id: string) => { store.delete(id); });
  updateChat.mockResolvedValue(undefined);
  streamChat.mockImplementation(async ({ onToken }: { onToken: (token: string) => void }) => {
    onToken("reply");
  });
});

describe("ChatSession", () => {
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

  it("waits for an in-flight insert before Clear and discards queued turns", async () => {
    let finishInsert!: () => void;
    addMessage.mockImplementationOnce(async (id: string, role: Message["role"], content: string) => {
      await new Promise<void>((resolve) => { finishInsert = resolve; });
      const message: Message = { id: "u1", chat_id: id, role, content, created_at: ++clock };
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
