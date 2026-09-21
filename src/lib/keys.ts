import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "./models";

/** Extract a string from a Tauri/invoke rejection (Error, string, or other). */
export function keyErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  return String(err);
}

/** Serialize keychain mutations per provider so blur-save cannot race past Clear. */
const keyOpTail = new Map<string, Promise<unknown>>();

function runKeyOp<T>(provider: string, op: () => Promise<T>): Promise<T> {
  const prev = keyOpTail.get(provider) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  keyOpTail.set(provider, next);
  return next as Promise<T>;
}

export function setApiKey(provider: ProviderId, key: string) {
  return runKeyOp(provider, () =>
    invoke<void>("set_api_key", { provider, key }),
  );
}

export function clearApiKey(provider: ProviderId) {
  return setApiKey(provider, "");
}

export function getApiKey(provider: ProviderId) {
  return invoke<string | null>("get_api_key", { provider });
}

export function hasApiKey(provider: ProviderId) {
  return invoke<boolean>("has_api_key", { provider });
}
