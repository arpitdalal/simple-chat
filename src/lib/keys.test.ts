import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { clearApiKey, getApiKey, hasApiKey, setApiKey } from "./keys";

describe("keys client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue(undefined);
  });

  it("setApiKey invokes tauri command", async () => {
    await setApiKey("openai", " sk-x ");
    expect(invoke).toHaveBeenCalledWith("set_api_key", {
      provider: "openai",
      key: " sk-x ",
    });
  });

  it("clearApiKey clears via empty set", async () => {
    await clearApiKey("anthropic");
    expect(invoke).toHaveBeenCalledWith("set_api_key", {
      provider: "anthropic",
      key: "",
    });
  });

  it("getApiKey and hasApiKey proxy invoke", async () => {
    invoke.mockResolvedValueOnce("secret");
    expect(await getApiKey("google")).toBe("secret");
    invoke.mockResolvedValueOnce(true);
    expect(await hasApiKey("google")).toBe(true);
  });
});
