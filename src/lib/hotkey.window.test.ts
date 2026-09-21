import { beforeEach, describe, expect, it, vi } from "vitest";

const hide = vi.fn();
const show = vi.fn();
const setFocus = vi.fn();
const isVisible = vi.fn();
const outerSize = vi.fn();
const setPosition = vi.fn();
const center = vi.fn();
const scaleFactor = vi.fn();
const cursorPosition = vi.fn();
const availableMonitors = vi.fn();
const primaryMonitor = vi.fn();
const currentMonitor = vi.fn();
const register = vi.fn();
const unregister = vi.fn();
const unregisterAll = vi.fn();
const isRegistered = vi.fn();
const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

vi.mock("@tauri-apps/api/dpi", () => ({
  PhysicalPosition: class {
    x: number;
    y: number;
    type = "Physical";
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  },
  LogicalPosition: class {
    x: number;
    y: number;
    type = "Logical";
    constructor(x: number, y: number) {
      this.x = x;
      this.y = y;
    }
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide,
    show,
    setFocus,
    isVisible,
    outerSize,
    setPosition,
    center,
    scaleFactor,
  }),
  cursorPosition: (...a: unknown[]) => cursorPosition(...a),
  availableMonitors: (...a: unknown[]) => availableMonitors(...a),
  primaryMonitor: (...a: unknown[]) => primaryMonitor(...a),
  currentMonitor: (...a: unknown[]) => currentMonitor(...a),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: (...a: unknown[]) => register(...a),
  unregister: (...a: unknown[]) => unregister(...a),
  unregisterAll: (...a: unknown[]) => unregisterAll(...a),
  isRegistered: (...a: unknown[]) => isRegistered(...a),
}));

import {
  applyHotkey,
  centerOnCursorMonitor,
  clearHotkey,
  getActiveHotkey,
  hideMainWindow,
  monitorForCursor,
  positionMainWindowForShow,
  resetActiveHotkeyForTests,
  setPreferLogicalMonitorFramesForTests,
  toggleMainWindow,
} from "./hotkey";

const primary = {
  scaleFactor: 1,
  position: { x: 0, y: 0 },
  size: { width: 1920, height: 1080 },
  workArea: {
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 },
  },
};

const secondary = {
  scaleFactor: 1,
  position: { x: 1920, y: 0 },
  size: { width: 1920, height: 1080 },
  workArea: {
    position: { x: 1920, y: 0 },
    size: { width: 1920, height: 1080 },
  },
};

/** Independently physicalized mixed-DPI layout (Codex overlap case). */
const retinaPrimary = {
  scaleFactor: 2,
  position: { x: 0, y: 0 },
  size: { width: 3024, height: 1964 },
  workArea: {
    position: { x: 0, y: 0 },
    size: { width: 3024, height: 1964 },
  },
};

const external1x = {
  scaleFactor: 1,
  // Logical origin 1512 → stored as 1512*1, which sits inside retinaPrimary's physical width.
  position: { x: 1512, y: 0 },
  size: { width: 1920, height: 1080 },
  workArea: {
    position: { x: 1512, y: 0 },
    size: { width: 1920, height: 1080 },
  },
};

describe("hotkey window actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveHotkeyForTests();
    isRegistered.mockResolvedValue(false);
    invoke.mockResolvedValue(undefined);
    outerSize.mockResolvedValue({ width: 800, height: 600 });
    // Default: window on primary — cursor-on-secondary tests still recenter.
    currentMonitor.mockResolvedValue(primary);
    scaleFactor.mockResolvedValue(1);
    cursorPosition.mockResolvedValue({ x: 2000, y: 100 });
    availableMonitors.mockResolvedValue([primary, secondary]);
    primaryMonitor.mockResolvedValue(primary);
    setPosition.mockResolvedValue(undefined);
    center.mockResolvedValue(undefined);
  });

  it("hideMainWindow invokes hide_main_window_cmd", async () => {
    await hideMainWindow();
    expect(invoke).toHaveBeenCalledWith("hide_main_window_cmd");
    expect(hide).not.toHaveBeenCalled();
  });

  it("toggleMainWindow hides when visible", async () => {
    isVisible.mockResolvedValue(true);
    await toggleMainWindow();
    expect(invoke).toHaveBeenCalledWith("hide_main_window_cmd");
    expect(show).not.toHaveBeenCalled();
    expect(setPosition).not.toHaveBeenCalled();
  });

  it("toggleMainWindow centers on cursor monitor then shows when hidden", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    isVisible.mockResolvedValue(false);
    await toggleMainWindow();
    expect(invoke).toHaveBeenCalledWith("capture_previous_app");
    expect(setPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "Physical",
        x: 1920 + (1920 - 800) / 2,
        y: (1080 - 600) / 2,
      }),
    );
    expect(show).toHaveBeenCalled();
    expect(setFocus).toHaveBeenCalled();
    expect(setPosition.mock.invocationCallOrder[0]).toBeLessThan(
      invoke.mock.invocationCallOrder[0],
    );
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(
      show.mock.invocationCallOrder[0],
    );
    expect(invoke).toHaveBeenCalledWith("capture_previous_app");
  });

  it("positionMainWindowForShow keeps place when cursor is on the same monitor", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    currentMonitor.mockResolvedValue(primary);
    cursorPosition.mockResolvedValue({ x: 200, y: 200 });
    await positionMainWindowForShow();
    expect(setPosition).not.toHaveBeenCalled();
    expect(center).not.toHaveBeenCalled();
  });

  it("positionMainWindowForShow trusts currentMonitor on mixed-DPI overlap", async () => {
    // Physical AABBs overlap; runtime says external — must not false-match primary.
    setPreferLogicalMonitorFramesForTests(true);
    availableMonitors.mockResolvedValue([retinaPrimary, external1x]);
    currentMonitor.mockResolvedValue(external1x);
    cursorPosition.mockResolvedValue({ x: 2000, y: 100 }); // logical → external
    await positionMainWindowForShow();
    expect(setPosition).not.toHaveBeenCalled();
  });

  it("positionMainWindowForShow recenters across mixed-DPI monitors on macOS", async () => {
    setPreferLogicalMonitorFramesForTests(true);
    availableMonitors.mockResolvedValue([retinaPrimary, external1x]);
    currentMonitor.mockResolvedValue(retinaPrimary);
    cursorPosition.mockResolvedValue({ x: 2000, y: 100 }); // logical → external
    await positionMainWindowForShow();
    expect(setPosition).toHaveBeenCalled();
  });

  it("positionMainWindowForShow recenters when currentMonitor is null", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    currentMonitor.mockResolvedValue(null);
    cursorPosition.mockResolvedValue({ x: 200, y: 200 });
    await positionMainWindowForShow();
    expect(setPosition).toHaveBeenCalled();
  });

  it("positionMainWindowForShow recenters when cursor is on another monitor", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    currentMonitor.mockResolvedValue(primary);
    cursorPosition.mockResolvedValue({ x: 2000, y: 100 });
    await positionMainWindowForShow();
    expect(setPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "Physical",
        x: 1920 + (1920 - 800) / 2,
        y: (1080 - 600) / 2,
      }),
    );
  });

  it("toggleMainWindow preserves position when already on cursor monitor", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    isVisible.mockResolvedValue(false);
    currentMonitor.mockResolvedValue(primary);
    cursorPosition.mockResolvedValue({ x: 200, y: 200 });
    await toggleMainWindow();
    expect(setPosition).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalled();
    expect(setFocus).toHaveBeenCalled();
  });

  it("monitorForCursor picks monitor containing physical cursor", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    await expect(monitorForCursor()).resolves.toBe(secondary);
  });

  it("monitorForCursor picks nearest when cursor is in a gap", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    cursorPosition.mockResolvedValue({ x: 1910, y: -50 });
    await expect(monitorForCursor()).resolves.toBe(primary);
  });

  it("monitorForCursor uses logical frames when physical AABBs overlap", async () => {
    setPreferLogicalMonitorFramesForTests(true);
    availableMonitors.mockResolvedValue([retinaPrimary, external1x]);
    // Desktop points on the external; raw physical AABB would also hit retinaPrimary.
    cursorPosition.mockResolvedValue({ x: 2000, y: 100 });
    await expect(monitorForCursor()).resolves.toBe(external1x);
  });

  it("monitorForCursor prefers unique physical hit over misleading logical frame", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    // Non-overlapping physical rects, different scales — cursor on first monitor
    // but x=3000 sits inside the second monitor's logical frame [2560,4480).
    const left2x = {
      scaleFactor: 2,
      position: { x: 0, y: 0 },
      size: { width: 3840, height: 2160 },
      workArea: {
        position: { x: 0, y: 0 },
        size: { width: 3840, height: 2160 },
      },
    };
    const right15x = {
      scaleFactor: 1.5,
      position: { x: 3840, y: 0 },
      size: { width: 2880, height: 1620 },
      workArea: {
        position: { x: 3840, y: 0 },
        size: { width: 2880, height: 1620 },
      },
    };
    availableMonitors.mockResolvedValue([left2x, right15x]);
    cursorPosition.mockResolvedValue({ x: 3000, y: 100 });
    await expect(monitorForCursor()).resolves.toBe(left2x);
  });

  it("monitorForCursor uses logical when overlap layout hides cursor from right AABB", async () => {
    setPreferLogicalMonitorFramesForTests(true);
    // 2× left [0,3024) and 1.5× right origin 1512*1.5=2268 — overlap layout;
    // desktop-point cursor 1800 is on the right, but only left's physical AABB contains it.
    const left2x = {
      scaleFactor: 2,
      position: { x: 0, y: 0 },
      size: { width: 3024, height: 1964 },
      workArea: {
        position: { x: 0, y: 0 },
        size: { width: 3024, height: 1964 },
      },
    };
    const right15x = {
      scaleFactor: 1.5,
      position: { x: 2268, y: 0 },
      size: { width: 2880, height: 1620 },
      workArea: {
        position: { x: 2268, y: 0 },
        size: { width: 2880, height: 1620 },
      },
    };
    availableMonitors.mockResolvedValue([left2x, right15x]);
    cursorPosition.mockResolvedValue({ x: 1800, y: 100 });
    await expect(monitorForCursor()).resolves.toBe(right15x);
  });

  it("monitorForCursor on macOS prefers logical for adjacent same-scale Retinas", async () => {
    setPreferLogicalMonitorFramesForTests(true);
    // Independently physicalized [0,3024) | [3024,6048) — no overlap, but cursor is points.
    const left = {
      scaleFactor: 2,
      position: { x: 0, y: 0 },
      size: { width: 3024, height: 1964 },
      workArea: {
        position: { x: 0, y: 0 },
        size: { width: 3024, height: 1964 },
      },
    };
    const right = {
      scaleFactor: 2,
      position: { x: 3024, y: 0 },
      size: { width: 3024, height: 1964 },
      workArea: {
        position: { x: 3024, y: 0 },
        size: { width: 3024, height: 1964 },
      },
    };
    availableMonitors.mockResolvedValue([left, right]);
    cursorPosition.mockResolvedValue({ x: 1800, y: 100 });
    await expect(monitorForCursor()).resolves.toBe(right);
  });

  it("centerOnCursorMonitor scales outerSize into destination monitor DPI", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    availableMonitors.mockResolvedValue([retinaPrimary, external1x]);
    cursorPosition.mockResolvedValue({ x: 2000, y: 100 });
    scaleFactor.mockResolvedValue(2); // window last on retina
    outerSize.mockResolvedValue({ width: 1600, height: 1200 }); // physical @2x
    await centerOnCursorMonitor();
    // Destination is 1x → logical 800x600 → physical 800x600 on external
    expect(setPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "Physical",
        x: 1512 + Math.round((1920 - 800) / 2),
        y: Math.round((1080 - 600) / 2),
      }),
    );
  });

  it("centerOnCursorMonitor on macOS uses LogicalPosition in desktop points", async () => {
    setPreferLogicalMonitorFramesForTests(true);
    availableMonitors.mockResolvedValue([retinaPrimary, external1x]);
    cursorPosition.mockResolvedValue({ x: 2000, y: 100 });
    scaleFactor.mockResolvedValue(2);
    outerSize.mockResolvedValue({ width: 1600, height: 1200 });
    await centerOnCursorMonitor();
    // external scale 1 → work area already points; win logical 800x600
    expect(setPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "Logical",
        x: 1512 + Math.round((1920 - 800) / 2),
        y: Math.round((1080 - 600) / 2),
      }),
    );
  });

  it("centerOnCursorMonitor clamps oversized window into workArea", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    outerSize.mockResolvedValue({ width: 3000, height: 2000 });
    await centerOnCursorMonitor();
    expect(setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ type: "Physical", x: 1920, y: 0 }),
    );
  });

  it("centerOnCursorMonitor falls back to center() when no monitors", async () => {
    availableMonitors.mockResolvedValue([]);
    primaryMonitor.mockResolvedValue(null);
    await centerOnCursorMonitor();
    expect(center).toHaveBeenCalled();
    expect(setPosition).not.toHaveBeenCalled();
  });

  it("centerOnCursorMonitor falls back to center() when cursor fails", async () => {
    cursorPosition.mockRejectedValue(new Error("no cursor"));
    await centerOnCursorMonitor();
    expect(center).toHaveBeenCalled();
    expect(setPosition).not.toHaveBeenCalled();
  });

  it("toggleMainWindow still shows when positioning fails", async () => {
    isVisible.mockResolvedValue(false);
    cursorPosition.mockRejectedValue(new Error("no cursor"));
    center.mockRejectedValue(new Error("no center"));
    await toggleMainWindow();
    expect(show).toHaveBeenCalled();
    expect(setFocus).toHaveBeenCalled();
  });

  it("centerOnCursorMonitor still setPositions when outerSize fails", async () => {
    setPreferLogicalMonitorFramesForTests(false);
    outerSize.mockRejectedValue(new Error("hidden size"));
    await centerOnCursorMonitor();
    expect(setPosition).toHaveBeenCalledWith(
      expect.objectContaining({ type: "Physical", x: 1920, y: 0 }),
    );
    expect(center).not.toHaveBeenCalled();
  });

  it("toggleMainWindow serializes overlapping presses", async () => {
    let releaseHide: () => void = () => {};
    const hideGate = new Promise<void>((r) => {
      releaseHide = r;
    });
    isVisible.mockResolvedValueOnce(true).mockResolvedValue(false);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "hide_main_window_cmd") return hideGate;
    });
    show.mockResolvedValue(undefined);

    const first = toggleMainWindow();
    const second = toggleMainWindow();
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("hide_main_window_cmd"),
    );
    expect(show).not.toHaveBeenCalled();

    releaseHide();
    await Promise.all([first, second]);
    expect(show).toHaveBeenCalled();
  });

  it("applyHotkey registers accelerator", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+Space");
    expect(register).toHaveBeenCalledWith(
      "CommandOrControl+Shift+Space",
      expect.any(Function),
    );
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+Space");
  });

  it("applyHotkey registers new before unregistering previous", async () => {
    register.mockResolvedValue(undefined);
    unregister.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");
    await applyHotkey("CommandOrControl+Shift+B");

    expect(register.mock.calls.map((c) => c[0])).toEqual([
      "CommandOrControl+Shift+A",
      "CommandOrControl+Shift+B",
    ]);
    expect(unregister).toHaveBeenCalledWith("CommandOrControl+Shift+A");
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+B");
  });

  it("applyHotkey keeps previous when new register fails", async () => {
    register.mockResolvedValueOnce(undefined);
    await applyHotkey("CommandOrControl+Shift+A");

    register.mockRejectedValueOnce(new Error("already registered"));

    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /Could not register/i,
    );

    expect(unregister).not.toHaveBeenCalled();
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+A");
  });

  it("applyHotkey no-ops when accelerator unchanged", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");
    register.mockClear();
    await applyHotkey("CommandOrControl+Shift+A");
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
  });

  it("applyHotkey serializes concurrent rebinds", async () => {
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    register.mockImplementationOnce(async () => firstGate);
    register.mockResolvedValue(undefined);
    unregister.mockResolvedValue(undefined);

    const first = applyHotkey("CommandOrControl+Shift+A");
    const second = applyHotkey("CommandOrControl+Shift+B");
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));

    releaseFirst();
    await Promise.all([first, second]);
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+B");
    expect(unregister).toHaveBeenCalledWith("CommandOrControl+Shift+A");
  });

  it("applyHotkey throws when previous cannot be released", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");

    unregister.mockRejectedValueOnce(new Error("busy"));
    isRegistered.mockResolvedValueOnce(true); // prev still ours
    unregister.mockResolvedValueOnce(undefined); // drop next

    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /could not release/i,
    );
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+A");
  });

  it("applyHotkey throws when both unregisters fail", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");

    unregister.mockRejectedValue(new Error("busy"));
    isRegistered.mockResolvedValue(true);

    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /Could not finish switching/i,
    );
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+A");
  });

  it("applyHotkey sweeps orphan after dual-unregister failure", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");

    unregister.mockRejectedValue(new Error("busy"));
    isRegistered.mockResolvedValue(true);
    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /Could not finish switching/i,
    );

    unregister.mockReset();
    unregister.mockResolvedValue(undefined);
    isRegistered.mockResolvedValue(false);
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+C");

    expect(unregister).toHaveBeenCalledWith("CommandOrControl+Shift+B");
    expect(unregister).toHaveBeenCalledWith("CommandOrControl+Shift+A");
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+C");
  });

  it("applyHotkey fails when orphan sweep cannot release", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");

    unregister.mockRejectedValue(new Error("busy"));
    isRegistered.mockResolvedValue(true);
    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /Could not finish switching/i,
    );

    unregister.mockReset();
    unregister.mockRejectedValue(new Error("busy"));
    isRegistered.mockResolvedValue(true);
    register.mockClear();
    await expect(applyHotkey("CommandOrControl+Shift+C")).rejects.toThrow(
      /Could not release/i,
    );
    expect(register).not.toHaveBeenCalled();
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+A");
  });

  it("applyHotkey promotes orphaned target when still registered", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");

    unregister.mockRejectedValue(new Error("busy"));
    isRegistered.mockResolvedValue(true);
    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /Could not finish switching/i,
    );

    unregister.mockReset();
    unregister.mockResolvedValue(undefined);
    isRegistered.mockImplementation(async (a: string) => a.includes("Shift+B"));
    register.mockClear();
    await applyHotkey("CommandOrControl+Shift+B");

    expect(register).not.toHaveBeenCalled();
    expect(unregister).toHaveBeenCalledWith("CommandOrControl+Shift+A");
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+B");
  });

  it("applyHotkey keeps next and orphans prev when prev probe is unknown", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");

    unregister.mockRejectedValueOnce(new Error("busy"));
    isRegistered.mockRejectedValueOnce(new Error("ipc"));
    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /could not verify release/i,
    );
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+B");

    // Later apply of prev must not no-op; re-register/sweep path runs.
    unregister.mockReset();
    unregister.mockResolvedValue(undefined);
    isRegistered.mockResolvedValue(false);
    register.mockClear();
    await applyHotkey("CommandOrControl+Shift+A");
    expect(register).toHaveBeenCalled();
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+A");
  });

  it("applyHotkey aborts promote when ownership probe is unknown", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");

    unregister.mockRejectedValue(new Error("busy"));
    isRegistered.mockResolvedValue(true);
    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /Could not finish switching/i,
    );

    unregister.mockClear();
    register.mockClear();
    isRegistered.mockRejectedValue(new Error("ipc"));
    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /Could not verify/i,
    );
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+A");
  });

  it("clearHotkey uses unregisterAll", async () => {
    register.mockResolvedValue(undefined);
    unregisterAll.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");
    await clearHotkey();
    expect(unregisterAll).toHaveBeenCalled();
    expect(getActiveHotkey()).toBeNull();
  });

  it("clearHotkey throws when unregisterAll fails", async () => {
    register.mockResolvedValue(undefined);
    unregisterAll.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+A");
    unregisterAll.mockRejectedValueOnce(new Error("busy"));
    await expect(clearHotkey()).rejects.toThrow(/Could not release hotkeys/i);
    // Stale active cleared so a later apply re-registers instead of no-op.
    expect(getActiveHotkey()).toBeNull();
    unregisterAll.mockResolvedValue(undefined);
    register.mockClear();
    await applyHotkey("CommandOrControl+Shift+A");
    expect(register).toHaveBeenCalled();
  });
});
