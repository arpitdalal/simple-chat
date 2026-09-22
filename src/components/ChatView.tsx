import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ModelMessage } from "ai";
import {
  addMessage,
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
    return streamsRef.current.has(chatId) || getChatQueue(chatId).isBusy();
  }

  /** Remember a row we wrote so a racing history load can merge it back. */
  function noteLocalAdd(chatId: string, msg: Message) {
    const list = localAddsRef.current.get(chatId) ?? [];
    const next = [...list.filter((m) => m.id !== msg.id), msg].slice(-50);
    localAddsRef.current.set(chatId, next);
  }

  /** page ∪ locally-written rows ∪ optimistic pending, ordered, de-duped. */
  function mergeHistory(page: Message[], chatId: string): Message[] {
    const pendingNow = pendingSendsRef.current.get(chatId) ?? [];
    const locals = localAddsRef.current.get(chatId) ?? [];
    const byId = new Map<string, Message>();
    for (const m of page) byId.set(m.id, m);
    for (const m of [...locals, ...pendingNow]) {
      if (!byId.has(m.id)) byId.set(m.id, m);
    }
    return [...byId.values()].sort((a, b) => a.created_at - b.created_at);
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
    setLoadingOlder(true);
    try {
      const room = MAX_CACHED_MESSAGES - messages.length;
      const older = await listOlderMessages(
        chat.id,
        messages[0].created_at,
        Math.min(MESSAGE_PAGE, room),
      );
      if (gen !== releaseGenRef.current) return;
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      setHasMore(
        older.length >= Math.min(MESSAGE_PAGE, room) &&
          messages.length + older.length < MAX_CACHED_MESSAGES,
      );
      stickBottom.current = false;
      setMessages((m) => [...older, ...m]);
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
    await updateChat(chat.id, { provider, model_id: modelId });
    onChatMeta({ ...chat, provider, model_id: modelId });
    onChatUpdated();
  }

  /** Stream an assistant reply for `history` (last must be the user turn). */
  async function streamReply(
    chatSnap: Chat,
    history: Message[],
    anchorUserId: string,
    lastUserContent?: ModelMessage["content"],
  ) {
    const chatId = chatSnap.id;
    const startGen = releaseGenRef.current;
    // Reuse an AbortController registered at send() paint time so Stop works
    // during persist/title — not only after streamChat starts.
    const prior = streamsRef.current.get(chatId);
    const slot: StreamSlot = prior
      ? { ac: prior.ac, anchor: anchorUserId, text: prior.text }
      : {
          ac: new AbortController(),
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

    const modelMessages: ModelMessage[] = history.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }));
    if (lastUserContent !== undefined && modelMessages.length > 0) {
      modelMessages[modelMessages.length - 1] = {
        role: "user",
        content: lastUserContent as never,
      };
    }

    const appendAssistant = async (full: string) => {
      const assistant = await addMessage(chatId, "assistant", full);
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
          const next =
            i === -1
              ? [...m, assistant]
              : [...m.slice(0, i + 1), assistant, ...m.slice(i + 1)];
          return trimRecentMessages(next, limit);
        });
        if (wouldTrim) setHasMore(true);
      }
      // Preview update is best-effort — don't re-enter append on metadata failure
      try {
        await updateChat(chatId, { preview: full.slice(0, 120) });
      } catch {
        /* ignore */
      }
      onChatUpdated();
    };

    let full = "";
    let assistantSaved = false;
    let streamed = false;
    try {
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
      const aborted = (e as Error).name === "AbortError";
      if (!aborted && streamed && !assistantSaved && full) {
        // Stream finished — retry persist once; success = no error toast
        try {
          await appendAssistant(full);
          assistantSaved = true;
          return;
        } catch {
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
        } catch {
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
    let ownsSlot = false;
    flushSync(() => {
      setBusy(true);
      if (!alreadyStreaming) {
        // Register AC now so Stop can cancel before streamChat starts
        streamsRef.current.set(chatId, {
          ac: new AbortController(),
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
    let reachedStream = false;
    const sendGen = releaseGenRef.current;
    try {
      await getChatQueue(chatId).run(async () => {
        // Stop clicked while this turn was still persisting / queued
        if (streamsRef.current.get(chatId)?.ac.signal.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        const userMsg = await addMessage(chatId, "user", displayText);
        userPersisted = true;
        noteLocalAdd(chatId, userMsg);
        const pend = pendingSendsRef.current.get(chatId) ?? [];
        pendingSendsRef.current.set(
          chatId,
          pend.filter((m) => m.id !== tempId),
        );
        if (viewingIdRef.current === chatId) {
          setMessages((m) => m.map((x) => (x.id === tempId ? userMsg : x)));
        }

        // Eligibility from live DB state — a prior queued turn may have
        // already titled this chat after chatSnap was captured.
        const live = await getChat(chatId);
        if (live?.title === "New Chat" && text) {
          const provisional =
            text.slice(0, 48) + (text.length > 48 ? "…" : "");
          await updateChat(chatId, {
            title: provisional,
            preview: text.slice(0, 120),
          });
          onChatMeta({
            ...chatSnap,
            title: provisional,
            preview: text.slice(0, 120),
          });
          onChatUpdated();
          void generateChatTitle(chatSnap.provider as ProviderId, text).then(
            async (title) => {
              await updateChat(chatId, { title });
              if (viewingIdRef.current === chatId) {
                onChatMeta({ ...chatSnap, title, preview: text.slice(0, 120) });
              }
              onChatUpdated();
            },
          );
        }

        // Fresh from DB so a prior turn's reply is included even if this
        // send was queued while an earlier stream was still running.
        const history = await listMessages(chatId);
        reachedStream = true;
        await streamReply(chatSnap, history, userMsg.id, userContent as never);
      });
    } catch (e) {
      const pend = pendingSendsRef.current.get(chatId) ?? [];
      pendingSendsRef.current.set(
        chatId,
        pend.filter((m) => m.id !== tempId),
      );
      // Placeholder slot never reached streamReply — drop it so busy can clear
      if (ownsSlot && !reachedStream) {
        streamsRef.current.delete(chatId);
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
      if (viewingIdRef.current === chatId) {
        if (!isChatBusy(chatId)) {
          setBusy(false);
          setViewingStream(null);
        } else {
          // Another queued turn on this chat — keep busy, adopt its stream UI
          const next = streamsRef.current.get(chatId);
          setViewingStream(
            next ? { anchor: next.anchor, text: next.text } : null,
          );
        }
      }
    }
  }

  async function regenerate(userMessageId: string) {
    if (!chat || blocked || isChatBusy(chat.id)) {
      if (setupNeeded && !(chat && isChatBusy(chat.id))) onNeedKey?.();
      return;
    }
    const chatId = chat.id;
    const chatSnap = chat;
    let reachedStream = false;
    try {
      await getChatQueue(chatId).run(async () => {
        const startGen = releaseGenRef.current;
        const all = await listMessages(chatId);
        const idx = all.findIndex((m) => m.id === userMessageId);
        if (idx < 0 || all[idx].role !== "user") return;

        await deleteMessagesAfter(chatId, userMessageId);
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
            // AC now so Stop works before streamChat starts
            streamsRef.current.set(chatId, {
              ac: new AbortController(),
              anchor: userMessageId,
              text: "",
            });
            setViewingStream({ anchor: userMessageId, text: "" });
          }
        });
        if (viewing) stickBottom.current = true;
        else {
          streamsRef.current.set(chatId, {
            ac: new AbortController(),
            anchor: userMessageId,
            text: "",
          });
        }

        reachedStream = true;
        await streamReply(chatSnap, keep, userMessageId);
      });
    } catch (e) {
      // streamReply notifies for stream errors; only notify if we never got there
      if ((e as Error).name !== "AbortError" && !reachedStream) {
        onNotify((e as Error).message || String(e), "err");
      }
    } finally {
      if (viewingIdRef.current === chatId) {
        if (!isChatBusy(chatId)) {
          setBusy(false);
          setViewingStream(null);
        } else {
          const next = streamsRef.current.get(chatId);
          setViewingStream(
            next ? { anchor: next.anchor, text: next.text } : null,
          );
        }
      }
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
                          canRegenerate={!busy && !blocked}
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
                disabled={showStream || sendLocked}
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
            {showStream ? (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  // Abort the in-flight AC; if only a queued turn painted a
                  // placeholder slot, abort that too so the job exits early.
                  const slot = chat && streamsRef.current.get(chat.id);
                  slot?.ac.abort();
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
