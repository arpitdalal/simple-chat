import type { Message } from "./db";
import { createQueue, type Queue } from "./queue";

/** One in-flight assistant stream for a chat (multi-chat concurrent). */
export type StreamSlot = {
  ac: AbortController;
  /** User message this stream replies to — stream row renders after it. */
  anchor: string;
  text: string;
};

export type AbortedDraft = { text: string; images: string[]; gen: number };

/**
 * Per-chat send coordinator lives at module scope so ChatView remounts
 * (Settings open/close) cannot orphan in-flight queues or reset busy state.
 * Old async closures and the new mount share these maps.
 */
export const streamsRef = { current: new Map<string, StreamSlot>() };
export const queuesRef = { current: new Map<string, Queue>() };
export const pendingSendsRef = { current: new Map<string, Message[]>() };
export const localAddsRef = { current: new Map<string, Message[]>() };
export const turnCancelsRef = { current: new Map<string, AbortController[]>() };
export const abortedDraftsRef = { current: new Map<string, AbortedDraft[]>() };
/** Title-gen ACs — aborted by stopChat but not counted as chat-busy. */
export const titleCancelsRef = { current: new Map<string, AbortController[]>() };

type StreamListener = (chatId: string) => void;
const streamListeners = new Set<StreamListener>();

/** Subscribe to stream slot mutations (remount-safe UI sync). */
export function onStreamTick(fn: StreamListener): () => void {
  streamListeners.add(fn);
  return () => {
    streamListeners.delete(fn);
  };
}

export function notifyStreamTick(chatId: string): void {
  for (const fn of streamListeners) fn(chatId);
}

export function getChatQueue(chatId: string): Queue {
  let q = queuesRef.current.get(chatId);
  if (!q) {
    q = createQueue();
    queuesRef.current.set(chatId, q);
  }
  return q;
}

export function isChatBusy(chatId: string): boolean {
  return (
    streamsRef.current.has(chatId) ||
    getChatQueue(chatId).isBusy() ||
    (turnCancelsRef.current.get(chatId)?.length ?? 0) > 0
  );
}

/** Stop the live stream plus every turn still queued on this chat. */
export function stopChat(chatId: string) {
  streamsRef.current.get(chatId)?.ac.abort();
  for (const ac of turnCancelsRef.current.get(chatId) ?? []) ac.abort();
  for (const ac of titleCancelsRef.current.get(chatId) ?? []) ac.abort();
}

export function resetChatRuntime() {
  // Abort first so in-flight ops observe cancellation before maps go empty.
  for (const slot of streamsRef.current.values()) slot.ac.abort();
  for (const list of turnCancelsRef.current.values()) {
    for (const ac of list) ac.abort();
  }
  for (const list of titleCancelsRef.current.values()) {
    for (const ac of list) ac.abort();
  }
  for (const map of [
    streamsRef.current,
    queuesRef.current,
    pendingSendsRef.current,
    localAddsRef.current,
    turnCancelsRef.current,
    abortedDraftsRef.current,
    titleCancelsRef.current,
  ]) {
    map.clear();
  }
}
