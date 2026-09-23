import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

export function shouldPromptAutostart(prompted: boolean, enabled: boolean) {
  return !prompted && !enabled;
}

export async function isAutostartEnabled() {
  return isEnabled();
}

export async function setAutostartEnabled(on: boolean) {
  if (on) await enable();
  else await disable();
}
