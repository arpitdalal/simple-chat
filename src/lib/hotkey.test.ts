import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: vi.fn(),
  unregister: vi.fn(),
  unregisterAll: vi.fn(),
  isRegistered: vi.fn(async () => false),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: vi.fn(),
    show: vi.fn(),
    setFocus: vi.fn(),
    isVisible: vi.fn(async () => true),
  }),
}));

import {
  eventToAccelerator,
  formatHotkey,
  isValidAccelerator,
  DEFAULT_HOTKEY,
} from "./hotkey";

function keyEvent(partial: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "a",
    code: "KeyA",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  } as KeyboardEvent;
}

describe("hotkey helpers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("formats default accelerator for display", () => {
    expect(formatHotkey(DEFAULT_HOTKEY)).toContain("⌘/Ctrl");
    expect(formatHotkey(DEFAULT_HOTKEY)).toContain("⇧");
    expect(formatHotkey(DEFAULT_HOTKEY)).toContain("Space");
  });

  it("maps cmd/ctrl+shift+letter to accelerator", () => {
    expect(
      eventToAccelerator(
        keyEvent({ metaKey: true, shiftKey: true, code: "KeyK", key: "k" }),
      ),
    ).toBe("CommandOrControl+Shift+K");
  });

  it("rejects bare keys and modifier-only presses", () => {
    expect(eventToAccelerator(keyEvent({ code: "KeyA", key: "a" }))).toBeNull();
    expect(
      eventToAccelerator(
        keyEvent({ key: "Meta", code: "MetaLeft", metaKey: true }),
      ),
    ).toBeNull();
  });

  it("isValidAccelerator requires a modifier", () => {
    expect(isValidAccelerator("A")).toBe(false);
    expect(isValidAccelerator("CommandOrControl+Shift+K")).toBe(true);
    expect(isValidAccelerator("CmdOrControl+Space")).toBe(true);
    expect(isValidAccelerator(DEFAULT_HOTKEY)).toBe(true);
  });
});
