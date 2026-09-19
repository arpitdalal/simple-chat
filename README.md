# Simple Chat

Local BYOK AI chat. Raycast-style: hotkey summon, close hides, no Dock by default.

## Features (v0.1)

- Sidebar chat history (SQLite, local-only)
- BYOK: OpenAI, Anthropic, Google (OS keychain / Credential Manager)
- Image paste/attach (vision)
- Provider-native web search toggle
- Recordable global hotkey (default `⌘/Ctrl+⇧+Space`)
- In-chat model/provider picker
- Esc closes settings, then hides window
- Close = hide; Quit from tray
- Resume last chat within N minutes (default 5)
- Shortcuts: `⌘/Ctrl+N`, `⌘/Ctrl+1–0`, `⌘/Ctrl+,`

## Dev

```bash
npm install
npm run check
npm run tauri:dev
```

**Note:** `tauri:dev` may briefly show a Dock icon / wrong menu name. Release builds use `LSUIElement` + accessory policy (no Dock; menu name “Simple Chat”).

## Stack

Tauri 2 + React + AI SDK + SQLite · MIT
