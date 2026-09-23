import { invoke } from "@tauri-apps/api/core";

/** Restart without `--autostart` so updater/user relaunch is visible. */
export function relaunchVisible() {
  return invoke("relaunch_visible");
}
