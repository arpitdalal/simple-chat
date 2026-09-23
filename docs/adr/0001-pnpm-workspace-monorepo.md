---
status: accepted
---

# Use a pnpm workspace monorepo

Simple Chat will use pnpm 12 on Node 24 as a workspace containing `apps/desktop` and `apps/website`. The root package will hold workspace configuration and forwarding scripts, while each app keeps its own dependencies, build configuration, tests, and output. The desktop package remains the sole owner of the application version. This gives the website an independent build without letting it overwrite the Tauri frontend in `apps/desktop/dist`, and it gives future apps a clear home without forcing shared abstractions on the desktop app.
