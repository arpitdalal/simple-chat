import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

const { FakeAPICallError } = vi.hoisted(() => {
  class FakeAPICallError extends Error {
    isRetryable: boolean;
    responseHeaders?: Record<string, string>;
    constructor(
      message: string,
      isRetryable: boolean,
      responseHeaders?: Record<string, string>,
    ) {
      super(message);
      this.isRetryable = isRetryable;
      this.responseHeaders = responseHeaders;
    }
    static isInstance(err: unknown): err is FakeAPICallError {
      return err instanceof FakeAPICallError;
    }
  }
  return { FakeAPICallError };
});

vi.mock("./keys", () => ({
  getApiKey: (...a: unknown[]) => getApiKey(...a),
}));

vi.mock("ai", () => ({
  streamText: (...a: unknown[]) => streamText(...a),
  generateText: vi.fn(),
  stepCountIs: (...a: unknown[]) => stepCountIs(...a),
  APICallError: FakeAPICallError,
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

import {
  streamChat,
  withWebSearch,
  isRetryableStreamError,
  retryDelayMs,
  STREAM_BACKOFF_MS,
} from "./chat";

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

describe("isRetryableStreamError", () => {
  it("rejects aborts and non-retryable API errors", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryableStreamError(abort)).toBe(false);
    expect(isRetryableStreamError(new FakeAPICallError("bad key", false))).toBe(
      false,
    );
  });

  it("accepts retryable API / network errors", () => {
    expect(isRetryableStreamError(new FakeAPICallError("rate limited", true))).toBe(
      true,
    );
    expect(isRetryableStreamError(new Error("Failed to fetch"))).toBe(true);
    expect(isRetryableStreamError(new Error("timeout"))).toBe(true);
    expect(isRetryableStreamError(new Error("Load failed"))).toBe(true);
  });
});

describe("retryDelayMs", () => {
  it("uses Retry-After seconds when present", () => {
    const err = new FakeAPICallError("429", true, { "retry-after": "5" });
    expect(retryDelayMs(err, 1)).toBe(5000);
  });

  it("honors Retry-After of one minute", () => {
    const err = new FakeAPICallError("429", true, { "retry-after": "60" });
    expect(retryDelayMs(err, 1)).toBe(60_000);
  });

  it("declines retry when Retry-After exceeds 2m ceiling", () => {
    const err = new FakeAPICallError("429", true, { "retry-after": "180" });
    expect(retryDelayMs(err, 1)).toBe(-1);
  });

  it("falls back to exponential backoff", () => {
    expect(retryDelayMs(new Error("network"), 1)).toBe(STREAM_BACKOFF_MS);
    expect(retryDelayMs(new Error("network"), 2)).toBe(STREAM_BACKOFF_MS * 2);
  });
});

describe("streamChat", () => {
  beforeEach(() => {
    getApiKey.mockReset();
    streamText.mockReset();
    stepCountIs.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
        maxRetries: 0,
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

  it("retries retryable failures with exponential backoff then succeeds", async () => {
    getApiKey.mockResolvedValue("sk");
    streamText
      .mockReturnValueOnce({
        textStream: (async function* () {
          throw new Error("Failed to fetch");
        })(),
      })
      .mockReturnValueOnce({
        textStream: (async function* () {
          yield "ok";
        })(),
      });
    const onRetry = vi.fn();
    const onToken = vi.fn();
    const done = streamChat({
      provider: "openai",
      modelId: "gpt-4o",
      messages: [],
      webSearch: false,
      onToken,
      onRetry,
    });
    await vi.advanceTimersByTimeAsync(STREAM_BACKOFF_MS);
    await done;
    expect(onRetry).toHaveBeenCalledWith(1);
    expect(onToken).toHaveBeenCalledWith("ok");
    expect(streamText).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable errors", async () => {
    getApiKey.mockResolvedValue("sk");
    streamText.mockReturnValue({
      textStream: (async function* () {
        throw new Error("No API key for google");
      })(),
    });
    await expect(
      streamChat({
        provider: "google",
        modelId: "gemini-3.8-flash",
        messages: [],
        webSearch: false,
        onToken: vi.fn(),
      }),
    ).rejects.toThrow(/No API key/);
    expect(streamText).toHaveBeenCalledTimes(1);
  });

  it("does not retry mid-stream without onRetry (would duplicate tokens)", async () => {
    getApiKey.mockResolvedValue("sk");
    streamText.mockReturnValue({
      textStream: (async function* () {
        yield "partial";
        throw new Error("Failed to fetch");
      })(),
    });
    const onToken = vi.fn();
    await expect(
      streamChat({
        provider: "openai",
        modelId: "gpt-4o",
        messages: [],
        webSearch: false,
        onToken,
      }),
    ).rejects.toThrow(/Failed to fetch/);
    expect(onToken).toHaveBeenCalledWith("partial");
    expect(streamText).toHaveBeenCalledTimes(1);
  });
});
