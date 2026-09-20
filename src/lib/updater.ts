import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type AvailableUpdate = {
  version: string;
  body?: string;
  install: () => Promise<void>;
};

/**
 * Poll the configured updater endpoint. Returns null when up to date,
 * offline, or the endpoint is not serving updates yet (e.g. no release).
 */
export async function checkForAppUpdate(): Promise<AvailableUpdate | null> {
  let update;
  try {
    update = await check();
  } catch {
    return null;
  }
  if (!update) return null;
  return {
    version: update.version,
    body: update.body,
    install: async () => {
      await update.downloadAndInstall();
      await relaunch();
    },
  };
}
