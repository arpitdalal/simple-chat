/** Recent-page size for chat load / hide release. */
export const MESSAGE_PAGE = 50;

/**
 * Soft ceiling for message rows held in React state while visible.
 * Hide releases back to MESSAGE_PAGE; scroll-up stops at this cap.
 */
export const MAX_CACHED_MESSAGES = 200;

/** Emitted by Rust immediately before the main window hides. */
export const MAIN_WINDOW_HIDDEN_EVENT = "main-window-hidden";

/** Keep the newest `limit` rows (no-op when already within limit). */
export function trimRecentMessages<T>(messages: T[], limit: number): T[] {
  if (limit <= 0 || messages.length <= limit) return messages;
  return messages.slice(-limit);
}

/** Subscribe to tray/hide; no-op outside a live Tauri webview. */
export async function onMainWindowHidden(
  handler: () => void,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen(MAIN_WINDOW_HIDDEN_EVENT, () => {
      handler();
    });
  } catch {
    return () => {};
  }
}
