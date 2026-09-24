const listeners = new Map<string, Set<() => void>>();

export async function listen(
  event: string,
  handler: () => void,
): Promise<() => void> {
  const handlers = listeners.get(event) ?? new Set<() => void>();
  handlers.add(handler);
  listeners.set(event, handlers);
  return () => handlers.delete(handler);
}

export function emitMainWindowHiddenForTests() {
  for (const fn of listeners.get("main-window-hidden") ?? []) fn();
}

export function emitMainWindowShownForTests() {
  for (const fn of listeners.get("main-window-shown") ?? []) fn();
}

export function mainWindowShownListenerCountForTests() {
  return listeners.get("main-window-shown")?.size ?? 0;
}
