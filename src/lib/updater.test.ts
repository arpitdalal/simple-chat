import { beforeEach, describe, expect, it, vi } from "vitest";

const check = vi.hoisted(() => vi.fn());
const relaunch = vi.hoisted(() => vi.fn());
const downloadAndInstall = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch }));

import { checkForAppUpdate } from "./updater";

describe("checkForAppUpdate", () => {
  beforeEach(() => {
    check.mockReset();
    relaunch.mockReset();
    downloadAndInstall.mockReset();
  });

  it("returns null when check throws (offline / no endpoint)", async () => {
    check.mockRejectedValue(new Error("network"));
    expect(await checkForAppUpdate()).toBeNull();
  });

  it("returns null when no update", async () => {
    check.mockResolvedValue(null);
    expect(await checkForAppUpdate()).toBeNull();
  });

  it("returns install that downloads then relaunches", async () => {
    check.mockResolvedValue({
      version: "0.2.0",
      body: "fixes",
      downloadAndInstall,
    });
    const available = await checkForAppUpdate();
    expect(available?.version).toBe("0.2.0");
    expect(available?.body).toBe("fixes");

    await available!.install();
    expect(downloadAndInstall).toHaveBeenCalledOnce();
    expect(relaunch).toHaveBeenCalledOnce();
  });
});
