import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { getApiKey } from "./keys";
import type { ProviderId } from "./models";

/** Cheap models for auto-titling threads. */
export const TITLE_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5",
  google: "gemini-3.8-flash",
};

type AnyProvider =
  | ReturnType<typeof createOpenAI>
  | ReturnType<typeof createAnthropic>
  | ReturnType<typeof createGoogleGenerativeAI>;

function makeProvider(provider: ProviderId, apiKey: string): AnyProvider {
  if (provider === "openai") return createOpenAI({ apiKey });
  if (provider === "anthropic") return createAnthropic({ apiKey });
  return createGoogleGenerativeAI({ apiKey });
}

/** Provider-defined search/fetch tools (AI SDK 5+). Models cannot browse without these. */
function webSearchTools(provider: ProviderId, client: AnyProvider): ToolSet {
  if (provider === "openai") {
    const openai = client as ReturnType<typeof createOpenAI>;
    return {
      web_search: openai.tools.webSearch({ externalWebAccess: true }),
    };
  }
  if (provider === "google") {
    const google = client as ReturnType<typeof createGoogleGenerativeAI>;
    return {
      google_search: google.tools.googleSearch({}),
      // Fetch URLs mentioned in the prompt (e.g. GitHub links)
      url_context: google.tools.urlContext({}),
    };
  }
  const anthropic = client as ReturnType<typeof createAnthropic>;
  return {
    web_search: anthropic.tools.webSearch_20260318({ maxUses: 5 }),
    web_fetch: anthropic.tools.webFetch_20260318({}),
  };
}

/** Exported for unit tests — which tools each provider gets when search is on. */
export function withWebSearch(provider: ProviderId, enabled: boolean) {
  if (!enabled) return { tools: undefined as ToolSet | undefined };
  // Use a dummy key — only the tool descriptors matter for tests / shape checks
  const client = makeProvider(provider, "test-key");
  return { tools: webSearchTools(provider, client) };
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

  const client = makeProvider(opts.provider, key);
  const tools = opts.webSearch ? webSearchTools(opts.provider, client) : undefined;

  const result = streamText({
    model: client(opts.modelId),
    messages: opts.messages,
    abortSignal: opts.abortSignal,
    tools,
    // Allow search/fetch tool round-trips before the final answer
    ...(tools ? { stopWhen: stepCountIs(5) } : {}),
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
    const client = makeProvider(provider, key);
    const { text } = await generateText({
      model: client(TITLE_MODELS[provider]),
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
