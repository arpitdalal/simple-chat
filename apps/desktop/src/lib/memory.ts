import { listen } from "@tauri-apps/api/event";

/** Recent-page size for chat load / hide release. */
export const MESSAGE_PAGE = 50;

/**
 * Soft ceiling for message rows held in React state while visible.
 * Hide releases back to MESSAGE_PAGE; scroll-up stops at this cap.
 */
export const MAX_CACHED_MESSAGES = 200;

/** Emitted by Rust immediately before the main window hides. */
export const MAIN_WINDOW_HIDDEN_EVENT = "main-window-hidden";
export const MAIN_WINDOW_SHOWN_EVENT = "main-window-shown";

/** Keep the newest `limit` rows (no-op when already within limit). */
export function trimRecentMessages<T>(messages: T[], limit: number): T[] {
  if (limit <= 0 || messages.length <= limit) return messages;
  return messages.slice(-limit);
}

/** Subscribe to tray/hide; no-op outside a live Tauri webview. */
export async function onMainWindowHidden(
  handler: () => void,
): Promise<() => void> {
  return onMainWindowEvent(MAIN_WINDOW_HIDDEN_EVENT, handler);
}

export async function onMainWindowShown(
  handler: () => void,
): Promise<() => void> {
  return onMainWindowEvent(MAIN_WINDOW_SHOWN_EVENT, handler);
}

async function onMainWindowEvent(
  event: string,
  handler: () => void,
): Promise<() => void> {
  try {
    return await listen(event, () => {
      handler();
    });
  } catch {
    return () => {};
  }
}
