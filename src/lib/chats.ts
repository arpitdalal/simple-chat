import type { Chat } from "./db";

/** Empty placeholder thread Raycast-style: discard when leaving. */
export function isEmptyNewChat(c: Pick<Chat, "title" | "preview">): boolean {
  return (
    c.title === "New Chat" &&
    (!c.preview.trim() || c.preview === "Ask AI anything…")
  );
}

/** Resume last chat if opened within resume_minutes; else start fresh. */
export function resolveStartupMode(
  settings: {
    last_chat_id: string | null;
    last_opened_at: number;
    resume_minutes: number;
  },
  now = Date.now(),
): "resume" | "new" {
  if (!settings.last_chat_id) return "new";
  const ageMs = now - settings.last_opened_at;
  if (ageMs <= settings.resume_minutes * 60 * 1000) return "resume";
  return "new";
}
