import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { streamText, type ModelMessage } from "ai";
import { getApiKey } from "./keys";
import type { ProviderId } from "./models";

function withWebSearch(
  provider: ProviderId,
  modelId: string,
  enabled: boolean,
): { modelId: string; providerOptions?: Record<string, unknown> } {
  if (!enabled) return { modelId };
  // Provider-native search — wire exact tool shapes as APIs stabilize.
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

  const model =
    opts.provider === "openai"
      ? createOpenAI({ apiKey: key })(modelId)
      : opts.provider === "anthropic"
        ? createAnthropic({ apiKey: key })(modelId)
        : createGoogleGenerativeAI({ apiKey: key })(modelId);

  const result = streamText({
    model,
    messages: opts.messages,
    abortSignal: opts.abortSignal,
    providerOptions: providerOptions as never,
  });

  for await (const delta of result.textStream) {
    opts.onToken(delta);
  }

  return result;
}
