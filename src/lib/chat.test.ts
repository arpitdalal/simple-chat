import { describe, expect, it, vi, beforeEach } from "vitest";

const getApiKey = vi.fn();
const streamText = vi.fn();

vi.mock("./keys", () => ({
  getApiKey: (...a: unknown[]) => getApiKey(...a),
}));

vi.mock("ai", () => ({
  streamText: (...a: unknown[]) => streamText(...a),
  generateText: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => () => "openai-model",
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => "anthropic-model",
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => "google-model",
}));

import { streamChat, withWebSearch } from "./chat";

describe("withWebSearch", () => {
  it("returns bare model when disabled", () => {
    expect(withWebSearch("openai", "gpt-4o", false)).toEqual({
      modelId: "gpt-4o",
    });
  });

  it("wires provider-native search when enabled", () => {
    expect(withWebSearch("openai", "gpt-4o", true).providerOptions).toEqual({
      openai: { tools: [{ type: "web_search" }] },
    });
    expect(withWebSearch("google", "gemini-3.8-flash", true).providerOptions).toEqual({
      google: { useSearchGrounding: true },
    });
    expect(
      withWebSearch("anthropic", "claude-haiku-4-5", true).providerOptions,
    ).toMatchObject({
      anthropic: {
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      },
    });
  });
});

describe("streamChat", () => {
  beforeEach(() => {
    getApiKey.mockReset();
    streamText.mockReset();
  });

  it("throws when API key missing", async () => {
    getApiKey.mockResolvedValue(null);
    await expect(
      streamChat({
        provider: "google",
        modelId: "gemini-3.8-flash",
        messages: [],
        webSearch: true,
        onToken: vi.fn(),
      }),
    ).rejects.toThrow(/No API key/);
  });

  it("streams tokens when key present", async () => {
    getApiKey.mockResolvedValue("sk");
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield "A";
        yield "B";
      })(),
    });
    const onToken = vi.fn();
    await streamChat({
      provider: "google",
      modelId: "gemini-3.8-flash",
      messages: [{ role: "user", content: "hi" }],
      webSearch: true,
      onToken,
    });
    expect(onToken).toHaveBeenCalledWith("A");
    expect(onToken).toHaveBeenCalledWith("B");
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: expect.objectContaining({
          google: { useSearchGrounding: true },
        }),
      }),
    );
  });
});
