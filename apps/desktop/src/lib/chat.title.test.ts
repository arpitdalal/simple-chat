import { describe, expect, it, vi, beforeEach } from "vitest";

const getApiKey = vi.fn();
const generateText = vi.fn();

vi.mock("./keys", () => ({
  getApiKey: (...a: unknown[]) => getApiKey(...a),
}));

vi.mock("ai", () => ({
  generateText: (...a: unknown[]) => generateText(...a),
  streamText: vi.fn(),
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => () => ({}),
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: () => () => ({}),
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: () => () => ({}),
}));

import { generateChatTitle, TITLE_MODELS } from "./chat";

describe("generateChatTitle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("falls back to truncated message when no key", async () => {
    getApiKey.mockResolvedValue(null);
    const long = "a".repeat(60);
    expect(await generateChatTitle("google", long)).toBe(`${"a".repeat(48)}…`);
  });

  it("falls back when keychain getApiKey rejects", async () => {
    getApiKey.mockRejectedValue(new Error("Could not access the OS credential store"));
    expect(await generateChatTitle("openai", "hello world")).toBe("hello world");
  });

  it("uses model title when generateText succeeds", async () => {
    getApiKey.mockResolvedValue("k");
    generateText.mockResolvedValue({ text: '  "Domain Tips"  ' });
    expect(await generateChatTitle("google", "tell me about .at")).toBe(
      "Domain Tips",
    );
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("tell me about .at"),
      }),
    );
  });

  it("falls back when generateText throws", async () => {
    getApiKey.mockResolvedValue("k");
    generateText.mockRejectedValue(new Error("rate limit"));
    expect(await generateChatTitle("openai", "hello world")).toBe("hello world");
  });

  it("maps each provider to a cheap title model", () => {
    expect(TITLE_MODELS.openai).toBeTruthy();
    expect(TITLE_MODELS.anthropic).toBeTruthy();
    expect(TITLE_MODELS.google).toBeTruthy();
  });
});
