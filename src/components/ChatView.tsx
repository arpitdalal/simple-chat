import { useEffect, useRef, useState } from "react";
import type { ModelMessage } from "ai";
import {
  addMessage,
  listMessages,
  updateChat,
  type Chat,
  type Message,
} from "../lib/db";
import { streamChat } from "../lib/chat";
import type { ProviderId } from "../lib/models";
import { CATALOG } from "../lib/models";

type Props = {
  chat: Chat | null;
  webSearch: boolean;
  onWebSearch: (v: boolean) => void;
  onChatUpdated: () => void;
  onNew: () => void;
};

export function ChatView({
  chat,
  webSearch,
  onWebSearch,
  onChatUpdated,
  onNew,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<string[]>([]);

  useEffect(() => {
    if (!chat) {
      setMessages([]);
      return;
    }
    void listMessages(chat.id).then(setMessages);
  }, [chat?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  async function send() {
    if (!chat || busy) return;
    const text = input.trim();
    if (!text && images.length === 0) return;

    setError(null);
    setInput("");
    const imageParts = [...images];
    setImages([]);

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

    const displayText =
      text || (imageParts.length ? `[${imageParts.length} image(s)]` : "");
    const userMsg = await addMessage(chat.id, "user", displayText);
    setMessages((m) => [...m, userMsg]);

    if (chat.title === "New Chat" && text) {
      const title = text.slice(0, 48) + (text.length > 48 ? "…" : "");
      await updateChat(chat.id, { title, preview: text.slice(0, 120) });
      onChatUpdated();
    }

    setBusy(true);
    setStreaming("");
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const history = await listMessages(chat.id);
      const modelMessages: ModelMessage[] = history.slice(0, -1).map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));
      modelMessages.push({
        role: "user",
        content: userContent as never,
      });

      let full = "";
      await streamChat({
        provider: chat.provider as ProviderId,
        modelId: chat.model_id,
        messages: modelMessages,
        webSearch,
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
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message || String(e));
      }
      setStreaming("");
    } finally {
      setBusy(false);
      abortRef.current = null;
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

  const modelLabel =
    CATALOG.find((m) => m.id === chat?.model_id)?.label ?? chat?.model_id;

  return (
    <main className="main">
      <header className="topbar">
        <button type="button" className="pill" onClick={onNew}>
          New Chat
        </button>
      </header>

      <div className="toggles">
        <label className={`toggle ${webSearch ? "on" : ""}`}>
          <input
            type="checkbox"
            checked={webSearch}
            onChange={(e) => onWebSearch(e.target.checked)}
          />
          Web Search
        </label>
      </div>

      <div className="messages">
        {!chat || (messages.length === 0 && !streaming) ? (
          <div className="empty-state">
            <h1>Ask Anything</h1>
            <p>BYOK chat · local history · hotkey to summon</p>
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}`}>
                <div className="msg-role">{m.role}</div>
                <pre className="msg-body">{m.content}</pre>
                {m.role === "assistant" && (
                  <button
                    type="button"
                    className="ghost tiny"
                    onClick={() => void navigator.clipboard.writeText(m.content)}
                  >
                    Copy
                  </button>
                )}
              </div>
            ))}
            {streaming && (
              <div className="msg assistant">
                <div className="msg-role">assistant</div>
                <pre className="msg-body">{streaming}</pre>
              </div>
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="composer-wrap">
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
        <div className="composer">
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
            value={input}
            placeholder="Ask AI anything…"
            rows={1}
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
        <div className="composer-meta">
          <span className="model-label">{modelLabel ?? "—"}</span>
          <div className="hints">
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
    </main>
  );
}
