import { beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.hoisted(() => vi.fn());
const relaunchVisible = vi.hoisted(() => vi.fn());
const downloadAndInstall = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("./relaunch", () => ({ relaunchVisible }));

import {
  checkForAppUpdate,
  isRestartRequiredError,
  RESTART_REQUIRED_PREFIX,
} from "./updater";

function fakeUpdate(version = "0.2.0") {
  return { version, downloadAndInstall, close };
}

describe("checkForAppUpdate", () => {
  beforeEach(() => {
    check.mockReset();
    relaunchVisible.mockReset();
    downloadAndInstall.mockReset();
    close.mockReset();
  });

  it("returns error with string rejection details", async () => {
    check.mockRejectedValue("endpoint 404");
    await expect(checkForAppUpdate()).resolves.toEqual({
      status: "error",
      message: "endpoint 404",
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
    expect(relaunchVisible).toHaveBeenCalledOnce();
  });

  it("does not relaunch when downloadAndInstall rejects; closes Update", async () => {
    downloadAndInstall.mockRejectedValue(new Error("dl failed"));
    check.mockResolvedValue(fakeUpdate());
    const result = await checkForAppUpdate();
    if (result.status !== "available") throw new Error("expected available");

    await expect(result.update.install()).rejects.toThrow("dl failed");
    expect(relaunchVisible).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("surfaces restart failure after successful install; closes Update", async () => {
    downloadAndInstall.mockResolvedValue(undefined);
    relaunchVisible.mockRejectedValue(new Error("nope"));
    check.mockResolvedValue(fakeUpdate());
    const result = await checkForAppUpdate();
    if (result.status !== "available") throw new Error("expected available");

    let err: unknown;
    try {
      await result.update.install();
    } catch (e) {
      err = e;
    }
    expect(isRestartRequiredError(err)).toBe(true);
    expect(String(err)).toContain(RESTART_REQUIRED_PREFIX);
    expect(close).toHaveBeenCalledOnce();
  });
});
