import { beforeEach, describe, expect, it, vi } from "vitest";

const enable = vi.hoisted(() => vi.fn());
const disable = vi.hoisted(() => vi.fn());
const isEnabled = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable,
  disable,
  isEnabled,
}));

import {
  isAutostartEnabled,
  setAutostartEnabled,
  shouldPromptAutostart,
} from "./autostart";

describe("shouldPromptAutostart", () => {
  it("asks only on first run while login-item is off", () => {
    expect(shouldPromptAutostart(false, false)).toBe(true);
    expect(shouldPromptAutostart(true, false)).toBe(false);
    expect(shouldPromptAutostart(false, true)).toBe(false);
    expect(shouldPromptAutostart(true, true)).toBe(false);
  });
});

describe("setAutostartEnabled", () => {
  beforeEach(() => {
    enable.mockReset().mockResolvedValue(undefined);
    disable.mockReset().mockResolvedValue(undefined);
    isEnabled.mockReset().mockResolvedValue(false);
  });

  it("enables or disables the OS login item", async () => {
    await setAutostartEnabled(true);
    expect(enable).toHaveBeenCalledOnce();
    expect(disable).not.toHaveBeenCalled();
    await setAutostartEnabled(false);
    expect(disable).toHaveBeenCalledOnce();
  });

  it("reads the OS login-item state", async () => {
    isEnabled.mockResolvedValue(true);
    expect(await isAutostartEnabled()).toBe(true);
  });
});
