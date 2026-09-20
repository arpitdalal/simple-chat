import type { ProviderId } from "../lib/models";

export const TITLE_MODELS: Record<ProviderId, string> = {
  openai: "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5",
  google: "gemini-3.8-flash",
};

export function withWebSearch(
  _provider: ProviderId,
  modelId: string,
  _enabled: boolean,
) {
  return { modelId };
}

export async function streamChat(opts: {
  onToken: (text: string) => void;
  abortSignal?: AbortSignal;
}) {
  if (opts.abortSignal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
  opts.onToken("Hello ");
  opts.onToken("**world**");
}

export async function generateChatTitle(
  _provider: ProviderId,
  userMessage: string,
): Promise<string> {
  return userMessage.slice(0, 48) || "Chat";
}
