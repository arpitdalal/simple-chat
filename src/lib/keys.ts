import { invoke } from "@tauri-apps/api/core";
import { PROVIDERS, type ProviderId } from "./models";

/** Extract a string from a Tauri/invoke rejection (Error, string, or other). */
export function keyErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  return String(err);
}

/** Serialize keychain reads/writes so probes cannot race mid-flight mutations. */
let keyOpTail: Promise<unknown> = Promise.resolve();

function runKeyOp<T>(op: () => Promise<T>): Promise<T> {
  const next = keyOpTail.catch(() => undefined).then(op);
  keyOpTail = next;
  return next as Promise<T>;
}

export function setApiKey(provider: ProviderId, key: string) {
  return runKeyOp(() => invoke<void>("set_api_key", { provider, key }));
}

export function clearApiKey(provider: ProviderId) {
  return setApiKey(provider, "");
}

export function getApiKey(provider: ProviderId) {
  return invoke<string | null>("get_api_key", { provider });
}

export function hasApiKey(provider: ProviderId) {
  return runKeyOp(() => invoke<boolean>("has_api_key", { provider }));
}

/** Providers with a readable key.
 * `ok:false` when every probe threw (store locked) — callers should keep unknown state.
 * Uses direct invoke inside one queue slot (do not call hasApiKey here — nested deadlock). */
export async function listReadyProviders(): Promise<{
  ready: ProviderId[];
  ok: boolean;
  error?: string;
}> {
  return runKeyOp(async () => {
    const ready: ProviderId[] = [];
    let ok = false;
    let error: string | undefined;
    for (const p of PROVIDERS) {
      try {
        const has = await invoke<boolean>("has_api_key", { provider: p });
        ok = true;
        if (has) ready.push(p);
      } catch (err) {
        error = keyErrorMessage(err);
      }
    }
    return ok ? { ready, ok, ...(error ? { error } : {}) } : { ready, ok, error };
  });
}
