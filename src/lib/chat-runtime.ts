import type { ModelMessage } from "ai";
import { generateChatTitle, streamChat } from "./chat";
import {
  addMessage,
  clearChatMessages,
  deleteChat,
  deleteMessagesAfter,
  getChat,
  listMessages,
  listOlderMessages,
  listRecentMessages,
  refreshChatPreview,
  replaceChatTitle,
  setInitialChatTitle,
  type Chat,
  type Message,
} from "./db";
import { MAX_CACHED_MESSAGES, MESSAGE_PAGE, trimRecentMessages } from "./memory";
import type { ProviderId } from "./models";
import { createQueue } from "./queue";

type Draft = { text: string; images: string[] };
type Stream = { anchor: string; text: string };
export type ChatSnapshot = {
  messages: Message[];
  stream: Stream | null;
  busy: boolean;
  phase: "idle" | "clearing" | "deleting" | "deleted";
  drafts: Draft[];
  hasMore: boolean;
  loadingOlder: boolean;
};
type Callbacks = {
  onChatUpdated: () => void;
  onChatMeta: (chat: Chat) => void;
  onNotify: (message: string, kind: "err") => void;
};
type Turn = { ac: AbortController; tempId?: string; text?: string; images?: string[] };

const sessions = new Map<string, ChatSession>();
export function chatIsUnavailable(id: string): boolean {
  const state = sessions.get(id)?.getSnapshot();
  return !!state && (state.busy || state.phase !== "idle");
}
export function getChatSession(id: string): ChatSession {
  let session = sessions.get(id);
  if (!session) {
    session = new ChatSession(id);
    sessions.set(id, session);
  }
  return session;
}
export function resetChatSessions() {
  for (const session of sessions.values()) session.stop();
  sessions.clear();
}

/** One owner for a chat's turns, messages, and destructive operations. */
export class ChatSession {
  private queue = createQueue();
  private listeners = new Set<() => void>();
  private turns = new Set<Turn>();
  private titleControllers = new Set<AbortController>();
  private titleWrites = new Set<Promise<unknown>>();
  private loaded = false;
  private version = 0;
  private loadPromise: Promise<void> | null = null;
  private loadVersion = 0;
  private streamOwner: Turn | null = null;
  private snapshot: ChatSnapshot = {
    messages: [], stream: null, busy: false, phase: "idle", drafts: [],
    hasMore: false, loadingOlder: false,
  };

  constructor(readonly id: string) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.releaseIfIdle();
    };
  };
  getSnapshot = () => this.snapshot;
  private publish(patch: Partial<ChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private releaseIfIdle() {
    if (this.listeners.size || this.turns.size || this.snapshot.phase !== "idle") return;
    this.version += 1;
    this.loaded = false;
    this.snapshot = { ...this.snapshot, messages: [], hasMore: false, stream: null };
    if (!this.snapshot.drafts.length && !this.titleControllers.size && !this.titleWrites.size) {
      if (sessions.get(this.id) === this) sessions.delete(this.id);
    }
  }
  private abortIfNeeded(ac: AbortController) {
    if (ac.signal.aborted) throw ac.signal.reason;
  }
  private notifyError(e: unknown, callbacks: Callbacks) {
    if ((e as Error)?.name !== "AbortError") {
      callbacks.onNotify((e as Error)?.message || String(e), "err");
    }
  }

  async loadRecent(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) {
      if (this.loadVersion === this.version) return this.loadPromise;
      return this.loadPromise.catch(() => {}).then(() => this.loadRecent());
    }
    const version = this.version;
    this.loadVersion = version;
    this.loadPromise = (async () => {
      const page = await listRecentMessages(this.id, MESSAGE_PAGE);
      if (this.version !== version || this.snapshot.phase === "deleted") return;
      const seen = new Set(this.snapshot.messages.map((m) => m.id));
      const older = page.filter((m) => !seen.has(m.id));
      this.loaded = true;
      this.publish({
        messages: [...older, ...this.snapshot.messages],
        hasMore: page.length >= MESSAGE_PAGE,
      });
    })().finally(() => {
      this.loadPromise = null;
      this.releaseIfIdle();
    });
    return this.loadPromise;
  }

  async loadOlder() {
    const { messages, hasMore, loadingOlder } = this.snapshot;
    if (!hasMore || loadingOlder || !messages.length || messages.length >= MAX_CACHED_MESSAGES) return;
    const version = this.version;
    const size = Math.min(MESSAGE_PAGE, MAX_CACHED_MESSAGES - messages.length);
    this.publish({ loadingOlder: true });
    try {
      const rows = await listOlderMessages(this.id, messages[0].id, size);
      if (this.version !== version) return;
      const seen = new Set(this.snapshot.messages.map((m) => m.id));
      const fresh = rows.filter((m) => !seen.has(m.id));
      this.publish({
        messages: [...fresh, ...this.snapshot.messages],
        hasMore: rows.length >= size && this.snapshot.messages.length + fresh.length < MAX_CACHED_MESSAGES,
      });
    } finally {
      this.publish({ loadingOlder: false });
    }
  }

  trim() {
    if (this.snapshot.messages.length <= MESSAGE_PAGE) return;
    this.publish({ messages: trimRecentMessages(this.snapshot.messages, MESSAGE_PAGE), hasMore: true });
  }
  takeDrafts(): Draft[] {
    const drafts = this.snapshot.drafts;
    if (drafts.length) this.publish({ drafts: [] });
    return drafts;
  }
  dropDraftImages() {
    if (!this.snapshot.drafts.some((d) => d.images.length)) return;
    this.publish({ drafts: this.snapshot.drafts.map((d) => ({ ...d, images: [] })) });
  }

  send(chat: Chat, text: string, images: string[], callbacks: Callbacks): boolean {
    if (this.snapshot.phase !== "idle" || (!text && !images.length)) return false;
    sessions.set(this.id, this);
    const turn: Turn = { ac: new AbortController(), tempId: `tmp-${crypto.randomUUID()}`, text, images };
    const display = text || `[${images.length} image(s)]`;
    const temp: Message = { id: turn.tempId!, chat_id: this.id, role: "user", content: display, created_at: Date.now() };
    this.turns.add(turn);
    this.publish({
      messages: [...this.snapshot.messages, temp], busy: true,
      stream: this.snapshot.stream ?? { anchor: temp.id, text: "" },
    });
    void this.queue.run(() => this.runSend(turn, chat, display, callbacks));
    return true;
  }

  private async runSend(turn: Turn, chat: Chat, display: string, callbacks: Callbacks) {
    let persisted = false;
    try {
      this.abortIfNeeded(turn.ac);
      const live = await getChat(this.id);
      if (!live) throw new Error("Chat was deleted.");
      this.abortIfNeeded(turn.ac);
      const user = await addMessage(this.id, "user", display);
      persisted = true;
      this.publish({ messages: this.snapshot.messages.filter((m) => m.id !== user.id).map((m) => m.id === turn.tempId ? user : m) });
      this.updatePreview(callbacks);
      if (live.title === "New Chat" && turn.text) {
        const provisional = turn.text.slice(0, 48) + (turn.text.length > 48 ? "…" : "");
        this.startTitle(chat, turn.text, provisional, turn.ac, callbacks);
      }
      this.abortIfNeeded(turn.ac);
      const history = await listRecentMessages(this.id, MAX_CACHED_MESSAGES);
      this.abortIfNeeded(turn.ac);
      const content: ModelMessage["content"] = turn.images!.length ? [
        { type: "text", text: turn.text || "Describe these images." },
        ...turn.images!.map((image) => ({ type: "image" as const, image })),
      ] : turn.text!;
      await this.reply(turn, chat, history, user.id, content, callbacks);
    } catch (e) {
      this.notifyError(e, callbacks);
      if (!persisted) {
        this.publish({
          messages: this.snapshot.messages.filter((m) => m.id !== turn.tempId),
          drafts: [...this.snapshot.drafts, { text: turn.text!, images: turn.images! }],
        });
      }
    } finally {
      this.finishTurn(turn);
    }
  }

  private startTitle(chat: Chat, text: string, provisional: string, turnAc: AbortController, callbacks: Callbacks) {
    const ac = new AbortController();
    if (turnAc.signal.aborted) ac.abort();
    else turnAc.signal.addEventListener("abort", () => ac.abort(), { once: true });
    this.titleControllers.add(ac);
    void (async () => {
      try {
        const initial = setInitialChatTitle(this.id, provisional);
        this.titleWrites.add(initial);
        const renamed = await initial.finally(() => this.titleWrites.delete(initial));
        if (ac.signal.aborted || !renamed) return;
        const titled = await getChat(this.id);
        if (!titled || ac.signal.aborted) return;
        callbacks.onChatMeta(titled);
        callbacks.onChatUpdated();
        const title = await generateChatTitle(chat.provider as ProviderId, text, ac.signal);
        if (ac.signal.aborted) return;
        const live = await getChat(this.id);
        if (!live || ac.signal.aborted) return;
        const write = replaceChatTitle(this.id, provisional, title);
        this.titleWrites.add(write);
        const updated = await write.finally(() => this.titleWrites.delete(write));
        if (ac.signal.aborted || !updated) return;
        callbacks.onChatMeta({ ...live, title });
        callbacks.onChatUpdated();
      } catch { /* optional title */ }
      finally {
        this.titleControllers.delete(ac);
        this.releaseIfIdle();
      }
    })();
  }

  private async reply(turn: Turn, chat: Chat, history: Message[], anchor: string, content: ModelMessage["content"] | undefined, callbacks: Callbacks) {
    this.streamOwner = turn;
    this.publish({ stream: { anchor, text: "" } });
    const messages: ModelMessage[] = trimRecentMessages(history, MAX_CACHED_MESSAGES).map((m) => ({ role: m.role, content: m.content }));
    if (content !== undefined) {
      if (history[history.length - 1]?.id === anchor && messages.length) messages[messages.length - 1] = { role: "user", content: content as never };
      else messages.push({ role: "user", content: content as never });
    }
    let full = "";
    try {
      await streamChat({
        provider: chat.provider as ProviderId, modelId: chat.model_id, messages,
        webSearch: true, abortSignal: turn.ac.signal,
        onToken: (token) => {
          full += token;
          if (this.streamOwner === turn) this.publish({ stream: { anchor, text: full } });
        },
        onRetry: () => { full = ""; this.publish({ stream: { anchor, text: "" } }); },
      });
    } catch (e) {
      if (turn.ac.signal.aborted) throw turn.ac.signal.reason;
      if (full) await this.saveReplyWithRetry(turn, anchor, full, callbacks);
      throw e;
    }
    this.abortIfNeeded(turn.ac);
    await this.saveReplyWithRetry(turn, anchor, full, callbacks);
  }

  private async saveReplyWithRetry(turn: Turn, anchor: string, content: string, callbacks: Callbacks) {
    try {
      await this.saveReply(turn, anchor, content, callbacks);
    } catch (e) {
      if (turn.ac.signal.aborted) throw e;
      await this.saveReply(turn, anchor, content, callbacks);
    }
  }

  private async saveReply(turn: Turn, anchor: string, content: string, callbacks: Callbacks) {
    this.abortIfNeeded(turn.ac);
    const live = await getChat(this.id);
    if (!live) throw new Error("Chat was deleted.");
    this.abortIfNeeded(turn.ac);
    const reply = await addMessage(this.id, "assistant", content);
    const at = this.snapshot.messages.findIndex((m) => m.id === anchor);
    const messages = this.snapshot.messages;
    const withoutReply = messages.filter((m) => m.id !== reply.id);
    this.publish({ messages: trimRecentMessages(at < 0 ? [...withoutReply, reply] : [...withoutReply.slice(0, at + 1), reply, ...withoutReply.slice(at + 1)], MAX_CACHED_MESSAGES) });
    this.updatePreview(callbacks);
    callbacks.onChatUpdated();
  }

  private updatePreview(callbacks: Callbacks) {
    void refreshChatPreview(this.id).then(callbacks.onChatUpdated).catch(() => {});
  }

  regenerate(chat: Chat, userId: string, callbacks: Callbacks): boolean {
    if (this.snapshot.phase !== "idle" || this.turns.size) return false;
    sessions.set(this.id, this);
    const turn: Turn = { ac: new AbortController() };
    this.turns.add(turn);
    this.publish({ busy: true });
    void this.queue.run(async () => {
      try {
        this.abortIfNeeded(turn.ac);
        const all = await listMessages(this.id);
        this.abortIfNeeded(turn.ac);
        const at = all.findIndex((m) => m.id === userId && m.role === "user");
        if (at < 0) throw new Error("That message is no longer in this chat.");
        await deleteMessagesAfter(this.id, userId);
        this.abortIfNeeded(turn.ac);
        const keep = all.slice(0, at + 1);
        this.publish({ messages: trimRecentMessages(keep, MAX_CACHED_MESSAGES), hasMore: keep.length > MAX_CACHED_MESSAGES });
        await this.reply(turn, chat, keep, userId, undefined, callbacks);
      } catch (e) { this.notifyError(e, callbacks); }
      finally { this.finishTurn(turn); }
    });
    return true;
  }

  private finishTurn(turn: Turn) {
    this.turns.delete(turn);
    if (this.streamOwner === turn || this.turns.size === 0) {
      this.streamOwner = null;
      this.publish({ stream: null });
    }
    this.publish({ busy: this.turns.size > 0 });
    this.releaseIfIdle();
  }
  stop(reason = new DOMException("aborted", "AbortError")) {
    for (const turn of this.turns) turn.ac.abort(reason);
    for (const ac of this.titleControllers) ac.abort(reason);
  }
  async clear() {
    if (this.snapshot.phase !== "idle") return;
    sessions.set(this.id, this);
    this.version += 1;
    this.publish({ phase: "clearing" });
    this.stop();
    try {
      await this.queue.run(async () => {
        await Promise.allSettled(this.titleWrites);
        await clearChatMessages(this.id);
        this.loaded = true;
        this.publish({ messages: [], stream: null, drafts: [], hasMore: false });
      });
    } catch (e) {
      this.loaded = false;
      this.publish({ messages: [], hasMore: false });
      await this.loadRecent().catch(() => {});
      throw e;
    } finally { this.publish({ phase: "idle" }); }
  }
  async delete() {
    if (this.snapshot.phase !== "idle") return;
    sessions.set(this.id, this);
    this.version += 1;
    this.publish({ phase: "deleting" });
    this.stop();
    try {
      await this.queue.run(async () => {
        await Promise.allSettled(this.titleWrites);
        await deleteChat(this.id);
        this.publish({ phase: "deleted", messages: [], stream: null, drafts: [] });
        if (sessions.get(this.id) === this) sessions.delete(this.id);
      });
    } catch (e) {
      this.loaded = false;
      this.publish({ phase: "idle", messages: [], hasMore: false });
      let live: Chat | null | undefined;
      try { live = await getChat(this.id); } catch { /* state is uncertain; leave retryable */ }
      if (live !== null) await this.loadRecent().catch(() => {});
      else {
        this.publish({ phase: "deleted" });
        if (sessions.get(this.id) === this) sessions.delete(this.id);
      }
      throw e;
    }
  }
}
