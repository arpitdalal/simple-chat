import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ModelMessage } from "ai";
import {
  addMessage,
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
import { AiIcon, UserIcon } from "./Icons";

const LINE_H = 22;
const MAX_LINES = 15;
const MIN_LINES = 1;
const PAGE = 50;

type Props = {
  chat: Chat | null;
  onChatUpdated: () => void;
  onChatMeta: (chat: Chat) => void;
  onNew: () => void;
  focusNonce: number;
};

export function ChatView({
  chat,
  onChatUpdated,
  onChatMeta,
  onNew,
  focusNonce,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [images, setImages] = useState<string[]>([]);
  const stickBottom = useRef(true);

  const rowCount = messages.length + (busy ? 1 : 0);

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
      return;
    }
    let cancelled = false;
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
  }, [messages, streaming, busy, scrollToBottom]);

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
    stickBottom.current = distBottom < 80;
    if (el.scrollTop < 80) void loadOlder();
  }

  async function changeModel(provider: ProviderId, modelId: string) {
    if (!chat) return;
    await updateChat(chat.id, { provider, model_id: modelId });
    onChatMeta({ ...chat, provider, model_id: modelId });
    onChatUpdated();
  }

  async function send() {
    if (!chat || busy) return;
    const text = input.trim();
    if (!text && images.length === 0) return;
    const imageParts = [...images];
    const displayText =
      text || (imageParts.length ? `[${imageParts.length} image(s)]` : "");
    const tempId = `tmp-${crypto.randomUUID()}`;

    // Paint user + Thinking before any await
    flushSync(() => {
      setError(null);
      setBusy(true);
      setStreaming("");
      setInput("");
      setImages([]);
      setMessages((m) => [
        ...m,
        {
          id: tempId,
          chat_id: chat.id,
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
      const userMsg = await addMessage(chat.id, "user", displayText);
      setMessages((m) => m.map((x) => (x.id === tempId ? userMsg : x)));

      if (chat.title === "New Chat" && text) {
        const provisional =
          text.slice(0, 48) + (text.length > 48 ? "…" : "");
        await updateChat(chat.id, {
          title: provisional,
          preview: text.slice(0, 120),
        });
        onChatMeta({
          ...chat,
          title: provisional,
          preview: text.slice(0, 120),
        });
        onChatUpdated();
        void generateChatTitle(chat.provider as ProviderId, text).then(
          async (title) => {
            await updateChat(chat.id, { title });
            onChatMeta({ ...chat, title, preview: text.slice(0, 120) });
            onChatUpdated();
          },
        );
      }

      const ac = new AbortController();
      abortRef.current = ac;

      const history = [...messages, userMsg];
      const modelMessages: ModelMessage[] = history.map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));
      // Fix last user content for multimodal
      modelMessages[modelMessages.length - 1] = {
        role: "user",
        content: userContent as never,
      };

      let full = "";
      await streamChat({
        provider: chat.provider as ProviderId,
        modelId: chat.model_id,
        messages: modelMessages,
        webSearch: true,
        abortSignal: ac.signal,
        onToken: (t) => {
          full += t;
          setStreaming(full);
        },
      });

      const assistant = await addMessage(chat.id, "assistant", full);
      setMessages((m) => [...m, assistant]);
      setStreaming("");
      await updateChat(chat.id, { preview: full.slice(0, 120) });
      onChatUpdated();
    } catch (e) {
      setMessages((m) =>
        m.some((x) => x.id === tempId) ? m.filter((x) => x.id !== tempId) : m,
      );
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message || String(e));
      }
      setStreaming("");
    } finally {
      setBusy(false);
      abortRef.current = null;
      inputRef.current?.focus();
      requestAnimationFrame(resizeComposer);
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
        {!chat || (messages.length === 0 && !busy) ? (
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
              const isStream = busy && row.index === messages.length;
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
                    ) : m!.role === "assistant" ? (
                      <>
                        <Markdown content={m!.content} />
                        <button
                          type="button"
                          className="ghost tiny"
                          onClick={() =>
                            void navigator.clipboard.writeText(m!.content)
                          }
                        >
                          Copy
                        </button>
                      </>
                    ) : (
                      <div className="msg-user">{m!.content}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

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
                disabled={busy}
                onChange={(p, m) => void changeModel(p, m)}
              />
            ) : (
              <span className="model-label">{model?.label ?? "—"}</span>
            )}
          </div>
          <div className="composer-bar-right">
            {busy ? (
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
