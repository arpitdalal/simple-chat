import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunchVisible } from "./relaunch";

const CHECK_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Thrown (message) when bits are applied but process restart failed. */
export const RESTART_REQUIRED_PREFIX =
  "Update installed but restart failed — quit and reopen.";

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

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === "string" && e) return e;
  const s = String(e);
  return s && s !== "undefined" && s !== "null" ? s : fallback;
}

export function isRestartRequiredError(e: unknown): boolean {
  return errMessage(e, "").startsWith(RESTART_REQUIRED_PREFIX);
}

function wrapUpdate(update: Update): AvailableUpdate {
  let closePromise: Promise<void> | null = null;
  const closeUpdate = () => {
    closePromise ??= Promise.resolve(update.close()).catch(() => {});
    return closePromise;
  };

  return {
    version: update.version,
    dismiss: () => {
      void closeUpdate();
    },
    install: () => {
      if (installInFlight) return installInFlight;
      installInFlight = (async () => {
        try {
          await update.downloadAndInstall(undefined, {
            timeout: DOWNLOAD_TIMEOUT_MS,
          });
        } catch (e) {
          await closeUpdate();
          throw new Error(errMessage(e, "Download failed"));
        }
        try {
          await relaunchVisible();
        } catch (e) {
          await closeUpdate();
          const detail = errMessage(e, "");
          throw new Error(
            `${RESTART_REQUIRED_PREFIX}${detail ? ` ${detail}` : ""}`,
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
      message: errMessage(e, "Update check failed"),
    };
  }
  if (!update) return { status: "none" };
  return { status: "available", update: wrapUpdate(update) };
}
