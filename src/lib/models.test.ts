import { describe, expect, it } from "vitest";
import {
  CATALOG,
  modelsForProvider,
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
});
