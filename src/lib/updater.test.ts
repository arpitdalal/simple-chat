import { beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.hoisted(() => vi.fn());
const relaunch = vi.hoisted(() => vi.fn());
const downloadAndInstall = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

import { checkForAppUpdate } from "./updater";

function fakeUpdate(version = "0.2.0") {
  return { version, downloadAndInstall, close };
}

describe("checkForAppUpdate", () => {
  beforeEach(() => {
    check.mockReset();
    relaunch.mockReset();
    downloadAndInstall.mockReset();
    close.mockReset();
  });

  it("returns error when check throws (not up-to-date)", async () => {
    check.mockRejectedValue(new Error("network"));
    await expect(checkForAppUpdate()).resolves.toEqual({
      status: "error",
      message: "network",
    });
  });

  it("returns none when no update", async () => {
    check.mockResolvedValue(null);
    await expect(checkForAppUpdate()).resolves.toEqual({ status: "none" });
  });

  it("install downloads then relaunches; dismiss closes resource", async () => {
    check.mockResolvedValue(fakeUpdate());
    const result = await checkForAppUpdate();
    expect(result.status).toBe("available");
    if (result.status !== "available") return;

    expect(result.update.version).toBe("0.2.0");
    result.update.dismiss();
    expect(close).toHaveBeenCalledOnce();

    await result.update.install();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("does not relaunch when downloadAndInstall rejects", async () => {
    downloadAndInstall.mockRejectedValue(new Error("dl failed"));
    check.mockResolvedValue(fakeUpdate());
    const result = await checkForAppUpdate();
    if (result.status !== "available") throw new Error("expected available");

    await expect(result.update.install()).rejects.toThrow("dl failed");
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("surfaces restart failure after successful install", async () => {
    downloadAndInstall.mockResolvedValue(undefined);
    relaunch.mockRejectedValue(new Error("nope"));
    check.mockResolvedValue(fakeUpdate());
    const result = await checkForAppUpdate();
    if (result.status !== "available") throw new Error("expected available");

    await expect(result.update.install()).rejects.toThrow(
      /Update installed but restart failed/,
    );
  });
});
