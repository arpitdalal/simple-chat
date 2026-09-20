import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export type AvailableUpdate = {
  version: string;
  install: () => Promise<void>;
  /** Drop the native Update resource when the user dismisses or install fails. */
  dismiss: () => void;
};

export type CheckResult =
  | { status: "none" }
  | { status: "available"; update: AvailableUpdate }
  | { status: "error"; message: string };

/** Serialize install so banner + Settings cannot overlap download/relaunch. */
let installInFlight: Promise<void> | null = null;

function wrapUpdate(update: Update): AvailableUpdate {
  return {
    version: update.version,
    dismiss: () => {
      void update.close();
    },
    install: () => {
      if (installInFlight) return installInFlight;
      installInFlight = (async () => {
        try {
          await update.downloadAndInstall(undefined, {
            timeout: DOWNLOAD_TIMEOUT_MS,
          });
        } catch (e) {
          throw e instanceof Error ? e : new Error(String(e));
        }
        try {
          await relaunch();
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e);
          throw new Error(
            `Update installed but restart failed — quit and reopen.${detail ? ` ${detail}` : ""}`,
          );
        }
      })().finally(() => {
        installInFlight = null;
      });
      return installInFlight;
    },
  };
}

/**
 * Poll the configured updater endpoint.
 * Distinguishes up-to-date (`none`) from check failures (`error`).
 */
export async function checkForAppUpdate(): Promise<CheckResult> {
  let update: Update | null;
  try {
    update = await check({ timeout: CHECK_TIMEOUT_MS });
  } catch (e) {
    return {
      status: "error",
      message: e instanceof Error ? e.message : "Update check failed",
    };
  }
  if (!update) return { status: "none" };
  return { status: "available", update: wrapUpdate(update) };
}
