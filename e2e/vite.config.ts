import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dir, "..");
const mockChat = path.resolve(projectRoot, "src/test/mock-chat.ts");

export default defineConfig({
  root: projectRoot,
  plugins: [
    react(),
    {
      name: "serve-e2e-index",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url === "/" || req.url === "/index.html") {
            req.url = "/e2e/index.html";
          }
          next();
        });
      },
    },
    {
      name: "e2e-mock-chat",
      enforce: "pre",
      resolveId(id) {
        // ChatView/App import ../lib/chat or ./lib/chat — redirect to offline stub
        const bare = id.split("?")[0];
        if (
          bare === "../lib/chat" ||
          bare === "./lib/chat" ||
          bare === "./chat" ||
          bare.endsWith("/lib/chat") ||
          bare.endsWith("/lib/chat.ts")
        ) {
          return mockChat;
        }
      },
    },
  ],
  resolve: {
    alias: [
      {
        find: "@tauri-apps/plugin-sql",
        replacement: path.resolve(projectRoot, "src/test/memory-sql.ts"),
      },
      {
        find: "@tauri-apps/api/window",
        replacement: path.resolve(projectRoot, "src/test/mock-window.ts"),
      },
      {
        find: "@tauri-apps/api/core",
        replacement: path.resolve(projectRoot, "src/test/mock-core.ts"),
      },
      {
        find: "@tauri-apps/api/event",
        replacement: path.resolve(projectRoot, "src/test/mock-event.ts"),
      },
      {
        find: "@tauri-apps/plugin-global-shortcut",
        replacement: path.resolve(projectRoot, "src/test/mock-shortcut.ts"),
      },
      {
        find: "@tauri-apps/plugin-clipboard-manager",
        replacement: path.resolve(projectRoot, "src/test/mock-clipboard.ts"),
      },
      {
        find: "@tauri-apps/plugin-opener",
        replacement: path.resolve(projectRoot, "src/test/mock-opener.ts"),
      },
      {
        find: "@tauri-apps/plugin-os",
        replacement: path.resolve(projectRoot, "src/test/mock-os.ts"),
      },
      {
        find: "@tauri-apps/plugin-updater",
        replacement: path.resolve(projectRoot, "src/test/mock-updater.ts"),
      },
      {
        find: "@tauri-apps/plugin-process",
        replacement: path.resolve(projectRoot, "src/test/mock-process.ts"),
      },
      {
        find: "@tauri-apps/plugin-autostart",
        replacement: path.resolve(projectRoot, "src/test/mock-autostart.ts"),
      },
    ],
  },
  server: {
    port: 4173,
    strictPort: true,
    host: "127.0.0.1",
  },
});
