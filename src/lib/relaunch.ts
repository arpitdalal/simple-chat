import { invoke } from "@tauri-apps/api/core";

/** Restart as a user-visible launch (Tauri restart + SIMPLE_CHAT_VISIBLE). */
export function relaunchVisible() {
  return invoke("relaunch_visible");
}
