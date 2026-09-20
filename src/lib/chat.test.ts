import { describe, expect, it, vi, beforeEach } from "vitest";

const getApiKey = vi.fn();
const streamText = vi.fn();
const stepCountIs = vi.fn((n: number) => ({ __stepCountIs: n }));

const openaiWebSearch = vi.fn((opts?: unknown) => ({
  type: "openai.web_search",
  opts,
}));
const googleSearch = vi.fn(() => ({ type: "google.google_search" }));
const urlContext = vi.fn(() => ({ type: "google.url_context" }));
const anthropicWebSearch = vi.fn((opts?: unknown) => ({
  type: "anthropic.web_search",
  opts,
}));
const anthropicWebFetch = vi.fn(() => ({ type: "anthropic.web_fetch" }));

vi.mock("./keys", () => ({
  getApiKey: (...a: unknown[]) => getApiKey(...a),
}));

vi.mock("ai", () => ({
  streamText: (...a: unknown[]) => streamText(...a),
  generateText: vi.fn(),
  stepCountIs: (...a: unknown[]) => stepCountIs(...a),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () =>
    Object.assign(() => "openai-model", {
      tools: { webSearch: (...a: unknown[]) => openaiWebSearch(...a) },
    }),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () =>
    Object.assign(() => "anthropic-model", {
      tools: {
        webSearch_20260318: (...a: unknown[]) => anthropicWebSearch(...a),
        webFetch_20260318: (...a: unknown[]) => anthropicWebFetch(...a),
      },
    }),
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () =>
    Object.assign(() => "google-model", {
      tools: {
        googleSearch: (...a: unknown[]) => googleSearch(...a),
        urlContext: (...a: unknown[]) => urlContext(...a),
      },
    }),
}));

import { streamChat, withWebSearch } from "./chat";

describe("withWebSearch", () => {
  it("returns no tools when disabled", () => {
    expect(withWebSearch("openai", false).tools).toBeUndefined();
    expect(withWebSearch("google", false).tools).toBeUndefined();
    expect(withWebSearch("anthropic", false).tools).toBeUndefined();
  });

  it("wires OpenAI webSearch tool", () => {
    const { tools } = withWebSearch("openai", true);
    expect(tools).toEqual({
      web_search: { type: "openai.web_search", opts: { externalWebAccess: true } },
    });
    expect(openaiWebSearch).toHaveBeenCalledWith({ externalWebAccess: true });
  });

  it("wires Google search + url context tools", () => {
    const { tools } = withWebSearch("google", true);
    expect(tools).toEqual({
      google_search: { type: "google.google_search" },
      url_context: { type: "google.url_context" },
    });
  });

  it("wires Anthropic web search + fetch tools", () => {
    const { tools } = withWebSearch("anthropic", true);
    expect(tools).toEqual({
      web_search: { type: "anthropic.web_search", opts: { maxUses: 5 } },
      web_fetch: { type: "anthropic.web_fetch" },
    });
  });
});

describe("streamChat", () => {
  beforeEach(() => {
    getApiKey.mockReset();
    streamText.mockReset();
    stepCountIs.mockClear();
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

  it("passes Google tools and multi-step stopWhen when search on", async () => {
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
        tools: {
          google_search: { type: "google.google_search" },
          url_context: { type: "google.url_context" },
        },
        stopWhen: { __stepCountIs: 5 },
      }),
    );
  });

  it("omits tools when webSearch off", async () => {
    getApiKey.mockResolvedValue("sk");
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield "ok";
      })(),
    });
    await streamChat({
      provider: "openai",
      modelId: "gpt-4o",
      messages: [],
      webSearch: false,
      onToken: vi.fn(),
    });
    expect(streamText).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
      }),
    );
    expect(streamText.mock.calls[0][0].stopWhen).toBeUndefined();
  });
});
