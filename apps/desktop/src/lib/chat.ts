import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import {
  APICallError,
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { getApiKey } from "./keys";
import type { ProviderId } from "./models";

/** ponytail: 3× / 500ms base — covers 429 + brief Wi-Fi drops; bump if providers need longer. */
export const STREAM_MAX_ATTEMPTS = 3;
export const STREAM_BACKOFF_MS = 500;

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

/** Transient network / rate-limit failures worth another attempt. */
export function isRetryableStreamError(err: unknown): boolean {
  if ((err as { name?: string } | null)?.name === "AbortError") return false;
  if (APICallError.isInstance(err)) return err.isRetryable;
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  // "Load failed" = WebKit/Tauri fetch drop; "failed to fetch" = Chromium
  return /(?:^|\b)(429|timeout|timed out|network|fetch failed|failed to fetch|load failed|econnreset|enotfound|socket|offline)\b/.test(
    msg,
  );
}

/** Prefer Retry-After headers; fall back to exponential backoff.
 *  ponytail: cap at 2m — longer waits should fail fast rather than hang the UI. */
const MAX_RETRY_AFTER_MS = 120_000;

export function retryDelayMs(err: unknown, attempt: number): number {
  const fallback = STREAM_BACKOFF_MS * 2 ** (attempt - 1);
  if (!APICallError.isInstance(err)) return fallback;
  const headers = err.responseHeaders;
  if (!headers) return fallback;

  let ms: number | undefined;
  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs != null) {
    const parsed = parseFloat(retryAfterMs);
    if (!Number.isNaN(parsed) && parsed >= 0) ms = parsed;
  }
  const retryAfter = headers["retry-after"];
  if (retryAfter != null && ms === undefined) {
    const seconds = parseFloat(retryAfter);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      ms = seconds * 1000;
    } else {
      const until = Date.parse(retryAfter) - Date.now();
      if (!Number.isNaN(until) && until >= 0) ms = until;
    }
  }
  if (ms === undefined) return fallback;
  if (ms > MAX_RETRY_AFTER_MS) return -1; // caller: do not retry
  return Math.max(ms, fallback);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function streamChat(opts: {
  provider: ProviderId;
  modelId: string;
  messages: ModelMessage[];
  webSearch: boolean;
  abortSignal?: AbortSignal;
  onToken: (text: string) => void;
  /** Called before a retry so callers can reset partial accumulators. */
  onRetry?: (attempt: number) => void;
}) {
  const key = await getApiKey(opts.provider);
  if (!key) throw new Error(`No API key for ${opts.provider}. Add one in Settings.`);

  const client = makeProvider(opts.provider, key);
  const tools = opts.webSearch ? webSearchTools(opts.provider, client) : undefined;

  let lastError: unknown;
  for (let attempt = 0; attempt < STREAM_MAX_ATTEMPTS; attempt++) {
    if (opts.abortSignal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (attempt > 0) {
      opts.onRetry?.(attempt);
      await sleep(retryDelayMs(lastError, attempt), opts.abortSignal);
    }
    let emitted = false;
    try {
      // maxRetries: 0 — we own the backoff loop so mid-stream failures can reset tokens
      const result = streamText({
        model: client(opts.modelId),
        messages: opts.messages,
        abortSignal: opts.abortSignal,
        maxRetries: 0,
        tools,
        // Allow search/fetch tool round-trips before the final answer
        ...(tools ? { stopWhen: stepCountIs(5) } : {}),
      });

      for await (const delta of result.textStream) {
        emitted = true;
        opts.onToken(delta);
      }

      return result;
    } catch (e) {
      lastError = e;
      const canReset = !emitted || opts.onRetry != null;
      const delay = retryDelayMs(e, attempt + 1);
      if (
        !isRetryableStreamError(e) ||
        !canReset ||
        delay < 0 ||
        attempt === STREAM_MAX_ATTEMPTS - 1
      ) {
        throw e;
      }
    }
  }
  throw lastError;
}

/** Short chat title via cheap model for the active provider. */
export async function generateChatTitle(
  provider: ProviderId,
  userMessage: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const key = await getApiKey(provider).catch(() => null);
  if (!key) {
    return userMessage.slice(0, 48) + (userMessage.length > 48 ? "…" : "");
  }
  try {
    const client = makeProvider(provider, key);
    const { text } = await generateText({
      model: client(TITLE_MODELS[provider]),
      prompt: `Write a short chat title (3–6 words, no quotes, no punctuation at end) for this user message:\n\n${userMessage.slice(0, 500)}`,
      abortSignal,
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
