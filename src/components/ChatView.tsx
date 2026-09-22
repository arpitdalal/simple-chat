import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ModelMessage } from "ai";
import {
  addMessage,
  clearChatMessages,
  deleteMessagesAfter,
  getChat,
  listMessages,
  listOlderMessages,
  listRecentMessages,
  updateChat,
  type Chat,
  type Message,
} from "../lib/db";
import { generateChatTitle, streamChat } from "../lib/chat";
import {
  MAX_CACHED_MESSAGES,
  MESSAGE_PAGE,
  onMainWindowHidden,
  trimRecentMessages,
} from "../lib/memory";
import { resolveModel, type ProviderId } from "../lib/models";
import { createQueue, type Queue } from "../lib/queue";
import { ModelPicker } from "./ModelPicker";
import { Markdown } from "./Markdown";
import {
  AiIcon,
  BranchIcon,
  CheckIcon,
  CopyIcon,
  RegenerateIcon,
  UserIcon,
} from "./Icons";
import type { ToastKind } from "./Toast";

const LINE_H = 22;
const MAX_LINES = 15;
const MIN_LINES = 1;

/** One in-flight assistant stream for a chat (multi-chat concurrent). */
type StreamSlot = {
  ac: AbortController;
  /** User message this stream replies to — stream row renders after it. */
  anchor: string;
  text: string;
};

type Props = {
  chat: Chat | null;
  onChatUpdated: () => void;
  onChatMeta: (chat: Chat) => void;
  onNew: () => void;
  onBranch: (throughMessageId: string) => Promise<void>;
  onNotify: (text: string, kind?: ToastKind) => void;
  focusNonce: number;
  /** False once probed and this chat's provider has no usable key. */
  hasProviderKey?: boolean | null;
  /** True when probe finished and no provider has a key. */
  noKeysConfigured?: boolean;
  /** True while App is switching chats (e.g. New Chat probes) — block send. */
  sendLocked?: boolean;
  onNeedKey?: () => void;
  /** ModelPicker probe result; null = credential store unknown. */
  onProvidersReady?: (ready: ProviderId[] | null) => void;
};

export function ChatView({
  chat,
  onChatUpdated,
  onChatMeta,
  onNew,
  onBranch,
  onNotify,
  focusNonce,
  hasProviderKey = true,
  noKeysConfigured = false,
  sendLocked = false,
  onNeedKey,
  onProvidersReady,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  /** Live stream for the *viewed* chat only; background streams stay in refs. */
  const [viewingStream, setViewingStream] = useState<{
    anchor: string;
    text: string;
  } | null>(null);
  /** Viewed chat has a queued or in-flight turn (regenerate gate). */
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<string[]>([]);
  const stickBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const viewingIdRef = useRef<string | null>(chat?.id ?? null);
  /** chatId → in-flight stream (concurrent across chats). */
  const streamsRef = useRef(new Map<string, StreamSlot>());
  /** chatId → FIFO so one chat never interleaves its own turns. */
  const queuesRef = useRef(new Map<string, Queue>());
  /** Unpersisted optimistic user messages, re-attached on chat reload. */
  const pendingSendsRef = useRef(new Map<string, Message[]>());
  /** Recently persisted rows per chat — merged back if a history load races. */
  const localAddsRef = useRef(new Map<string, Message[]>());
  /** Per-send cancel tokens so Stop can drop turns still waiting in the FIFO. */
  const turnCancelsRef = useRef(new Map<string, AbortController[]>());
  const messagesRef = useRef<Message[]>([]);
  const imagesRef = useRef<string[]>([]);
  /** In-flight FileReaders — composer not "empty" until they settle. */
  const pendingImageReadsRef = useRef(0);
  /** Bumps on hide so in-flight loadOlder / FileReader cannot restore heavy state. */
  const releaseGenRef = useRef(0);

  viewingIdRef.current = chat?.id ?? null;
  messagesRef.current = messages;
  imagesRef.current = images;
  const showStream = viewingStream != null;
  const streaming = viewingStream?.text ?? "";
  const streamingAnchor = viewingStream?.anchor ?? null;
  // null = unknown (probe still running) — do not block. false = probed, no key.
  const noKey = hasProviderKey === false;
  // send() / regenerate() only — drafting stays enabled while queues are busy.
  const blocked = noKey || sendLocked;
  const setupNeeded = noKeysConfigured;

  function getChatQueue(chatId: string): Queue {
    let q = queuesRef.current.get(chatId);
    if (!q) {
      q = createQueue();
      queuesRef.current.set(chatId, q);
    }
    return q;
  }

  function isChatBusy(chatId: string): boolean {
    return (
      streamsRef.current.has(chatId) ||
      getChatQueue(chatId).isBusy() ||
      (turnCancelsRef.current.get(chatId)?.length ?? 0) > 0
    );
  }

  /** Remember a row we wrote so a racing history load can merge it back. */
  function noteLocalAdd(chatId: string, msg: Message) {
    const list = localAddsRef.current.get(chatId) ?? [];
    const next = [...list.filter((m) => m.id !== msg.id), msg].slice(-50);
    localAddsRef.current.set(chatId, next);
  }

  /** Register a per-turn AbortController for Stop to cancel. */
  function pushTurnCancel(chatId: string, ac: AbortController): void {
    const list = turnCancelsRef.current.get(chatId) ?? [];
    list.push(ac);
    turnCancelsRef.current.set(chatId, list);
  }

  function clearTurnCancel(chatId: string, ac: AbortController) {
    const list = turnCancelsRef.current.get(chatId);
    if (!list) return;
    const next = list.filter((x) => x !== ac);
    if (next.length) turnCancelsRef.current.set(chatId, next);
    else turnCancelsRef.current.delete(chatId);
  }

  /** Stop the live stream plus every turn still queued on this chat. */
  function stopChat(chatId: string) {
    streamsRef.current.get(chatId)?.ac.abort();
    for (const ac of turnCancelsRef.current.get(chatId) ?? []) ac.abort();
  }

  /** Dequeue guard — only this turn's own token (never a stale stream slot). */
  function throwIfTurnAborted(turnAc: AbortController) {
    if (turnAc.signal.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
  }

  function chatDeletedError(): Error {
    const err = new Error("Chat was deleted.");
    (err as Error & { code?: string }).code = "CHAT_DELETED";
    return err;
  }

  function isChatDeleted(e: unknown): boolean {
    return (e as Error & { code?: string } | null)?.code === "CHAT_DELETED";
  }

  function dropPendingSend(chatId: string, tempId: string) {
    const pend = pendingSendsRef.current.get(chatId) ?? [];
    pendingSendsRef.current.set(
      chatId,
      pend.filter((m) => m.id !== tempId),
    );
  }

  /**
   * page ∪ locally-written rows (by created_at) with optimistic pending
   * always last — paint-time created_at can precede a reply that landed later.
   */
  function mergeHistory(page: Message[], chatId: string): Message[] {
    const pendingNow = pendingSendsRef.current.get(chatId) ?? [];
    const locals = localAddsRef.current.get(chatId) ?? [];
    const byId = new Map<string, Message>();
    for (const m of page) byId.set(m.id, m);
    for (const m of locals) {
      if (!byId.has(m.id)) byId.set(m.id, m);
    }
    const head = [...byId.values()].sort((a, b) => a.created_at - b.created_at);
    const headIds = new Set(head.map((m) => m.id));
    const tail = pendingNow.filter((m) => !headIds.has(m.id));
    return [...head, ...tail];
  }

  /** After a turn settles: clear busy or adopt the next queued stream UI. */
  function settleChatBusy(chatId: string) {
    if (viewingIdRef.current !== chatId) return;
    if (!isChatBusy(chatId)) {
      setBusy(false);
      setViewingStream(null);
      return;
    }
    const next = streamsRef.current.get(chatId);
    setViewingStream(next ? { anchor: next.anchor, text: next.text } : null);
  }

  /** Stream row sits after the user message it answers — not always at the end. */
  const streamIndex = (() => {
    if (!showStream) return messages.length;
    if (!streamingAnchor) return messages.length;
    const i = messages.findIndex((m) => m.id === streamingAnchor);
    return i === -1 ? messages.length : i + 1;
  })();

  const rowCount = messages.length + (showStream ? 1 : 0);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 8,
  });

  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (!chat) {
      setMessages([]);
      setHasMore(false);
      setViewingStream(null);
      setBusy(false);
      setShowJump(false);
      return;
    }
    let cancelled = false;
    setShowJump(false);
    // Restore in-flight stream + busy for the chat we're entering
    const stream = streamsRef.current.get(chat.id);
    if (stream) {
      setViewingStream({ anchor: stream.anchor, text: stream.text });
      setBusy(true);
    } else {
      setViewingStream(null);
      setBusy(isChatBusy(chat.id));
    }
    void (async () => {
      const page = await listRecentMessages(chat.id, MESSAGE_PAGE);
      if (cancelled) return;
      // page ∪ writes that landed mid-flight ∪ still-optimistic sends
      setMessages(mergeHistory(page, chat.id));
      setHasMore(page.length >= MESSAGE_PAGE);
      stickBottom.current = true;
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(Math.max(page.length - 1, 0), {
          align: "end",
        });
        scrollToBottom();
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [chat?.id]);

  // Tray-resident: drop scrolled-up history + draft image data URLs on hide.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onMainWindowHidden(() => {
      releaseGenRef.current += 1;
      setImages([]);
      if (fileRef.current) fileRef.current.value = "";
      const cur = messagesRef.current;
      if (cur.length <= MESSAGE_PAGE) return;
      setMessages(trimRecentMessages(cur, MESSAGE_PAGE));
      setHasMore(true);
      stickBottom.current = true;
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useLayoutEffect(() => {
    if (stickBottom.current) scrollToBottom();
  }, [messages, streaming, showStream, scrollToBottom]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // rAF: textarea may mount after first paint / window show
    const id = requestAnimationFrame(() => {
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
    return () => cancelAnimationFrame(id);
  }, [focusNonce, chat?.id]);

  // always focus once when chat view mounts
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    resizeComposer();
  }, [input]);

  function resizeComposer() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const min = LINE_H * MIN_LINES;
    const max = LINE_H * MAX_LINES;
    const next = Math.min(Math.max(el.scrollHeight, min), max);
    el.style.height = `${next}px`;
  }

  async function loadOlder() {
    if (!chat || loadingOlder || !hasMore || messages.length === 0) return;
    if (messages.length >= MAX_CACHED_MESSAGES) return;
    const el = parentRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    const gen = releaseGenRef.current;
    const startedChatId = chat.id;
    setLoadingOlder(true);
    try {
      const room = MAX_CACHED_MESSAGES - messages.length;
      const pageSize = Math.min(MESSAGE_PAGE, room);
      // Over-fetch past the boundary timestamp so LIMIT is not consumed by
      // same-ms rows already on screen (inclusive cursor + DESC rowid).
      const boundary = messages.filter(
        (m) => m.created_at === messages[0].created_at,
      ).length;
      const older = await listOlderMessages(
        chat.id,
        messages[0].created_at,
        pageSize + boundary,
      );
      if (gen !== releaseGenRef.current) return;
      // Identity guard: a slow fetch must not land in another chat's list
      if (viewingIdRef.current !== startedChatId) return;
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      // Inclusive cursor re-returns the boundary row(s) — drop by id.
      const seen = new Set(messages.map((m) => m.id));
      const fresh = older.filter((m) => !seen.has(m.id));
      setHasMore(
        older.length >= pageSize + boundary &&
          messages.length + older.length < MAX_CACHED_MESSAGES,
      );
      if (fresh.length === 0) return;
      stickBottom.current = false;
      setMessages((m) => [...fresh, ...m]);
      requestAnimationFrame(() => {
        if (!el || gen !== releaseGenRef.current) return;
        const delta = el.scrollHeight - prevHeight;
        el.scrollTop = prevTop + delta;
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  function onScroll() {
    const el = parentRef.current;
    if (!el) return;
    const distBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distBottom < 80;
    stickBottom.current = nearBottom;
    setShowJump(!nearBottom && (messages.length > 0 || showStream));
    if (el.scrollTop < 80) void loadOlder();
  }

  function jumpToBottom() {
    stickBottom.current = true;
    setShowJump(false);
    scrollToBottom();
  }

  async function changeModel(provider: ProviderId, modelId: string) {
    if (!chat) return;
    const chatId = chat.id;
    await updateChat(chatId, { provider, model_id: modelId });
    // Only patch sidebar meta if the user is still on this chat
    if (viewingIdRef.current === chatId) {
      onChatMeta({ ...chat, provider, model_id: modelId });
    }
    onChatUpdated();
  }

  /** Stream an assistant reply for `history` (last must be the user turn). */
  async function streamReply(
    chatSnap: Chat,
    history: Message[],
    anchorUserId: string,
    lastUserContent?: ModelMessage["content"],
    turnAc?: AbortController,
  ) {
    const chatId = chatSnap.id;
    const startGen = releaseGenRef.current;
    // Prefer the send-time AC (Stop works during persist); else create one.
    const prior = streamsRef.current.get(chatId);
    const slot: StreamSlot = prior
      ? { ac: prior.ac, anchor: anchorUserId, text: prior.text }
      : {
          ac: turnAc ?? new AbortController(),
          anchor: anchorUserId,
          text: "",
        };
    streamsRef.current.set(chatId, slot);
    if (viewingIdRef.current === chatId) {
      flushSync(() => {
        setBusy(true);
        setViewingStream({ anchor: anchorUserId, text: slot.text });
      });
    }
    stickBottom.current = true;
    const ac = slot.ac;

    const appendAssistant = async (content: string) => {
      // Re-check before insert — chat may have been deleted mid-stream.
      const still = await getChat(chatId);
      if (!still) throw chatDeletedError();
      const assistant = await addMessage(chatId, "assistant", content);
      noteLocalAdd(chatId, assistant);
      if (viewingIdRef.current === chatId) {
        const limit =
          startGen !== releaseGenRef.current
            ? MESSAGE_PAGE
            : MAX_CACHED_MESSAGES;
        const wouldTrim = messagesRef.current.length >= limit;
        setMessages((m) => {
          // Place the reply directly after the user turn it answers — later
          // optimistic sends may already sit below while this stream ran.
          const i = m.findIndex((x) => x.id === anchorUserId);
          if (i !== -1) {
            return trimRecentMessages(
              [...m.slice(0, i + 1), assistant, ...m.slice(i + 1)],
              limit,
            );
          }
          // Anchor missing (hide-trim / race): insert after the last
          // non-pending row so optimistic sends stay a forced tail.
          const pendingIds = new Set(
            (pendingSendsRef.current.get(chatId) ?? []).map((p) => p.id),
          );
          let at = m.length;
          for (let j = m.length - 1; j >= 0; j--) {
            if (!pendingIds.has(m[j].id)) {
              at = j + 1;
              break;
            }
          }
          if (at === m.length) {
            // No non-pending rows — fall back to time order among pending
            const byTime = m.findIndex(
              (x) => !pendingIds.has(x.id) && x.created_at > assistant.created_at,
            );
            at = byTime === -1 ? m.length : byTime;
          }
          const next = [...m.slice(0, at), assistant, ...m.slice(at)];
          return trimRecentMessages(next, limit);
        });
        if (wouldTrim) setHasMore(true);
      }
      // Preview update is best-effort — don't re-enter append on metadata failure
      try {
        await updateChat(chatId, { preview: content.slice(0, 120) });
      } catch {
        /* ignore */
      }
      onChatUpdated();
    };

    let full = "";
    let assistantSaved = false;
    let streamed = false;
    try {
      // Stop may have landed while we were still persisting — must throw
      // inside try so finally clears the slot (else busy/Stop wedge).
      if (ac.signal.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }

      // Bound context — a full-transcript load per queued turn would regress
      // main's in-memory window and can blow provider limits.
      const windowed = trimRecentMessages(history, MAX_CACHED_MESSAGES);
      const modelMessages: ModelMessage[] = windowed.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));
      if (lastUserContent !== undefined) {
        // History may omit the just-persisted user row (recent-page race);
        // the model must always see this turn's user content last.
        const endsWithAnchor =
          history.length > 0 && history[history.length - 1]?.id === anchorUserId;
        if (endsWithAnchor && modelMessages.length > 0) {
          modelMessages[modelMessages.length - 1] = {
            role: "user",
            content: lastUserContent as never,
          };
        } else {
          modelMessages.push({
            role: "user",
            content: lastUserContent as never,
          });
        }
      }

      await streamChat({
        provider: chatSnap.provider as ProviderId,
        modelId: chatSnap.model_id,
        messages: modelMessages,
        webSearch: true,
        abortSignal: ac.signal,
        onToken: (t) => {
          full += t;
          slot.text = full;
          if (viewingIdRef.current === chatId) {
            setViewingStream({ anchor: anchorUserId, text: full });
          }
        },
        onRetry: () => {
          // Reset live buffer only — slot keeps last partial until new tokens
          full = "";
          slot.text = "";
          if (viewingIdRef.current === chatId) {
            setViewingStream({ anchor: anchorUserId, text: "" });
          }
        },
      });
      streamed = true;

      await appendAssistant(full);
      assistantSaved = true;
    } catch (e) {
      // Domain signal for the caller (send/regenerate) to compensate + notify.
      if (isChatDeleted(e)) {
        throw e;
      }
      const aborted = (e as Error).name === "AbortError";
      if (!aborted && streamed && !assistantSaved && full) {
        // Stream finished — retry persist once; success = no error toast
        try {
          await appendAssistant(full);
          assistantSaved = true;
          return;
        } catch (retryErr) {
          if (isChatDeleted(retryErr)) throw retryErr;
          if (viewingIdRef.current === chatId) {
            setViewingStream({ anchor: anchorUserId, text: "" });
          }
          onNotify((e as Error).message || String(e), "err");
          throw e;
        }
      }
      const partial = full || slot.text;
      // Keep partial reply only when the stream itself failed
      if (!aborted && !streamed && !assistantSaved && partial) {
        try {
          await appendAssistant(partial);
          assistantSaved = true;
        } catch (partialErr) {
          if (isChatDeleted(partialErr)) throw partialErr;
          if (viewingIdRef.current === chatId) {
            setViewingStream({ anchor: anchorUserId, text: "" });
          }
        }
      } else if (viewingIdRef.current === chatId && !assistantSaved) {
        setViewingStream({ anchor: anchorUserId, text: "" });
      }
      if (!aborted) {
        onNotify((e as Error).message || String(e), "err");
      }
      throw e;
    } finally {
      if (streamsRef.current.get(chatId) === slot) {
        streamsRef.current.delete(chatId);
      }
      if (viewingIdRef.current === chatId) {
        setViewingStream(null);
        inputRef.current?.focus();
        requestAnimationFrame(resizeComposer);
      }
      if (turnAc) clearTurnCancel(chatId, turnAc);
    }
  }

  async function send() {
    if (!chat || blocked) {
      if (setupNeeded) onNeedKey?.();
      return;
    }
    const chatId = chat.id;
    const chatSnap = chat;
    const text = input.trim();
    if (!text && images.length === 0) return;
    const imageParts = [...images];
    const displayText =
      text || (imageParts.length ? `[${imageParts.length} image(s)]` : "");
    const tempId = `tmp-${crypto.randomUUID()}`;
    const tempMsg: Message = {
      id: tempId,
      chat_id: chatId,
      role: "user",
      content: displayText,
      created_at: Date.now(),
    };

    // Paint user + Thinking before any await — send is never blocked by a
    // stream on this or another chat; the per-chat queue serializes turns.
    // Don't clobber an already-visible stream row with an empty anchor:
    // a second send while one streams only appends the user message below.
    const alreadyStreaming = streamsRef.current.has(chatId);
    const turnAc = new AbortController();
    pushTurnCancel(chatId, turnAc);
    let ownsSlot = false;
    flushSync(() => {
      setBusy(true);
      if (!alreadyStreaming) {
        // Register AC now so Stop can cancel before streamChat starts
        streamsRef.current.set(chatId, {
          ac: turnAc,
          anchor: tempId,
          text: "",
        });
        ownsSlot = true;
        setViewingStream({ anchor: tempId, text: "" });
      }
      setInput("");
      setImages([]);
      setMessages((m) => [...m, tempMsg]);
    });
    stickBottom.current = true;
    pendingSendsRef.current.set(chatId, [
      ...(pendingSendsRef.current.get(chatId) ?? []),
      tempMsg,
    ]);

    const userContent =
      imageParts.length === 0
        ? text
        : [
            { type: "text" as const, text: text || "Describe these images." },
            ...imageParts.map((data) => ({
              type: "image" as const,
              image: data,
            })),
          ];

    let userPersisted = false;
    let userPersistedId: string | null = null;
    let reachedStream = false;
    const sendGen = releaseGenRef.current;
    try {
      await getChatQueue(chatId).run(async () => {
        // Only this turn's token — a stale aborted slot from Stop must not
        // cancel a fresh send that raced into the queue window.
        throwIfTurnAborted(turnAc);
        // Live chat check before any persist — a queued turn must not insert
        // an orphan row into a chat deleted while it waited.
        const freshChat = await getChat(chatId);
        if (!freshChat) {
          // Distinct from AbortError so the user is told.
          throw chatDeletedError();
        }
        const userMsg = await addMessage(chatId, "user", displayText);
        userPersisted = true;
        userPersistedId = userMsg.id;
        noteLocalAdd(chatId, userMsg);
        dropPendingSend(chatId, tempId);
        if (viewingIdRef.current === chatId) {
          setMessages((m) => m.map((x) => (x.id === tempId ? userMsg : x)));
        }
        // Point the live stream row at the persisted id — otherwise it falls
        // to the end while later optimistic sends sit below it.
        const slot = streamsRef.current.get(chatId);
        if (slot && slot.anchor === tempId) {
          slot.anchor = userMsg.id;
          if (viewingIdRef.current === chatId) {
            setViewingStream({ anchor: userMsg.id, text: slot.text });
          }
        }

        if (freshChat.title === "New Chat" && text) {
          const provisional =
            text.slice(0, 48) + (text.length > 48 ? "…" : "");
          await updateChat(chatId, {
            title: provisional,
            preview: text.slice(0, 120),
          });
          if (viewingIdRef.current === chatId) {
            onChatMeta({
              ...freshChat,
              title: provisional,
              preview: text.slice(0, 120),
            });
          }
          onChatUpdated();
          // Await title gen here (abortable) so a hung call cannot sit in a
          // detached FIFO op keeping Stop busy forever. Write stays in this
          // same queue op — no second enqueue after Stop.
          const title = await generateChatTitle(
            chatSnap.provider as ProviderId,
            text,
            turnAc.signal,
          );
          throwIfTurnAborted(turnAc);
          await updateChat(chatId, { title });
          // Re-read before meta so a delete in this window cannot re-activate
          // a vanished chat via a stale snapshot fallback.
          const titled = await getChat(chatId);
          if (viewingIdRef.current === chatId && titled) {
            onChatMeta({
              ...titled,
              title,
              preview: text.slice(0, 120),
            });
          }
          onChatUpdated();
        }

        // Bounded recent page (not full table) so each queued turn stays cheap.
        const history = await listRecentMessages(
          chatId,
          MAX_CACHED_MESSAGES,
        );
        reachedStream = true;
        await streamReply(
          chatSnap,
          history,
          userMsg.id,
          userContent as never,
          turnAc,
        );
      });
    } catch (e) {
      dropPendingSend(chatId, tempId);
      // Placeholder slot never reached streamReply — drop it so busy can clear
      if (ownsSlot && !reachedStream) {
        streamsRef.current.delete(chatId);
      }
      const deleted = isChatDeleted(e);
      if (deleted) {
        // Compensation: chat vanished mid-send — drop local optimistic row
        // and mop any rows this turn (or a racing peer) already persisted
        // into a chat that no longer exists (UUID ids are never reused).
        localAddsRef.current.delete(chatId);
        pendingSendsRef.current.delete(chatId);
        if (viewingIdRef.current === chatId) {
          setMessages((m) =>
            m.filter(
              (x) => x.id !== tempId && (!userPersistedId || x.id !== userPersistedId),
            ),
          );
        }
        try {
          await clearChatMessages(chatId);
        } catch {
          /* best-effort — chat may already be gone from every surface */
        }
        onNotify((e as Error).message || String(e), "err");
        onChatUpdated();
        return;
      }
      if (viewingIdRef.current === chatId) {
        setMessages((m) => m.filter((x) => x.id !== tempId));
        // Restore only if whole composer still empty — don't merge into a newer draft
        if (
          !userPersisted &&
          (inputRef.current?.value ?? "") === "" &&
          imagesRef.current.length === 0 &&
          pendingImageReadsRef.current === 0
        ) {
          setInput(text);
          // Hide bumps releaseGen and drops image data URLs — don't undo that
          if (sendGen === releaseGenRef.current) {
            setImages(imageParts);
          }
        }
        if (!streamsRef.current.has(chatId)) {
          setViewingStream(null);
        }
      }
      // streamReply notifies for stream errors; only notify if we never got there
      if ((e as Error).name !== "AbortError" && !reachedStream) {
        onNotify((e as Error).message || String(e), "err");
      }
    } finally {
      clearTurnCancel(chatId, turnAc);
      settleChatBusy(chatId);
    }
  }

  async function regenerate(userMessageId: string) {
    if (!chat || blocked) {
      if (setupNeeded) onNeedKey?.();
      return;
    }
    if (isChatBusy(chat.id)) return;
    const chatId = chat.id;
    const chatSnap = chat;
    let reachedStream = false;
    // Regenerate has no pre-stream slot yet — cancel via a fresh turn token
    // so Stop between enqueue and streamReply still lands.
    const turnAc = new AbortController();
    pushTurnCancel(chatId, turnAc);
    try {
      await getChatQueue(chatId).run(async () => {
        throwIfTurnAborted(turnAc);
        const startGen = releaseGenRef.current;
        const all = await listMessages(chatId);
        const idx = all.findIndex((m) => m.id === userMessageId);
        if (idx < 0 || all[idx].role !== "user") {
          onNotify("That message is no longer in this chat.", "err");
          return;
        }

        await deleteMessagesAfter(chatId, userMessageId);
        // Truncation dropped every local row past the keep prefix (user and
        // assistant) — otherwise mergeHistory resurrects ghost rows next load.
        const keepIds = new Set(all.slice(0, idx + 1).map((m) => m.id));
        localAddsRef.current.set(
          chatId,
          (localAddsRef.current.get(chatId) ?? []).filter((m) =>
            keepIds.has(m.id),
          ),
        );
        const keep = all.slice(0, idx + 1);
        const limit =
          startGen !== releaseGenRef.current
            ? MESSAGE_PAGE
            : MAX_CACHED_MESSAGES;
        const visible = trimRecentMessages(keep, limit);
        // Preserve optimistic user sends queued while regenerate ran
        const pending = pendingSendsRef.current.get(chatId) ?? [];
        const viewing = viewingIdRef.current === chatId;
        flushSync(() => {
          if (viewing) {
            setMessages([...visible, ...pending]);
            if (visible.length < keep.length) setHasMore(true);
            setBusy(true);
            setViewingStream({ anchor: userMessageId, text: "" });
          }
          // Reuse turnAc so Stop works before streamChat starts
          streamsRef.current.set(chatId, {
            ac: turnAc,
            anchor: userMessageId,
            text: "",
          });
        });
        if (viewing) stickBottom.current = true;

        reachedStream = true;
        await streamReply(chatSnap, keep, userMessageId, undefined, turnAc);
      });
    } catch (e) {
      const deleted = isChatDeleted(e);
      if (deleted) {
        try {
          await clearChatMessages(chatId);
        } catch {
          /* best-effort mop of any mid-stream insert */
        }
        onNotify((e as Error).message || String(e), "err");
        onChatUpdated();
        return;
      }
      // streamReply notifies for stream errors; only notify if we never got there
      if ((e as Error).name !== "AbortError" && !reachedStream) {
        onNotify((e as Error).message || String(e), "err");
      }
    } finally {
      clearTurnCancel(chatId, turnAc);
      settleChatBusy(chatId);
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith("image/")) continue;
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
      const gen = releaseGenRef.current;
      pendingImageReadsRef.current += 1;
      const reader = new FileReader();
      reader.onload = () => {
        pendingImageReadsRef.current = Math.max(
          0,
          pendingImageReadsRef.current - 1,
        );
        if (gen !== releaseGenRef.current) return;
        if (typeof reader.result === "string") {
          setImages((imgs) => [...imgs, reader.result as string]);
        }
      };
      reader.onerror = () => {
        pendingImageReadsRef.current = Math.max(
          0,
          pendingImageReadsRef.current - 1,
        );
      };
      reader.readAsDataURL(file);
    }
  }

  function onFiles(files: FileList | null) {
    if (!files) return;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const gen = releaseGenRef.current;
      pendingImageReadsRef.current += 1;
      const reader = new FileReader();
      reader.onload = () => {
        pendingImageReadsRef.current = Math.max(
          0,
          pendingImageReadsRef.current - 1,
        );
        if (gen !== releaseGenRef.current) return;
        if (typeof reader.result === "string") {
          setImages((imgs) => [...imgs, reader.result as string]);
        }
      };
      reader.onerror = () => {
        pendingImageReadsRef.current = Math.max(
          0,
          pendingImageReadsRef.current - 1,
        );
      };
      reader.readAsDataURL(file);
    }
  }

  const model = chat ? resolveModel(chat.provider, chat.model_id) : null;
  const title =
    chat?.title && chat.title !== "New Chat" ? chat.title : "New Chat";
  const items = virtualizer.getVirtualItems();

  return (
    <div className="chat-stage">
      <div
        ref={parentRef}
        className="messages"
        onScroll={onScroll}
      >
        {loadingOlder && (
          <div className="load-older">Loading earlier messages…</div>
        )}
        {!chat || (messages.length === 0 && !showStream) ? (
          <div className="empty-state">
            <h1>Ask Anything</h1>
            <p>BYOK · local history · hotkey to summon</p>
          </div>
        ) : (
          <div
            className="virtual-inner"
            style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          >
            {items.map((row) => {
              const isStream = showStream && row.index === streamIndex;
              const msgIndex =
                showStream && row.index > streamIndex
                  ? row.index - 1
                  : row.index;
              const m = isStream ? null : messages[msgIndex];
              return (
                <div
                  key={isStream ? "stream" : m!.id}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className={`msg ${isStream ? "assistant" : m!.role}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  <div className="msg-icon">
                    {isStream || m!.role === "assistant" ? (
                      <AiIcon />
                    ) : (
                      <UserIcon />
                    )}
                  </div>
                  <div className="msg-content">
                    {isStream ? (
                      <>
                        <div className="thinking-pill">Thinking…</div>
                        {streaming && <Markdown content={streaming} />}
                      </>
                    ) : (
                      <>
                        {m!.role === "assistant" ? (
                          <Markdown content={m!.content} />
                        ) : (
                          <div className="msg-user">{m!.content}</div>
                        )}
                        <MsgActions
                          content={m!.content}
                          messageId={m!.id}
                          role={m!.role}
                          canRegenerate={
                            !blocked && chat ? !isChatBusy(chat.id) : !busy
                          }
                          onBranch={onBranch}
                          onRegenerate={(id) => void regenerate(id)}
                          onNotify={onNotify}
                        />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showJump && (
        <button
          type="button"
          className="jump-bottom glass"
          title="Scroll to bottom"
          aria-label="Scroll to bottom"
          onMouseDown={(e) => e.preventDefault()}
          onClick={jumpToBottom}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M6 9l6 6 6-6"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      <div
        className="float-top"
        data-tauri-drag-region
        onMouseDown={(e) => {
          if ((e.target as HTMLElement).closest("button")) return;
          if (e.button !== 0) return;
          e.preventDefault();
          void getCurrentWindow().startDragging();
        }}
      >
        <div className="title-pill glass">{title}</div>
        <button
          type="button"
          className="fab-new glass"
          onClick={onNew}
          title="New Chat (⌘/Ctrl+N)"
        >
          +
        </button>
      </div>

      <div className="float-composer">
        {images.length > 0 && (
          <div className="attach-row">
            {images.map((src, i) => (
              <button
                key={i}
                type="button"
                className="thumb"
                onClick={() => setImages(images.filter((_, j) => j !== i))}
                title="Remove"
              >
                <img src={src} alt="" />
              </button>
            ))}
          </div>
        )}
        <div className="composer glass">
          <div className="composer-input-row">
            <button
              type="button"
              className="icon-btn"
              onClick={() => {
                if (setupNeeded) onNeedKey?.();
                else if (!noKey) fileRef.current?.click();
              }}
              title={
                setupNeeded
                  ? "Add an API key in Settings"
                  : noKey
                    ? "Select a keyed model"
                    : "Attach image"
              }
            >
              +
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => onFiles(e.target.files)}
            />
            <textarea
              ref={inputRef}
              value={input}
              placeholder={
                setupNeeded
                  ? "Add key to start chatting"
                  : noKey
                    ? "Select a model to chat"
                    : sendLocked
                      ? "Waiting for current operation…"
                      : "Ask AI anything…"
              }
              rows={MIN_LINES}
              readOnly={noKey}
              onChange={(e) => setInput(e.target.value)}
              onPaste={noKey ? undefined : onPaste}
              onClick={() => {
                if (setupNeeded) onNeedKey?.();
              }}
              onKeyDown={(e) => {
                if (noKey) {
                  if (e.key === "Tab") return;
                  e.preventDefault();
                  if (setupNeeded) onNeedKey?.();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!sendLocked) void send();
                }
              }}
            />
          </div>
        </div>
        <div className="composer-bar">
          <div className="composer-bar-left">
            {chat ? (
              <ModelPicker
                provider={chat.provider}
                modelId={chat.model_id}
                disabled={
                  !chat || isChatBusy(chat.id) || showStream || sendLocked
                }
                knownNoKeys={noKeysConfigured}
                onChange={(p, m) => void changeModel(p, m)}
                onNeedKey={onNeedKey}
                onReady={onProvidersReady}
              />
            ) : (
              <span className="model-label">{model?.label ?? "—"}</span>
            )}
          </div>
          <div className="composer-bar-right">
            {showStream || (chat && busy) ? (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  // Abort the live stream plus every turn still queued —
                  // Stop must work between turns, not only mid-stream.
                  if (chat) stopChat(chat.id);
                }}
              >
                Stop
              </button>
            ) : (
              <span>
                {setupNeeded
                  ? "Add key to start"
                  : noKey
                    ? "Select a model"
                    : sendLocked
                      ? "Waiting…"
                      : "Submit ↵"}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MsgActions({
  content,
  messageId,
  role,
  canRegenerate,
  onBranch,
  onRegenerate,
  onNotify,
}: {
  content: string;
  messageId: string;
  role: Message["role"];
  canRegenerate: boolean;
  onBranch: (id: string) => Promise<void>;
  onRegenerate: (id: string) => void;
  onNotify: (text: string, kind?: ToastKind) => void;
}) {
  const [flash, setFlash] = useState<"copy" | "branch" | null>(null);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), 1400);
    return () => window.clearTimeout(id);
  }, [flash]);

  return (
    <div className="msg-actions">
      <button
        type="button"
        className={`icon-action${flash === "copy" ? " done" : ""}`}
        title={flash === "copy" ? "Copied" : "Copy"}
        aria-label={flash === "copy" ? "Copied" : "Copy"}
        onClick={() => {
          void navigator.clipboard.writeText(content).then(() => {
            setFlash("copy");
          });
        }}
      >
        {flash === "copy" ? <CheckIcon /> : <CopyIcon />}
      </button>
      {role === "user" && (
        <button
          type="button"
          className="icon-action"
          title="Regenerate"
          aria-label="Regenerate"
          disabled={!canRegenerate}
          onClick={() => onRegenerate(messageId)}
        >
          <RegenerateIcon />
        </button>
      )}
      <button
        type="button"
        className={`icon-action${flash === "branch" ? " done" : ""}`}
        title={flash === "branch" ? "Branched" : "Branch chat"}
        aria-label={flash === "branch" ? "Branched" : "Branch"}
        onClick={() => {
          void (async () => {
            try {
              await onBranch(messageId);
              setFlash("branch");
            } catch (e) {
              onNotify((e as Error).message || String(e), "err");
            }
          })();
        }}
      >
        {flash === "branch" ? <CheckIcon /> : <BranchIcon />}
      </button>
    </div>
  );
}
