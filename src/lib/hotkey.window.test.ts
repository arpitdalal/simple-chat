import { beforeEach, describe, expect, it, vi } from "vitest";

const hide = vi.fn();
const show = vi.fn();
const setFocus = vi.fn();
const isVisible = vi.fn();
const register = vi.fn();
const unregister = vi.fn();
const unregisterAll = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide, show, setFocus, isVisible }),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: (...a: unknown[]) => register(...a),
  unregister: (...a: unknown[]) => unregister(...a),
  unregisterAll: (...a: unknown[]) => unregisterAll(...a),
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

  it("applyHotkey unregisters previous then registers accelerator", async () => {
    register.mockResolvedValue(undefined);
    await applyHotkey("CommandOrControl+Shift+Space");
    expect(unregisterAll).toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(
      "CommandOrControl+Shift+Space",
      expect.any(Function),
    );
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+Space");
  });

  it("applyHotkey restores previous binding when new register fails", async () => {
    register.mockResolvedValueOnce(undefined);
    await applyHotkey("CommandOrControl+Shift+A");

    register.mockRejectedValueOnce(new Error("already registered"));
    register.mockResolvedValueOnce(undefined);

    await expect(applyHotkey("CommandOrControl+Shift+B")).rejects.toThrow(
      /conflict|Could not register/i,
    );

    expect(unregister).toHaveBeenCalledWith("CommandOrControl+Shift+A");
    expect(getActiveHotkey()).toBe("CommandOrControl+Shift+A");
    expect(register).toHaveBeenLastCalledWith(
      "CommandOrControl+Shift+A",
      expect.any(Function),
    );
  });
});
