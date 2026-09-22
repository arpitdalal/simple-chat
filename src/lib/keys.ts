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
 * `ok:false` when any probe threw (store locked / provider-specific failure) —
 * callers must treat the list as unknown and skip destructive default/chat alignment.
 * Uses direct invoke inside one queue slot (do not call hasApiKey here — nested deadlock). */
export async function listReadyProviders(): Promise<{
  ready: ProviderId[];
  ok: boolean;
  error?: string;
}> {
  return runKeyOp(async () => {
    const ready: ProviderId[] = [];
    // ok only when every provider probed successfully — a partial failure
    // must not look like "these others have no key".
    let ok = true;
    let error: string | undefined;
    for (const p of PROVIDERS) {
      try {
        const has = await invoke<boolean>("has_api_key", { provider: p });
        if (has) ready.push(p);
      } catch (err) {
        ok = false;
        error = keyErrorMessage(err);
      }
    }
    if (!ok) return { ready: [], ok, error: error ?? "key probe failed" };
    return { ready, ok };
  });
}
