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

Release builds that publish updater artifacts need `TAURI_SIGNING_PRIVATE_KEY` set to the private key contents or a file path — pubkey is in `src-tauri/tauri.conf.json`. Endpoint is GitHub Releases `latest.json`.

## CI / Release

- **CI** (`.github/workflows/ci.yml`): on `main`/PR — vitest + `cargo test` + Playwright, then `tauri-apps/tauri-action` builds for **macOS** (arm64 + x64). Updater signing skipped on CI; ad-hoc signing (`APPLE_SIGNING_IDENTITY=-`). Win/Linux binary CI deferred.
- **Release** (`.github/workflows/release.yml`): on `v*` tags (or manual dispatch from `main`) — preflight → tests → draft GitHub Release → macOS matrix upload → deletes the draft if any leg fails/cancels. Publish the draft when ready. Needs `TAURI_SIGNING_PRIVATE_KEY` (+ optional password). After a failed tag release, delete the `v*` tag before re-pushing. macOS ships `.app` (updater) + DMG. Full Apple ID / notarization is #2.


## Tests

```bash
npm test          # unit + component integration (vitest)
npm run test:e2e  # browser UX flows (playwright + in-memory Tauri mocks)
npm run test:ipc  # real Tauri↔Rust IPC via embedded WebDriver (macOS CI; needs release binary)
npm run test:all
```

`test:ipc` expects `src-tauri/target/release/simple-chat` (`npm run build` then `TAURI_CONFIG=… cargo build --release --features webdriver` in `src-tauri` — `webdriver` enables `custom-protocol` so assets embed). CI runs on macOS (`.github/workflows/webdriver.yml`) — Linux/Windows WebView automation sends an invalid IPC Origin. Uses embedded `tauri-plugin-wdio-webdriver` (feature-gated).

**Note:** `tauri:dev` may briefly show a Dock icon / wrong menu name. Release builds use `LSUIElement` + accessory policy (no Dock; menu name “Simple Chat”).

## Stack

Tauri 2 + React + AI SDK + SQLite · MIT
