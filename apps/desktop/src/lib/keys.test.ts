import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...a),
}));

import {
  clearApiKey,
  getApiKey,
  hasApiKey,
  isKeyOpBusy,
  keyErrorMessage,
  listReadyProviders,
  setApiKey,
  subscribeKeyBusy,
} from "./keys";
import { PROVIDERS } from "./models";

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

  it("serializes mutations across providers", async () => {
    const order: string[] = [];
    invoke.mockImplementation(
      async (_cmd: string, args: { provider: string; key: string }) => {
        order.push(`start:${args.provider}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end:${args.provider}`);
      },
    );
    const a = setApiKey("openai", "sk-a");
    const b = setApiKey("google", "sk-b");
    await Promise.all([a, b]);
    expect(order).toEqual([
      "start:openai",
      "end:openai",
      "start:google",
      "end:google",
    ]);
  });

  it("busy stays true until every overlapping mutation settles", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const gateB = new Promise<void>((r) => {
      releaseB = r;
    });
    let call = 0;
    invoke.mockImplementation(async () => {
      call += 1;
      if (call === 1) await gateA;
      else await gateB;
    });

    const events: boolean[] = [];
    const unsub = subscribeKeyBusy(() => events.push(isKeyOpBusy()));

    const a = setApiKey("openai", "sk-a");
    const b = setApiKey("anthropic", "sk-b");
    expect(isKeyOpBusy()).toBe(true);

    releaseA();
    await a;
    // B still queued/running — boolean end on A must not clear busy.
    expect(isKeyOpBusy()).toBe(true);

    releaseB();
    await b;
    expect(isKeyOpBusy()).toBe(false);
    unsub();
    expect(events.at(-1)).toBe(false);
  });

  it("listReadyProviders reports ready providers", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { provider: string }) =>
      args.provider === "google",
    );
    expect(await listReadyProviders()).toEqual({
      ready: ["google"],
      ok: true,
    });
  });

  it("listReadyProviders treats any probe failure as unknown", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { provider: string }) => {
      if (args.provider === "anthropic") throw new Error("locked");
      return false;
    });
    expect(await listReadyProviders()).toEqual({
      ready: [],
      ok: false,
      failed: ["anthropic"],
      error: "locked",
    });
  });

  it("listReadyProviders keeps partial ready when one probe fails", async () => {
    invoke.mockImplementation(async (_cmd: string, args: { provider: string }) => {
      if (args.provider === "anthropic") throw new Error("locked");
      return args.provider === "openai";
    });
    expect(await listReadyProviders()).toEqual({
      ready: ["openai"],
      ok: false,
      failed: ["anthropic"],
      error: "locked",
    });
  });

  it("listReadyProviders ok:false when every probe throws", async () => {
    invoke.mockRejectedValue(new Error("no store"));
    const result = await listReadyProviders();
    expect(result.ok).toBe(false);
    expect(result.ready).toEqual([]);
    expect(result.error).toBe("no store");
  });

  it("listReadyProviders waits for an in-flight setApiKey", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let writes = 0;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "set_api_key") {
        writes += 1;
        await gate;
        return;
      }
      return writes > 0;
    });
    const write = setApiKey("openai", "sk-x");
    const list = listReadyProviders();
    release();
    await write;
    const result = await list;
    expect(result.ok).toBe(true);
    expect(result.ready).toContain("openai");
  });

  it("probes every provider in order", async () => {
    invoke.mockResolvedValue(true);
    await listReadyProviders();
    expect(invoke).toHaveBeenCalledTimes(PROVIDERS.length);
    expect(invoke.mock.calls.map((c) => c[1].provider)).toEqual(PROVIDERS);
  });
});
