import {
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";

/** Currently registered accelerator, or null if none. */
let activeHotkey: string | null = null;

/** Serialize rebinds so OS map and activeHotkey stay aligned. */
let applyChain: Promise<void> = Promise.resolve();

export function getActiveHotkey(): string | null {
  return activeHotkey;
}

/** Reset module state (tests only). */
export function resetActiveHotkeyForTests() {
  activeHotkey = null;
  applyChain = Promise.resolve();
}

export async function toggleMainWindow() {
  const win = getCurrentWindow();
  if (await win.isVisible()) {
    await win.hide();
  } else {
    await win.show();
    await win.setFocus();
  }
}

export async function hideMainWindow() {
  await getCurrentWindow().hide();
}

function onHotkey(event: { state: string }) {
  if (event.state === "Pressed") void toggleMainWindow();
}

function conflictMessage(accelerator: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `Could not register ${formatHotkey(accelerator)}` +
    (detail ? ` — ${detail}` : "") +
    ". It may conflict with another app; try a different combo."
  );
}

/**
 * Register global hotkey; replaces any previous.
 * Registers the new binding first so a conflict never leaves the app unbound.
 */
export async function applyHotkey(accelerator: string) {
  const run = async () => {
    const next = accelerator.trim() || DEFAULT_HOTKEY;
    const prev = activeHotkey;
    if (prev === next) return;

    try {
      await register(next, onHotkey);
    } catch (err) {
      throw new Error(conflictMessage(next, err));
    }

    if (prev) {
      try {
        await unregister(prev);
      } catch {
        // New is live; try to drop it so previous remains the only binding.
        try {
          await unregister(next);
        } catch {
          // ponytail: both may stay live if OS rejects both unregisters; throw so UI warns
          activeHotkey = prev;
          throw new Error(
            `Could not finish switching from ${formatHotkey(prev)} to ${formatHotkey(next)}. Rebind or restart.`,
          );
        }
        activeHotkey = prev;
        throw new Error(
          `Registered ${formatHotkey(next)} but could not release ${formatHotkey(prev)}. Rebind or restart.`,
        );
      }
    }

    activeHotkey = next;
  };

  const queued = applyChain.then(run, run);
  applyChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

/** Map a KeyboardEvent to a global-shortcut accelerator, or null if incomplete. */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "OS"].includes(e.key)) return null;

  const parts: string[] = [];
  // Prefer CommandOrControl so one setting works cross-platform when only Cmd/Ctrl is held.
  if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");

  let key: string;
  if (e.code.startsWith("Key")) key = e.code.slice(3);
  else if (e.code.startsWith("Digit")) key = e.code.slice(5);
  else if (e.code === "Space") key = "Space";
  else if (e.code.startsWith("Arrow")) key = e.code; // ArrowUp etc.
  else if (e.code.startsWith("F") && e.code.length <= 3) key = e.code;
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.code;

  if (!key || key === "Unidentified") return null;
  // Require at least one modifier for global hotkeys (avoid eating plain typing).
  if (parts.length === 0) return null;

  parts.push(key);
  return parts.join("+");
}

export function formatHotkey(accelerator: string): string {
  return accelerator
    .replace(/CommandOrControl/g, "⌘/Ctrl")
    .replace(/Command/g, "⌘")
    .replace(/Control/g, "Ctrl")
    .replace(/Shift/g, "⇧")
    .replace(/Alt/g, "⌥")
    .replace(/\+/g, " + ");
}
