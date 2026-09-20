import { beforeEach, describe, expect, it, vi } from "vitest";

const hide = vi.fn();
const show = vi.fn();
const setFocus = vi.fn();
const isVisible = vi.fn();
const register = vi.fn();
const unregister = vi.fn();
const unregisterAll = vi.fn();
const isRegistered = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide, show, setFocus, isVisible }),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: (...a: unknown[]) => register(...a),
  unregister: (...a: unknown[]) => unregister(...a),
  unregisterAll: (...a: unknown[]) => unregisterAll(...a),
  isRegistered: (...a: unknown[]) => isRegistered(...a),
}));

import {
  applyHotkey,
  clearHotkey,
  getActiveHotkey,
  hideMainWindow,
  resetActiveHotkeyForTests,
  toggleMainWindow,
} from "./hotkey";

describe("hotkey window actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveHotkeyForTests();
    isRegistered.mockResolvedValue(false);
  });

  it("hideMainWindow hides current window", async () => {
    await hideMainWindow();
    expect(hide).toHaveBeenCalled();
  });

  it("toggleMainWindow hides when visible", async () => {
    isVisible.mockResolvedValue(true);
    await toggleMainWindow();
    expect(hide).toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it("toggleMainWindow shows and focuses when hidden", async () => {
    isVisible.mockResolvedValue(false);
    await toggleMainWindow();
    expect(show).toHaveBeenCalled();
    expect(setFocus).toHaveBeenCalled();
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
  });
});
