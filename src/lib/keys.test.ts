import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import { clearApiKey, getApiKey, hasApiKey, keyErrorMessage, setApiKey } from "./keys";

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

  it("keyErrorMessage reads Error, string, and other", () => {
    expect(keyErrorMessage(new Error("store locked"))).toBe("store locked");
    expect(keyErrorMessage("plain")).toBe("plain");
    expect(keyErrorMessage(42)).toBe("42");
  });

  it("serializes setApiKey then clearApiKey for the same provider", async () => {
    const order: string[] = [];
    invoke.mockImplementation(async (_cmd: string, args: { key: string }) => {
      order.push(`start:${args.key || "clear"}`);
      await new Promise((r) => setTimeout(r, args.key ? 30 : 5));
      order.push(`end:${args.key || "clear"}`);
    });
    const save = setApiKey("openai", "sk-new");
    const clear = clearApiKey("openai");
    await Promise.all([save, clear]);
    expect(order).toEqual([
      "start:sk-new",
      "end:sk-new",
      "start:clear",
      "end:clear",
    ]);
  });
});
