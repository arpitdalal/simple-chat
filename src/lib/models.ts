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
  {
    id: "gpt-4o-mini",
    label: "GPT-4o mini",
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
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
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
    id: "gemini-2.0-flash",
    label: "Gemini 2.0 Flash",
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
];

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
