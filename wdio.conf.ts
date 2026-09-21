import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@wdio/types";

const root = path.dirname(fileURLToPath(import.meta.url));
const appBinary = path.join(
  root,
  "src-tauri",
  "target",
  "release",
  process.platform === "win32" ? "simple-chat.exe" : "simple-chat",
);

export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./e2e/ipc.spec.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": {
        application: appBinary,
      },
    },
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: appBinary,
        // Embedded avoids Linux WebKitWebDriver Origin/IPC breakage (external tauri-driver).
        driverProvider: "embedded",
      },
    ],
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120_000,
  },
};
