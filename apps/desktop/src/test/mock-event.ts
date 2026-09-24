const listeners = new Map<string, Set<(payload?: unknown) => void>>();

export async function listen(
  event: string,
  handler: (payload?: unknown) => void,
): Promise<() => void> {
  const handlers = listeners.get(event) ?? new Set<(payload?: unknown) => void>();
  handlers.add(handler);
  listeners.set(event, handlers);
  return () => handlers.delete(handler);
}

export function emitMainWindowHiddenForTests(hiddenAt = Date.now()) {
  for (const fn of listeners.get("main-window-hidden") ?? []) fn({ payload: hiddenAt });
}

export function emitMainWindowShownForTests() {
  for (const fn of listeners.get("main-window-shown") ?? []) fn({ payload: 0 });
}

export function mainWindowShownListenerCountForTests() {
  return listeners.get("main-window-shown")?.size ?? 0;
}
