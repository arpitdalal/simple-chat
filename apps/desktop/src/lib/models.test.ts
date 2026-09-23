import { describe, expect, it } from "vitest";
import {
  CATALOG,
  modelsForProvider,
  pickDefaultModel,
  resolveModel,
  PROVIDERS,
} from "./models";

describe("models catalog", () => {
  it("lists every provider id in PROVIDERS", () => {
    for (const p of PROVIDERS) {
      expect(modelsForProvider(p).length).toBeGreaterThan(0);
      expect(modelsForProvider(p).every((m) => m.provider === p)).toBe(true);
    }
  });

  it("resolveModel prefers catalog entry", () => {
    const m = resolveModel("google", "gemini-3.8-flash");
    expect(m.label).toBe("Gemini 3.8 Flash");
    expect(m.webSearch).toBe(true);
  });

  it("resolveModel uses customs then falls back to bare id", () => {
    const custom = {
      id: "my-model",
      label: "Mine",
      provider: "openai" as const,
      vision: false,
      webSearch: false,
    };
    expect(resolveModel("openai", "my-model", [custom]).label).toBe("Mine");
    expect(resolveModel("openai", "totally-unknown").label).toBe(
      "totally-unknown",
    );
  });

  it("catalog ids are unique per provider", () => {
    const keys = CATALOG.map((m) => `${m.provider}:${m.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("pickDefaultModel returns null with no ready providers", () => {
    expect(
      pickDefaultModel([], { provider: "openai", modelId: "gpt-5.6-luna" }),
    ).toBeNull();
  });

  it("pickDefaultModel keeps current when its provider is ready", () => {
    expect(
      pickDefaultModel(["openai", "google"], {
        provider: "openai",
        modelId: "gpt-4o",
      }),
    ).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("pickDefaultModel shifts to first ready provider when current is not", () => {
    expect(
      pickDefaultModel(["google"], {
        provider: "openai",
        modelId: "gpt-5.6-luna",
      }),
    ).toEqual({
      provider: "google",
      modelId: modelsForProvider("google")[0]!.id,
    });
  });
});
