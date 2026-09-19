# Simple Chat

Local BYOK AI chat. Raycast-style: hotkey summon, close hides, no Dock by default.

## Features (v0.1)

- Sidebar chat history (SQLite, local-only)
- BYOK: OpenAI, Anthropic, Google (OS keychain / Credential Manager)
- Image paste/attach (vision)
- Provider-native web search toggle
- Hotkey: `⌘⇧Space` (mac) / `Ctrl+Shift+Space` (win)
- Close = hide; Quit from tray
- Resume last chat within N minutes (default 5); reuses empty New Chat
- Shortcuts: `⌘/Ctrl+N`, `⌘/Ctrl+1–0`, `⌘/Ctrl+,`
- Custom model IDs (catalog metadata wins on id match)

## Dev

```bash
npm install
npm run check
npm run tauri:dev
```

## Stack

Tauri 2 + React + AI SDK + SQLite · MIT
