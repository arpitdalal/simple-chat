import { invoke } from "@tauri-apps/api/core";
import {
  isRegistered,
  register,
  unregister,
  unregisterAll,
} from "@tauri-apps/plugin-global-shortcut";
import { LogicalPosition, PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  availableMonitors,
  currentMonitor,
  cursorPosition,
  getCurrentWindow,
  primaryMonitor,
  type Monitor,
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

/** Serialize show/hide so overlapping hotkey presses don't race visibility. */
let toggleChain: Promise<void> = Promise.resolve();

/** Tests only — force macOS-style logical vs physical hit-test preference. */
let preferLogicalFramesForTests: boolean | null = null;

export function getActiveHotkey(): string | null {
  return activeHotkey;
}

/** Reset module state (tests only). */
export function resetActiveHotkeyForTests() {
  activeHotkey = null;
  orphanHotkeys = [];
  applyChain = Promise.resolve();
  toggleChain = Promise.resolve();
  preferLogicalFramesForTests = null;
}

/** Tests only. */
export function setPreferLogicalMonitorFramesForTests(v: boolean | null) {
  preferLogicalFramesForTests = v;
}

function containsPoint(
  mon: Monitor,
  x: number,
  y: number,
): boolean {
  const { x: left, y: top } = mon.position;
  const { width, height } = mon.size;
  return x >= left && x < left + width && y >= top && y < top + height;
}

/** Desktop-point frame — undoes per-monitor physicalization that can overlap on macOS. */
function logicalFrame(mon: Monitor) {
  const s = mon.scaleFactor || 1;
  return {
    mon,
    x: mon.position.x / s,
    y: mon.position.y / s,
    w: mon.size.width / s,
    h: mon.size.height / s,
  };
}

function frameContains(
  f: { x: number; y: number; w: number; h: number },
  x: number,
  y: number,
): boolean {
  return x >= f.x && x < f.x + f.w && y >= f.y && y < f.y + f.h;
}

function distanceSqToFrame(
  f: { x: number; y: number; w: number; h: number },
  x: number,
  y: number,
): number {
  const dx = x < f.x ? f.x - x : x >= f.x + f.w ? x - (f.x + f.w - 1) : 0;
  const dy = y < f.y ? f.y - y : y >= f.y + f.h ? y - (f.y + f.h - 1) : 0;
  return dx * dx + dy * dy;
}

/**
 * macOS reports cursor/monitor positions in desktop points (logical), even when
 * Monitor fields are typed physical — prefer logical frames there. Elsewhere
 * prefer physical AABBs.
 */
function preferLogicalMonitorFrames(): boolean {
  if (preferLogicalFramesForTests != null) return preferLogicalFramesForTests;
  return (
    /Mac/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent)
  );
}

/**
 * Monitor containing a desktop point (cursor or window center).
 * macOS (desktop points): unique logical frame first.
 * Else (physical coords): unique physical AABB first.
 *
 * ponytail: Wayland cursor_position is (0,0) and set_position no-ops — no
 * reliable cursor-display summon until the runtime supports both.
 */
export async function monitorForPoint(
  x: number,
  y: number,
): Promise<Monitor | null> {
  const monitors = await availableMonitors();
  if (!monitors.length) return primaryMonitor();

  const frames = monitors.map(logicalFrame);
  const physicalHits = monitors.filter((m) => containsPoint(m, x, y));
  const logicalHits = frames.filter((f) => frameContains(f, x, y));

  if (preferLogicalMonitorFrames()) {
    if (logicalHits.length === 1) return logicalHits[0].mon;
    if (physicalHits.length === 1) return physicalHits[0];
  } else {
    if (physicalHits.length === 1) return physicalHits[0];
    if (logicalHits.length === 1) return logicalHits[0].mon;
  }

  const pool =
    logicalHits.length > 0
      ? logicalHits
      : physicalHits.length > 0
        ? physicalHits.map(logicalFrame)
        : frames;
  return pool.reduce((best, f) =>
    distanceSqToFrame(f, x, y) < distanceSqToFrame(best, x, y) ? f : best,
  ).mon;
}

/** Monitor under the cursor. */
export async function monitorForCursor(): Promise<Monitor | null> {
  const cursor = await cursorPosition();
  return monitorForPoint(cursor.x, cursor.y);
}

function sameMonitor(a: Monitor, b: Monitor): boolean {
  return (
    a.scaleFactor === b.scaleFactor &&
    a.position.x === b.position.x &&
    a.position.y === b.position.y &&
    a.size.width === b.size.width &&
    a.size.height === b.size.height
  );
}

function clampedCenter(
  workPos: { x: number; y: number },
  workSize: { width: number; height: number },
  winSize: { width: number; height: number },
): { x: number; y: number } {
  const w = winSize.width > 0 ? winSize.width : 0;
  const h = winSize.height > 0 ? winSize.height : 0;
  let x = Math.round(workPos.x + (workSize.width - w) / 2);
  let y = Math.round(workPos.y + (workSize.height - h) / 2);
  if (w > 0) {
    x = Math.min(
      Math.max(x, workPos.x),
      workPos.x + Math.max(0, workSize.width - w),
    );
  } else {
    x = workPos.x;
  }
  if (h > 0) {
    y = Math.min(
      Math.max(y, workPos.y),
      workPos.y + Math.max(0, workSize.height - h),
    );
  } else {
    y = workPos.y;
  }
  return { x, y };
}

/** Logical outer size (desktop points) — correct input for macOS setPosition. */
async function outerSizeLogical(
  win: Window,
): Promise<{ width: number; height: number }> {
  const outer = await win.outerSize();
  let srcScale = 1;
  try {
    srcScale = (await win.scaleFactor()) || 1;
  } catch {
    srcScale = 1;
  }
  return {
    width: Math.round(outer.width / srcScale),
    height: Math.round(outer.height / srcScale),
  };
}

/** Map outerSize from the window's current scale into the destination monitor's. */
async function outerSizeForMonitor(
  win: Window,
  monitor: Monitor,
): Promise<{ width: number; height: number }> {
  const outer = await win.outerSize();
  let srcScale = 1;
  try {
    srcScale = (await win.scaleFactor()) || 1;
  } catch {
    srcScale = 1;
  }
  const dstScale = monitor.scaleFactor || srcScale;
  const factor = dstScale / srcScale;
  return {
    width: Math.round(outer.width * factor),
    height: Math.round(outer.height * factor),
  };
}

/** Center on the monitor under the cursor; fall back to window.center(). */
export async function centerOnCursorMonitor(win: Window = getCurrentWindow()) {
  let monitor: Monitor | null = null;
  try {
    monitor = await monitorForCursor();
  } catch {
    try {
      await win.center();
    } catch {
      /* still show/focus even if positioning fails */
    }
    return;
  }
  if (!monitor) {
    try {
      await win.center();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    if (preferLogicalMonitorFrames()) {
      // macOS: setPosition(PhysicalPosition) rescales via the *source* window
      // factor — pass LogicalPosition in desktop points instead.
      const s = monitor.scaleFactor || 1;
      const workPos = {
        x: monitor.workArea.position.x / s,
        y: monitor.workArea.position.y / s,
      };
      const workSize = {
        width: monitor.workArea.size.width / s,
        height: monitor.workArea.size.height / s,
      };
      let size = { width: 0, height: 0 };
      try {
        size = await outerSizeLogical(win);
      } catch {
        /* origin fallback */
      }
      const { x, y } = clampedCenter(workPos, workSize, size);
      await win.setPosition(new LogicalPosition(x, y));
    } else {
      let size = { width: 0, height: 0 };
      try {
        size = await outerSizeForMonitor(win, monitor);
      } catch {
        /* origin fallback */
      }
      const { x, y } = clampedCenter(
        monitor.workArea.position,
        monitor.workArea.size,
        size,
      );
      await win.setPosition(new PhysicalPosition(x, y));
    }
  } catch {
    // setPosition failed — center() may land on the wrong display.
    try {
      await win.center();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Recenter only when the cursor is on a different monitor than the window.
 * Same-monitor summon keeps the user's last position (hide keeps geometry).
 * Uses currentMonitor() so mixed-DPI overlapping AABBs don't false-match.
 */
export async function positionMainWindowForShow(
  win: Window = getCurrentWindow(),
) {
  try {
    const cursorMon = await monitorForCursor();
    let winMon: Monitor | null = null;
    try {
      winMon = await currentMonitor();
    } catch {
      winMon = null;
    }
    if (cursorMon && winMon && sameMonitor(cursorMon, winMon)) return;
  } catch {
    /* fall through — centerOnCursorMonitor has its own fallbacks */
  }
  await centerOnCursorMonitor(win);
}

export async function toggleMainWindow() {
  const run = async () => {
    const win = getCurrentWindow();
    if (await win.isVisible()) {
      await hideMainWindow();
    } else {
      await positionMainWindowForShow(win);
      // Recapture immediately before steal — frontmost may have changed while centering.
      await invoke("capture_previous_app");
      await win.show();
      await win.setFocus();
    }
  };
  const queued = toggleChain.then(run, run);
  toggleChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

/** Hide and hand keyboard focus back to the previously active app. */
export async function hideMainWindow() {
  await invoke("hide_main_window_cmd");
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
  // Hyper (Cmd+Ctrl together) needs both modifiers; CommandOrControl alone would match only one.
  if (e.metaKey && e.ctrlKey) {
    parts.push("Control");
  } else if (e.metaKey || e.ctrlKey) {
    // One setting works cross-platform when only Cmd or only Ctrl is held.
    parts.push("CommandOrControl");
  }
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey && e.ctrlKey) parts.push("Command");

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
