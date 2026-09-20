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

Release builds that publish updater artifacts need `TAURI_SIGNING_PRIVATE_KEY` (or `_PATH`) set — pubkey is in `src-tauri/tauri.conf.json`. Endpoints point at GitHub Releases `latest.json` (wired by issue #1 CI).

## Tests

```bash
npm test          # unit + component integration (vitest)
npm run test:e2e  # browser UX flows (playwright + in-memory Tauri mocks)
npm run test:all
```

**Note:** `tauri:dev` may briefly show a Dock icon / wrong menu name. Release builds use `LSUIElement` + accessory policy (no Dock; menu name “Simple Chat”).

## Stack

Tauri 2 + React + AI SDK + SQLite · MIT
