import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ModelMessage } from "ai";
import {
  addMessage,
  deleteMessagesAfter,
  listMessages,
  listOlderMessages,
  listRecentMessages,
  updateChat,
  type Chat,
  type Message,
} from "../lib/db";
import { generateChatTitle, streamChat } from "../lib/chat";
import { resolveModel, type ProviderId } from "../lib/models";
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
const PAGE = 50;

type Props = {
  chat: Chat | null;
  onChatUpdated: () => void;
  onChatMeta: (chat: Chat) => void;
  onNew: () => void;
  onBranch: (throughMessageId: string) => Promise<void>;
  onNotify: (text: string, kind?: ToastKind) => void;
  focusNonce: number;
};

export function ChatView({
  chat,
  onChatUpdated,
  onChatMeta,
  onNew,
  onBranch,
  onNotify,
  focusNonce,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<string[]>([]);
  const stickBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const viewingIdRef = useRef<string | null>(chat?.id ?? null);
  const streamOwnerRef = useRef<string | null>(null);
  const streamTextRef = useRef("");

  viewingIdRef.current = chat?.id ?? null;
  const showStream = busy && streamOwnerRef.current === chat?.id;

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
      setStreaming("");
      setShowJump(false);
      return;
    }
    let cancelled = false;
    setShowJump(false);
    // Restore in-flight stream text when returning to the owning chat
    if (streamOwnerRef.current === chat.id && busy) {
      setStreaming(streamTextRef.current);
    } else {
      setStreaming("");
    }
    void (async () => {
      const page = await listRecentMessages(chat.id, PAGE);
      if (cancelled) return;
      setMessages(page);
      setHasMore(page.length >= PAGE);
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
    const el = parentRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    const prevTop = el?.scrollTop ?? 0;
    setLoadingOlder(true);
    try {
      const older = await listOlderMessages(
        chat.id,
        messages[0].created_at,
        PAGE,
      );
      if (older.length === 0) {
        setHasMore(false);
        return;
      }
      setHasMore(older.length >= PAGE);
      stickBottom.current = false;
      setMessages((m) => [...older, ...m]);
      requestAnimationFrame(() => {
        if (!el) return;
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
    lastUserContent?: ModelMessage["content"],
  ) {
    const chatId = chatSnap.id;
    streamOwnerRef.current = chatId;
    streamTextRef.current = "";
    flushSync(() => {
      setBusy(true);
      setStreaming("");
    });
    stickBottom.current = true;

    const ac = new AbortController();
    abortRef.current = ac;

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

    try {
      let full = "";
      await streamChat({
        provider: chatSnap.provider as ProviderId,
        modelId: chatSnap.model_id,
        messages: modelMessages,
        webSearch: true,
        abortSignal: ac.signal,
        onToken: (t) => {
          full += t;
          streamTextRef.current = full;
          if (viewingIdRef.current === chatId) setStreaming(full);
        },
      });

      const assistant = await addMessage(chatId, "assistant", full);
      if (viewingIdRef.current === chatId) {
        setMessages((m) => [...m, assistant]);
        setStreaming("");
      }
      await updateChat(chatId, { preview: full.slice(0, 120) });
      onChatUpdated();
    } catch (e) {
      if (viewingIdRef.current === chatId) setStreaming("");
      if ((e as Error).name !== "AbortError") {
        onNotify((e as Error).message || String(e), "err");
      }
      throw e;
    } finally {
      if (streamOwnerRef.current === chatId) {
        streamOwnerRef.current = null;
        streamTextRef.current = "";
        setBusy(false);
      }
      abortRef.current = null;
      if (viewingIdRef.current === chatId) {
        inputRef.current?.focus();
        requestAnimationFrame(resizeComposer);
      }
    }
  }

  async function send() {
    if (!chat || busy) return;
    const chatId = chat.id;
    const chatSnap = chat;
    const text = input.trim();
    if (!text && images.length === 0) return;
    const imageParts = [...images];
    const displayText =
      text || (imageParts.length ? `[${imageParts.length} image(s)]` : "");
    const tempId = `tmp-${crypto.randomUUID()}`;

    // Paint user + Thinking before any await
    flushSync(() => {
      setBusy(true);
      setStreaming("");
      setInput("");
      setImages([]);
      streamOwnerRef.current = chatId;
      streamTextRef.current = "";
      setMessages((m) => [
        ...m,
        {
          id: tempId,
          chat_id: chatId,
          role: "user",
          content: displayText,
          created_at: Date.now(),
        },
      ]);
    });
    stickBottom.current = true;

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

    try {
      const userMsg = await addMessage(chatId, "user", displayText);
      if (viewingIdRef.current === chatId) {
        setMessages((m) => m.map((x) => (x.id === tempId ? userMsg : x)));
      }

      if (chatSnap.title === "New Chat" && text) {
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

      const history = [...messages, userMsg];
      await streamReply(chatSnap, history, userContent as never);
    } catch (e) {
      if (viewingIdRef.current === chatId) {
        setMessages((m) =>
          m.some((x) => x.id === tempId) ? m.filter((x) => x.id !== tempId) : m,
        );
        setStreaming("");
      }
      if ((e as Error).name !== "AbortError") {
        // streamReply already notified for stream errors; only notify if we never got there
        if (streamOwnerRef.current === chatId) {
          onNotify((e as Error).message || String(e), "err");
        }
      }
      if (streamOwnerRef.current === chatId) {
        streamOwnerRef.current = null;
        streamTextRef.current = "";
        setBusy(false);
      }
    }
  }

  async function regenerate(userMessageId: string) {
    if (!chat || busy) return;
    const chatId = chat.id;
    const chatSnap = chat;
    const all = await listMessages(chatId);
    const idx = all.findIndex((m) => m.id === userMessageId);
    if (idx < 0 || all[idx].role !== "user") return;

    await deleteMessagesAfter(chatId, userMessageId);
    const keep = all.slice(0, idx + 1);
    flushSync(() => {
      setMessages(keep);
      setBusy(true);
      setStreaming("");
      streamOwnerRef.current = chatId;
      streamTextRef.current = "";
    });
    stickBottom.current = true;

    try {
      await streamReply(chatSnap, keep);
    } catch {
      /* notified in streamReply */
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
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setImages((imgs) => [...imgs, reader.result as string]);
        }
      };
      reader.readAsDataURL(file);
    }
  }

  function onFiles(files: FileList | null) {
    if (!files) return;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === "string") {
          setImages((imgs) => [...imgs, reader.result as string]);
        }
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
              const isStream = showStream && row.index === messages.length;
              const m = isStream ? null : messages[row.index];
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
                          canRegenerate={!busy}
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
              onClick={() => fileRef.current?.click()}
              title="Attach image"
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
              placeholder="Ask AI anything…"
              rows={MIN_LINES}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
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
                disabled={showStream}
                onChange={(p, m) => void changeModel(p, m)}
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
                onClick={() => abortRef.current?.abort()}
              >
                Stop
              </button>
            ) : (
              <span>Submit ↵</span>
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
