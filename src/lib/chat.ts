import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, streamText, type ModelMessage } from "ai";
import { getApiKey } from "./keys";
import type { ProviderId } from "./models";

/** Cheap models for auto-titling threads. */
export const TITLE_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5",
  google: "gemini-3.8-flash",
};

function makeModel(provider: ProviderId, modelId: string, apiKey: string) {
  if (provider === "openai") return createOpenAI({ apiKey })(modelId);
  if (provider === "anthropic") return createAnthropic({ apiKey })(modelId);
  return createGoogleGenerativeAI({ apiKey })(modelId);
}

function withWebSearch(
  provider: ProviderId,
  modelId: string,
  enabled: boolean,
): { modelId: string; providerOptions?: Record<string, unknown> } {
  if (!enabled) return { modelId };
  if (provider === "openai") {
    return {
      modelId,
      providerOptions: {
        openai: { tools: [{ type: "web_search" }] },
      },
    };
  }
  if (provider === "google") {
    return {
      modelId,
      providerOptions: {
        google: { useSearchGrounding: true },
      },
    };
  }
  if (provider === "anthropic") {
    return {
      modelId,
      providerOptions: {
        anthropic: {
          tools: [{ type: "web_search_20250305", name: "web_search" }],
        },
      },
    };
  }
  return { modelId };
}

export async function streamChat(opts: {
  provider: ProviderId;
  modelId: string;
  messages: ModelMessage[];
  webSearch: boolean;
  abortSignal?: AbortSignal;
  onToken: (text: string) => void;
}) {
  const key = await getApiKey(opts.provider);
  if (!key) throw new Error(`No API key for ${opts.provider}. Add one in Settings.`);

  const { modelId, providerOptions } = withWebSearch(
    opts.provider,
    opts.modelId,
    opts.webSearch,
  );

  const result = streamText({
    model: makeModel(opts.provider, modelId, key),
    messages: opts.messages,
    abortSignal: opts.abortSignal,
    providerOptions: providerOptions as never,
  });

  for await (const delta of result.textStream) {
    opts.onToken(delta);
  }

  return result;
}

/** Short chat title via cheap model for the active provider. */
export async function generateChatTitle(
  provider: ProviderId,
  userMessage: string,
): Promise<string> {
  const key = await getApiKey(provider);
  if (!key) {
    return userMessage.slice(0, 48) + (userMessage.length > 48 ? "…" : "");
  }
  try {
    const { text } = await generateText({
      model: makeModel(provider, TITLE_MODELS[provider], key),
      prompt: `Write a short chat title (3–6 words, no quotes, no punctuation at end) for this user message:\n\n${userMessage.slice(0, 500)}`,
    });
    const cleaned = text
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 60);
    return cleaned || userMessage.slice(0, 48);
  } catch {
    return userMessage.slice(0, 48) + (userMessage.length > 48 ? "…" : "");
  }
}
