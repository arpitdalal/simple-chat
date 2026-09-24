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
  loadMessageImages,
  listRecentMessages,
  messageCount,
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
type Turn = { ac: AbortController; tempId?: string; text?: string; images?: string[]; hideVersion?: number };
type UserContent = Extract<ModelMessage, { role: "user" }>["content"];

export const MAX_IMAGES_PER_MESSAGE = 4;
export const MAX_IMAGE_DATA_CHARS = 5 * 1024 * 1024;
export const MAX_IMAGE_FILE_BYTES = 3 * 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 4096;
const MAX_HISTORY_IMAGES = 20;
const MAX_HISTORY_IMAGE_CHARS = 16 * 1024 * 1024;
const MAX_HISTORY_TEXT_CHARS = 1 * 1024 * 1024;
const MAX_HISTORY_TOTAL_CHARS = 17 * 1024 * 1024;
const MAX_USER_TEXT_CHARS = 1 * 1024 * 1024;
const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

type ImageData = { image: string; width: number; height: number };

function uint16(bytes: Uint8Array, offset: number, littleEndian = false): number {
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8)
    : (bytes[offset] << 8) | bytes[offset + 1];
}

function uint24(bytes: Uint8Array, offset: number, littleEndian = false): number {
  return littleEndian
    ? bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
    : (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset + 1] === 0xff) offset += 1;
    const marker = bytes[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = uint16(bytes, offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    if (JPEG_START_OF_FRAME.has(marker)) {
      return {
        height: uint16(bytes, offset + 5),
        width: uint16(bytes, offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: uint24(bytes, 24, true) + 1,
      height: uint24(bytes, 27, true) + 1,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  if (
    chunk === "VP8 " &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: uint16(bytes, 26, true) & 0x3fff,
      height: uint16(bytes, 28, true) & 0x3fff,
    };
  }
  return null;
}

export function normalizeImageDataUrl(value: string): ImageData | null {
  const match = /^data:(?:image\/[a-z0-9.+-]+|application\/octet-stream)?;base64,([a-z0-9+/]*={0,2})$/i.exec(value);
  if (!match) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(match[1]), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
  let mime: string;
  let dimensions: { width: number; height: number } | null;
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  ) {
    mime = "image/png";
    dimensions = { width: uint32(bytes, 16), height: uint32(bytes, 20) };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mime = "image/jpeg";
    dimensions = jpegDimensions(bytes);
  } else if (
    bytes.length >= 16 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    mime = "image/webp";
    dimensions = webpDimensions(bytes);
  } else {
    return null;
  }
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) return null;
  return {
    image: `data:${mime};base64,${match[1]}`,
    width: dimensions.width,
    height: dimensions.height,
  };
}

export function imageDataUrlChars(images: string[]): number {
  return images.reduce((total, image) => total + image.length, 0);
}

export function imageCountLimitError(count: number): string | null {
  return count > MAX_IMAGES_PER_MESSAGE
    ? `Attach no more than ${MAX_IMAGES_PER_MESSAGE} images per message.`
    : null;
}

export function imageDimensionLimitError(width: number, height: number): string | null {
  return width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
    ? `Each image must be ${MAX_IMAGE_DIMENSION}×${MAX_IMAGE_DIMENSION} pixels or smaller.`
    : null;
}

export function messageCopyText(
  message: Pick<Message, "content" | "images" | "image_count">,
): string {
  const imageCount = Math.max(message.images.length, message.image_count ?? 0);
  if (!imageCount) return message.content;
  const attachments = imageCount === 1
    ? "[Image attachment]"
    : `[${imageCount} image attachments]`;
  return message.content ? `${message.content}\n${attachments}` : attachments;
}

export function imageLimitError(images: string[]): string | null {
  return imageCountLimitError(images.length) ??
    (images.some((image) => !normalizeImageDataUrl(image))
      ? "The attached image could not be read."
      : null) ??
    (imageDataUrlChars(images) > MAX_IMAGE_DATA_CHARS
      ? "The attached images are too large to send together."
      : null);
}

function userContent(
  message: Pick<Message, "content" | "images" | "image_count">,
): UserContent {
  const hasImages = message.images.length > 0 || (message.image_count ?? 0) > 0;
  const text = message.content;
  if (message.images.length) {
    return [
      { type: "text" as const, text: text || "Describe these images." },
      ...message.images.map((image) => ({ type: "image" as const, image })),
    ];
  }
  if (hasImages) {
    return [text, "Earlier image attachment omitted due to context limits."]
      .filter(Boolean)
      .join("\n\n");
  }
  return text;
}

function boundProviderHistory(
  history: Message[],
  storedImages: Map<string, string[]>,
  anchor: string,
): Message[] {
  const kept: Message[] = [];
  let textChars = 0;
  let imageChars = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    const images = message.images.length ? message.images : (storedImages.get(message.id) ?? []);
    const omittedImages = (message.image_count ?? 0) > 0 && images.length === 0;
    const messageTextChars = message.content.length;
    const messageImageChars = imageDataUrlChars(images);
    const fits =
      message.id === anchor ||
      (textChars + messageTextChars <= MAX_HISTORY_TEXT_CHARS &&
        imageChars + messageImageChars <= MAX_HISTORY_IMAGE_CHARS &&
        textChars + messageTextChars + imageChars + messageImageChars <= MAX_HISTORY_TOTAL_CHARS);
    if (!fits) break;
    kept.unshift({ ...message, images });
    textChars += messageTextChars;
    imageChars += messageImageChars;
    if (omittedImages) break;
  }
  return kept;
}

function persistedMessageMetadata(message: Message): Message {
  return {
    ...message,
    images: [],
    image_count: message.image_count ?? message.images.length,
  };
}

const sessions = new Map<string, ChatSession>();
export function sessionHasWork(id: string): boolean {
  return sessions.get(id)?.hasWork() ?? false;
}
export async function chatCanBeDiscarded(id: string): Promise<boolean> {
  if (sessionHasWork(id)) return false;
  return (await messageCount(id)) === 0;
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
  private holders = 0;
  private turns = new Set<Turn>();
  private titleControllers = new Set<AbortController>();
  private titleWrites = new Set<Promise<unknown>>();
  private loaded = false;
  private version = 0;
  private hideVersion = 0;
  private loadPromise: Promise<void> | null = null;
  private loadVersion = 0;
  private streamOwner: Turn | null = null;
  private snapshot: ChatSnapshot = {
    messages: [], stream: null, busy: false, phase: "idle", drafts: [],
    hasMore: false, loadingOlder: false,
  };

  constructor(readonly id: string) {}
  retain = () => {
    this.holders += 1;
    return () => {
      this.holders -= 1;
      this.releaseIfIdle();
    };
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.releaseIfIdle();
    };
  };
  getSnapshot = () => this.snapshot;
  hasWork = () => {
    const s = this.snapshot;
    return this.turns.size > 0 || s.busy || s.phase !== "idle" || s.drafts.length > 0
      || this.titleControllers.size > 0 || this.titleWrites.size > 0;
  };
  private publish(patch: Partial<ChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private releaseIfIdle() {
    if (this.holders || this.listeners.size || this.turns.size || this.snapshot.phase !== "idle") return;
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
      if (this.version !== version || this.snapshot.phase === "deleted" || this.snapshot.phase === "deleting") return;
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
    if (this.snapshot.loadingOlder) this.version += 1;
    if (this.snapshot.messages.length <= MESSAGE_PAGE) return;
    this.publish({ messages: trimRecentMessages(this.snapshot.messages, MESSAGE_PAGE), hasMore: true });
  }
  takeDrafts(): Draft[] {
    const drafts = this.snapshot.drafts;
    if (drafts.length) this.publish({ drafts: [] });
    return drafts;
  }
  dropDraftImages() {
    this.hideVersion += 1;
    if (!this.snapshot.drafts.some((d) => d.images.length)) return;
    this.publish({ drafts: this.snapshot.drafts.map((d) => ({ ...d, images: [] })) });
  }

  send(chat: Chat, text: string, images: string[], callbacks: Callbacks): boolean {
    if (this.snapshot.phase !== "idle" || (!text && !images.length)) return false;
    if (text.length > MAX_USER_TEXT_CHARS) {
      callbacks.onNotify("This message is too long to send.", "err");
      return false;
    }
    const normalized = images.map(normalizeImageDataUrl);
    const imageError = normalized.some((image) => !image)
      ? "The attached image could not be read."
      : imageLimitError(images);
    const dimensionError = normalized
      .filter((image): image is ImageData => image !== null)
      .map((image) => imageDimensionLimitError(image.width, image.height))
      .find(Boolean);
    if (imageError || dimensionError) {
      callbacks.onNotify(imageError ?? dimensionError!, "err");
      return false;
    }
    const validatedImages = normalized.map((image) => image!.image);
    sessions.set(this.id, this);
    const turn: Turn = { ac: new AbortController(), tempId: `tmp-${crypto.randomUUID()}`, text, images: validatedImages, hideVersion: this.hideVersion };
    const temp: Message = { id: turn.tempId!, chat_id: this.id, role: "user", content: text, images: validatedImages, created_at: Date.now() };
    this.turns.add(turn);
    this.publish({
      messages: [...this.snapshot.messages, temp], busy: true, drafts: [],
      stream: this.snapshot.stream ?? { anchor: temp.id, text: "" },
    });
    void this.queue.run(() => this.runSend(turn, chat, callbacks));
    return true;
  }

  private async runSend(turn: Turn, chat: Chat, callbacks: Callbacks) {
    let persisted = false;
    try {
      this.abortIfNeeded(turn.ac);
      const live = await getChat(this.id);
      if (!live) throw new Error("Chat was deleted.");
      this.abortIfNeeded(turn.ac);
      const user = await addMessage(this.id, "user", turn.text ?? "", Date.now(), turn.images ?? []);
      persisted = true;
      const userMetadata = persistedMessageMetadata(user);
      this.publish({ messages: this.snapshot.messages.filter((m) => m.id !== user.id).map((m) => m.id === turn.tempId ? userMetadata : m) });
      this.updatePreview(callbacks);
      if (live.title === "New Chat" && turn.text) {
        const provisional = turn.text.slice(0, 48) + (turn.text.length > 48 ? "…" : "");
        this.startTitle(chat, turn.text, provisional, turn.ac, callbacks);
      }
      this.abortIfNeeded(turn.ac);
      const history = await listRecentMessages(this.id, MAX_CACHED_MESSAGES);
      this.abortIfNeeded(turn.ac);
      await this.reply(
        turn,
        chat,
        history,
        user.id,
        userContent({ content: turn.text!, images: turn.images! }),
        callbacks,
      );
    } catch (e) {
      this.notifyError(e, callbacks);
      if (!persisted) {
        this.publish({
          messages: this.snapshot.messages.filter((m) => m.id !== turn.tempId),
          drafts: [...this.snapshot.drafts, { text: turn.text!, images: turn.hideVersion === this.hideVersion ? turn.images! : [] }],
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

  private async reply(turn: Turn, chat: Chat, history: Message[], anchor: string, content: UserContent | undefined, callbacks: Callbacks) {
    this.streamOwner = turn;
    this.publish({ stream: { anchor, text: "" } });
    const retainedHistory = trimRecentMessages(history, MAX_CACHED_MESSAGES);
    const storedImages = await loadMessageImages(
      chat.id,
      retainedHistory[0]?.id ?? anchor,
      anchor,
      MAX_HISTORY_IMAGE_CHARS,
      MAX_HISTORY_IMAGES,
    );
    const messages = boundProviderHistory(
      retainedHistory,
      storedImages,
      anchor,
    ).map((m): ModelMessage => {
      const images = m.images.length ? m.images : (storedImages.get(m.id) ?? []);
      if (m.role === "user") return { role: "user", content: userContent({ ...m, images }) };
      if (m.role === "assistant") return { role: "assistant", content: m.content };
      return { role: "system", content: m.content };
    });
    if (content !== undefined) {
      if (history[history.length - 1]?.id === anchor && messages.length) messages[messages.length - 1] = { role: "user", content };
      else messages.push({ role: "user", content });
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
        const keep = all.slice(0, at + 1);
        this.publish({ messages: trimRecentMessages(keep, MAX_CACHED_MESSAGES), hasMore: keep.length > MAX_CACHED_MESSAGES });
        this.abortIfNeeded(turn.ac);
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
    if (this.getSnapshot().phase !== "idle") return;
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
    } finally {
      if (this.snapshot.phase === "clearing") this.publish({ phase: "idle" });
    }
  }
  async delete() {
    if (this.snapshot.phase === "deleting" || this.snapshot.phase === "deleted") return;
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
