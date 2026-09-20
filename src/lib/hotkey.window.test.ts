import { beforeEach, describe, expect, it, vi } from "vitest";

const hide = vi.fn();
const show = vi.fn();
const setFocus = vi.fn();
const isVisible = vi.fn();
const register = vi.fn();
const unregister = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide, show, setFocus, isVisible }),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: (...a: unknown[]) => register(...a),
  unregister: (...a: unknown[]) => unregister(...a),
  unregisterAll: vi.fn(),
}));

import {
  applyHotkey,
  getActiveHotkey,
  hideMainWindow,
  resetActiveHotkeyForTests,
  toggleMainWindow,
} from "./hotkey";

describe("hotkey window actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetActiveHotkeyForTests();
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
});
