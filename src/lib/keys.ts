import { invoke } from "@tauri-apps/api/core";
import { PROVIDERS, type ProviderId } from "./models";
import { createQueue } from "./queue";

/** Extract a string from a Tauri/invoke rejection (Error, string, or other). */
export function keyErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "string") return err;
  return String(err);
}

/** Every keychain read/write goes through this queue — busy ⇔ pending > 0. */
const keyQueue = createQueue();

function runKeyOp<T>(op: () => Promise<T>): Promise<T> {
  return keyQueue.run(op);
}

/** True while any keychain op is queued or in flight (includes OS prompts). */
export function isKeyOpBusy(): boolean {
  return keyQueue.isBusy();
}

/** React can subscribe; Settings mutations need no start/end callbacks. */
export function subscribeKeyBusy(listener: () => void): () => void {
  return keyQueue.subscribe(listener);
}

export function setApiKey(provider: ProviderId, key: string) {
  return runKeyOp(() => invoke<void>("set_api_key", { provider, key }));
}

export function clearApiKey(provider: ProviderId) {
  return setApiKey(provider, "");
}

export function getApiKey(provider: ProviderId) {
  return runKeyOp(() => invoke<string | null>("get_api_key", { provider }));
}

export function hasApiKey(provider: ProviderId) {
  return runKeyOp(() => invoke<boolean>("has_api_key", { provider }));
}

/** Providers with a readable key.
 * `ok:false` when any probe threw (store locked / provider-specific failure).
 * `ready` still lists providers whose lookup succeeded and had a key; `failed`
 * lists providers whose lookup threw (unknown — never treat as "no key").
 * Callers doing destructive align should require `ok`; Settings defaults may
 * retarget when the *current* provider is not in `failed`.
 * Uses direct invoke inside one queue slot (do not call hasApiKey here — nested deadlock). */
export async function listReadyProviders(): Promise<{
  ready: ProviderId[];
  ok: boolean;
  failed?: ProviderId[];
  error?: string;
}> {
  return runKeyOp(async () => {
    const ready: ProviderId[] = [];
    const failed: ProviderId[] = [];
    let error: string | undefined;
    for (const p of PROVIDERS) {
      try {
        const has = await invoke<boolean>("has_api_key", { provider: p });
        if (has) ready.push(p);
      } catch (err) {
        failed.push(p);
        error = keyErrorMessage(err);
      }
    }
    if (failed.length > 0) {
      return { ready, ok: false, failed, error: error ?? "key probe failed" };
    }
    return { ready, ok: true };
  });
}
