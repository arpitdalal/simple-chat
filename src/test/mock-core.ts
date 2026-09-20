const keys = new Map<string, string>([
  ["google", "test-google-key"],
  ["openai", "test-openai-key"],
]);

export async function invoke<T>(cmd: string, args?: Record<string, string>): Promise<T> {
  if (cmd === "has_api_key") {
    return (keys.has(args?.provider ?? "") && !!keys.get(args!.provider)) as T;
  }
  if (cmd === "get_api_key") {
    return (keys.get(args?.provider ?? "") ?? null) as T;
  }
  if (cmd === "set_api_key") {
    const provider = args?.provider ?? "";
    const key = args?.key ?? "";
    if (!key.trim()) keys.delete(provider);
    else keys.set(provider, key.trim());
    return undefined as T;
  }
  if (cmd === "capture_previous_app" || cmd === "hide_main_window_cmd") {
    return undefined as T;
  }
  return undefined as T;
}
