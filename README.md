# Simple Chat

Local BYOK AI chat. Raycast-style: hotkey summon, close hides, no Dock by default.

## Features (v0.1)

- Sidebar chat history (SQLite, local-only)
- BYOK: OpenAI, Anthropic, Google (OS keychain / Credential Manager)
- Image paste/attach (vision)
- Provider-native web search (always on)
- Recordable global hotkey (default `⌘/Ctrl+⇧+Space`)
- Single model picker (filtered by saved API keys)
- Esc closes settings, then hides window
- Close = hide; Quit from tray
- Resume last chat within N minutes (default 5); empty New Chats auto-discarded
- Shortcuts: `⌘/Ctrl+N`, `⌘/Ctrl+1–0`, `⌘/Ctrl+,`, `⌘/Ctrl+B`

## Dev

```bash
npm install
npm run check
npm run tauri:dev
```

Release builds that publish updater artifacts need `TAURI_SIGNING_PRIVATE_KEY` set to the private key contents or a file path — pubkey is in `src-tauri/tauri.conf.json`. Endpoint is GitHub Releases `latest.json` (publish once #1 CI lands). Linux updater packages are AppImage-only (`tauri.linux.conf.json`).

## Tests

```bash
npm test          # unit + component integration (vitest)
npm run test:e2e  # browser UX flows (playwright + in-memory Tauri mocks)
npm run test:ipc  # real Tauri↔Rust IPC via embedded WebDriver (Linux CI; needs release binary)
npm run test:all
```

`test:ipc` expects `src-tauri/target/release/simple-chat` (`npm run build` then `cargo build --release --features webdriver` in `src-tauri`). CI runs on Windows (`.github/workflows/webdriver.yml`) — Linux WebKit custom-protocol Origin breaks IPC. Uses embedded `tauri-plugin-wdio-webdriver` (feature-gated).

**Note:** `tauri:dev` may briefly show a Dock icon / wrong menu name. Release builds use `LSUIElement` + accessory policy (no Dock; menu name “Simple Chat”).

## Stack

Tauri 2 + React + AI SDK + SQLite · MIT
