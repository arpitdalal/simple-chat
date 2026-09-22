export type ProviderId = "openai" | "anthropic" | "google";

export type ModelDef = {
  id: string;
  label: string;
  provider: ProviderId;
  vision: boolean;
  webSearch: boolean;
};

/** Curated catalog. Free-text customs stored separately; same id → catalog metadata wins. */
export const CATALOG: ModelDef[] = [
  // OpenAI
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    provider: "openai",
    vision: true,
    webSearch: true,
  },
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    vision: true,
    webSearch: true,
  },
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai",
    vision: true,
    webSearch: true,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    vision: true,
    webSearch: true,
  },
  {
    id: "gpt-4o",
    label: "GPT-4o",
    provider: "openai",
    vision: true,
    webSearch: true,
  },
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
    provider: "openai",
    vision: true,
    webSearch: true,
  },
  // Anthropic
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    provider: "anthropic",
    vision: true,
    webSearch: true,
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    provider: "anthropic",
    vision: true,
    webSearch: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    vision: true,
    webSearch: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    vision: true,
    webSearch: true,
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    provider: "anthropic",
    vision: true,
    webSearch: true,
  },
  // Google
  {
    id: "gemini-3.8-flash",
    label: "Gemini 3.8 Flash",
    provider: "google",
    vision: true,
    webSearch: true,
  },
  {
    id: "gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    provider: "google",
    vision: true,
    webSearch: true,
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    provider: "google",
    vision: true,
    webSearch: true,
  },
  {
    id: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    provider: "google",
    vision: true,
    webSearch: true,
  },
  {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    provider: "google",
    vision: true,
    webSearch: true,
  },
  {
    id: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite",
    provider: "google",
    vision: true,
    webSearch: true,
  },
];

export function modelsForProvider(provider: string): ModelDef[] {
  return CATALOG.filter((m) => m.provider === provider);
}

/**
 * Pick a chat default from providers that have usable keys.
 * Keeps `current` when its provider is ready; else first catalog model of first ready provider.
 */
export function pickDefaultModel(
  ready: ProviderId[],
  current?: { provider: string; modelId: string },
): { provider: ProviderId; modelId: string } | null {
  if (ready.length === 0) return null;
  if (current && ready.includes(current.provider as ProviderId)) {
    return {
      provider: current.provider as ProviderId,
      modelId: current.modelId,
    };
  }
  for (const provider of ready) {
    const first = modelsForProvider(provider)[0];
    if (first) return { provider, modelId: first.id };
  }
  return null;
}

export function resolveModel(
  provider: string,
  modelId: string,
  customs: ModelDef[] = [],
): ModelDef {
  const fromCatalog = CATALOG.find(
    (m) => m.id === modelId && m.provider === provider,
  );
  if (fromCatalog) return fromCatalog;
  const fromCustom = customs.find(
    (m) => m.id === modelId && m.provider === provider,
  );
  if (fromCustom) return fromCustom;
  return {
    id: modelId,
    label: modelId,
    provider: provider as ProviderId,
    vision: true,
    webSearch: false,
  };
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

export const PROVIDERS: ProviderId[] = ["openai", "anthropic", "google"];
