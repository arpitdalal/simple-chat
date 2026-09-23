const listeners = new Set<() => void>();

export async function listen(
  _event: string,
  handler: () => void,
): Promise<() => void> {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

/** E2E / tests: fire the hide release hook. */
export function emitMainWindowHiddenForTests() {
  for (const fn of listeners) fn();
}
