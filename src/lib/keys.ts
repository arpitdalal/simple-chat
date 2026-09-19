import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "./models";

export function setApiKey(provider: ProviderId, key: string) {
  return invoke<void>("set_api_key", { provider, key });
}

export function getApiKey(provider: ProviderId) {
  return invoke<string | null>("get_api_key", { provider });
}

export function hasApiKey(provider: ProviderId) {
  return invoke<boolean>("has_api_key", { provider });
}
