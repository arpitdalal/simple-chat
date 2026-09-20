import {
  isRegistered,
  register,
  unregister,
  unregisterAll,
} from "@tauri-apps/plugin-global-shortcut";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  cursorPosition,
  getCurrentWindow,
  monitorFromPoint,
  primaryMonitor,
  type Window,
} from "@tauri-apps/api/window";

export const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";

/** Currently preferred registered accelerator, or null if none. */
let activeHotkey: string | null = null;

/**
 * Accelerators that may still be live with the OS after a failed cleanup.
 * Swept on the next apply so orphans cannot keep toggling the window.
 */
let orphanHotkeys: string[] = [];

/** Serialize rebinds so OS map and activeHotkey stay aligned. */
let applyChain: Promise<void> = Promise.resolve();

export function getActiveHotkey(): string | null {
  return activeHotkey;
}

/** Reset module state (tests only). */
export function resetActiveHotkeyForTests() {
  activeHotkey = null;
  orphanHotkeys = [];
  applyChain = Promise.resolve();
}

/** Center on the monitor under the cursor; fall back to primary / window.center(). */
export async function centerOnCursorMonitor(win: Window = getCurrentWindow()) {
  try {
    const cursor = await cursorPosition();
    const monitor =
      (await monitorFromPoint(cursor.x, cursor.y)) ?? (await primaryMonitor());
    if (!monitor) {
      await win.center();
      return;
    }
    const size = await win.outerSize();
    const { position, size: area } = monitor.workArea;
    await win.setPosition(
      new PhysicalPosition(
        Math.round(position.x + (area.width - size.width) / 2),
        Math.round(position.y + (area.height - size.height) / 2),
      ),
    );
  } catch {
    try {
      await win.center();
    } catch {
      // still show/focus even if positioning fails
    }
  }
}

export async function toggleMainWindow() {
  const win = getCurrentWindow();
  if (await win.isVisible()) {
    await win.hide();
  } else {
    await centerOnCursorMonitor(win);
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

/** yes = ours, no = not ours, unknown = probe failed */
type RegProbe = "yes" | "no" | "unknown";

async function probeRegistered(accel: string): Promise<RegProbe> {
  try {
    return (await isRegistered(accel)) ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

async function sweepOrphans(keep: Set<string>) {
  const remaining: string[] = [];
  const failed: string[] = [];
  for (const accel of orphanHotkeys) {
    if (keep.has(accel)) {
      remaining.push(accel);
      continue;
    }
    try {
      await unregister(accel);
    } catch {
      const probe = await probeRegistered(accel);
      if (probe === "no") continue; // confirmed gone
      remaining.push(accel);
      failed.push(accel);
    }
  }
  orphanHotkeys = remaining;
  if (failed.length) {
    throw new Error(
      `Could not release ${formatHotkey(failed[0])}. Rebind or restart.`,
    );
  }
}

/**
 * Register global hotkey; replaces any previous.
 * Registers the new binding first so a conflict never leaves the app unbound.
 */
export async function applyHotkey(accelerator: string) {
  const run = async () => {
    const next = accelerator.trim() || DEFAULT_HOTKEY;
    const prev = activeHotkey;
    if (prev === next && orphanHotkeys.length === 0) return;

    const nextWasOrphan = orphanHotkeys.includes(next);
    await sweepOrphans(new Set([next, ...(prev ? [prev] : [])]));

    if (prev === next) return;

    if (nextWasOrphan) {
      const probe = await probeRegistered(next);
      if (probe === "unknown") {
        throw new Error(
          `Could not verify ${formatHotkey(next)} is still registered. Rebind or restart.`,
        );
      }
      if (probe === "yes") {
        orphanHotkeys = orphanHotkeys.filter((a) => a !== next);
      } else {
        orphanHotkeys = orphanHotkeys.filter((a) => a !== next);
        try {
          await register(next, onHotkey);
        } catch (err) {
          throw new Error(conflictMessage(next, err));
        }
      }
    } else {
      try {
        await register(next, onHotkey);
      } catch (err) {
        throw new Error(conflictMessage(next, err));
      }
    }

    if (prev) {
      try {
        await unregister(prev);
      } catch {
        const prevProbe = await probeRegistered(prev);
        if (prevProbe === "unknown") {
          // Uncertain whether prev is still live — keep tracking it; leave next active.
          orphanHotkeys.push(prev);
          activeHotkey = next;
          throw new Error(
            `Registered ${formatHotkey(next)} but could not verify release of ${formatHotkey(prev)}. Rebind or restart.`,
          );
        }
        if (prevProbe === "yes") {
          // New is live; try to drop it so previous remains the only binding.
          try {
            await unregister(next);
          } catch {
            const nextProbe = await probeRegistered(next);
            if (nextProbe !== "no") orphanHotkeys.push(next);
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
        // prev confirmed gone from OS — treat as success
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

/** Drop all app shortcuts so Record can hear our own combo. */
export async function clearHotkey() {
  const run = async () => {
    try {
      await unregisterAll();
      activeHotkey = null;
      orphanHotkeys = [];
    } catch (err) {
      // unregisterAll may have partially cleared — don't trust tracking.
      const prev = activeHotkey;
      activeHotkey = null;
      if (prev && !orphanHotkeys.includes(prev)) orphanHotkeys.push(prev);
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not release hotkeys for recording${detail ? ` — ${detail}` : ""}. Rebind or restart.`,
      );
    }
  };
  const queued = applyChain.then(run, run);
  applyChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

/** True when accelerator has ≥1 modifier + a key (same rule as Record). */
export function isValidAccelerator(raw: string): boolean {
  const parts = raw
    .trim()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return false;
  const mods = parts.slice(0, -1);
  const key = parts[parts.length - 1];
  if (!key || key === "Unidentified") return false;
  const known = new Set([
    "CommandOrControl",
    "CmdOrControl",
    "Command",
    "Control",
    "Ctrl",
    "Alt",
    "Option",
    "Shift",
    "Super",
    "Meta",
  ]);
  return mods.some((m) => known.has(m));
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
    .replace(/CmdOrControl/g, "⌘/Ctrl")
    .replace(/Command/g, "⌘")
    .replace(/Control/g, "Ctrl")
    .replace(/Shift/g, "⇧")
    .replace(/Alt/g, "⌥")
    .replace(/\+/g, " + ");
}
