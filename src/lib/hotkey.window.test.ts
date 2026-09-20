import { beforeEach, describe, expect, it, vi } from "vitest";

const hide = vi.fn();
const show = vi.fn();
const setFocus = vi.fn();
const isVisible = vi.fn();
const register = vi.fn();
const unregisterAll = vi.fn();

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide, show, setFocus, isVisible }),
}));

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: (...a: unknown[]) => register(...a),
  unregisterAll: (...a: unknown[]) => unregisterAll(...a),
}));

import {
  applyHotkey,
  hideMainWindow,
  toggleMainWindow,
} from "./hotkey";

describe("hotkey window actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("applyHotkey unregisters then registers accelerator", async () => {
    register.mockImplementation(async (_accel: string, _cb: unknown) => {});
    await applyHotkey("CommandOrControl+Shift+Space");
    expect(unregisterAll).toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(
      "CommandOrControl+Shift+Space",
      expect.any(Function),
    );
  });
});
