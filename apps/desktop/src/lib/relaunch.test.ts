import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { relaunchVisible } from "./relaunch";

describe("relaunchVisible", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined);
  });

  it("invokes relaunch_visible so Rust can mark the restart user-visible", async () => {
    await relaunchVisible();
    expect(invoke).toHaveBeenCalledWith("relaunch_visible");
  });
});
