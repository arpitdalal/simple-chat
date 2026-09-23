import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { updateChat, type Chat, type Message } from "../lib/db";
import { onMainWindowHidden } from "../lib/memory";
import { resolveModel, type ProviderId } from "../lib/models";
import type { ChatSession } from "../lib/chat-runtime";
import { ModelPicker } from "./ModelPicker";
import { Markdown } from "./Markdown";
import { AiIcon, BranchIcon, CheckIcon, CopyIcon, RegenerateIcon, UserIcon } from "./Icons";
import type { ToastKind } from "./Toast";

const LINE_H = 22;
const MAX_LINES = 15;
const MIN_LINES = 1;

type Props = {
  chat: Chat | null;
  session: ChatSession;
  onChatUpdated: () => void;
  onChatMeta: (chat: Chat) => void;
  onNew: () => void;
  onBranch: (throughMessageId: string) => Promise<void>;
  onNotify: (text: string, kind?: ToastKind) => void;
  focusNonce: number;
  hasProviderKey?: boolean | null;
  noKeysConfigured?: boolean;
  sendLocked?: boolean;
  onNeedKey?: () => void;
  onProvidersReady?: (ready: ProviderId[] | null) => void;
};

export function ChatView({
  chat, session, onChatUpdated, onChatMeta, onNew, onBranch, onNotify, focusNonce,
  hasProviderKey = true, noKeysConfigured = false, sendLocked = false,
  onNeedKey, onProvidersReady,
}: Props) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const { messages, stream, busy, hasMore, loadingOlder } = state;
  const showStream = stream !== null;
  const streaming = stream?.text ?? "";
  const anchorIndex = stream ? messages.findIndex((m) => m.id === stream.anchor) : -1;
  const streamIndex = anchorIndex < 0 ? messages.length : anchorIndex + 1;
  const rowCount = messages.length + (showStream ? 1 : 0);
  const [input, setInput] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [showJump, setShowJump] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickBottom = useRef(true);
  const imagesRef = useRef<string[]>([]);
  const pendingImageReadsRef = useRef(0);
  const releaseGenRef = useRef(0);
  imagesRef.current = images;

  const noKey = hasProviderKey === false;
  const blocked = noKey || sendLocked || state.phase !== "idle";
  const setupNeeded = noKeysConfigured;
  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 8,
  });
  const scrollToBottom = useCallback(() => {
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    if (!chat) return;
    setShowJump(false);
    void session.loadRecent().catch((e) => onNotify((e as Error).message || String(e), "err"));
  }, [chat?.id, session, onNotify]);

  useEffect(() => {
    if (!chat || state.phase !== "idle" || !state.drafts.length) return;
    if (inputRef.current?.value || imagesRef.current.length || pendingImageReadsRef.current) return;
    const drafts = session.takeDrafts();
    setInput(drafts.map((d) => d.text).join("\n"));
    setImages(drafts.flatMap((d) => d.images));
  }, [chat?.id, session, state.drafts, state.phase, input, images.length]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onMainWindowHidden(() => {
      releaseGenRef.current += 1;
      setImages([]);
      if (fileRef.current) fileRef.current.value = "";
      session.trim();
      session.dropDraftImages();
      stickBottom.current = true;
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [session]);

  useLayoutEffect(() => {
    if (stickBottom.current) scrollToBottom();
  }, [messages, streaming, showStream, scrollToBottom]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });
    return () => cancelAnimationFrame(id);
  }, [focusNonce, chat?.id]);
  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => { resizeComposer(); }, [input]);

  function resizeComposer() {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(Math.max(el.scrollHeight, LINE_H * MIN_LINES), LINE_H * MAX_LINES);
    el.style.height = `${next}px`;
  }

  async function loadOlder() {
    if (!chat || !hasMore || loadingOlder) return;
    const el = parentRef.current;
    const height = el?.scrollHeight ?? 0;
    const top = el?.scrollTop ?? 0;
    try {
      await session.loadOlder();
    } catch (e) {
      onNotify((e as Error).message || String(e), "err");
      return;
    }
    stickBottom.current = false;
    requestAnimationFrame(() => {
      if (el) el.scrollTop = top + el.scrollHeight - height;
    });
  }
  function onScroll() {
    const el = parentRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
    if (!chat || busy || state.phase !== "idle") return;
    await updateChat(chat.id, { provider, model_id: modelId });
    onChatMeta({ ...chat, provider, model_id: modelId });
    onChatUpdated();
  }
  function send() {
    if (!chat || blocked) {
      if (setupNeeded) onNeedKey?.();
      return;
    }
    const text = input.trim();
    if (!text && !images.length) return;
    const sent = session.send(chat, text, [...images], {
      onChatUpdated, onChatMeta, onNotify: (message, kind) => onNotify(message, kind),
    });
    if (!sent) return;
    flushSync(() => { setInput(""); setImages([]); });
    stickBottom.current = true;
  }
  function regenerate(userMessageId: string) {
    if (!chat || blocked) {
      if (setupNeeded) onNeedKey?.();
      return;
    }
    session.regenerate(chat, userMessageId, {
      onChatUpdated, onChatMeta, onNotify: (message, kind) => onNotify(message, kind),
    });
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
              const m = isStream
                ? null
                : messages[showStream && row.index > streamIndex ? row.index - 1 : row.index];
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
                  if (!sendLocked) send();
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
                disabled={busy || sendLocked}
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
            {busy ? (
              <button
                type="button"
                className="ghost"
                onClick={() => session.stop()}
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
