import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings";

const hasApiKey = vi.fn();
const setApiKey = vi.fn();
const clearApiKey = vi.fn();
const getSettings = vi.fn();
const setSetting = vi.fn();
const applyHotkey = vi.fn();
const setAlwaysOnTop = vi.fn();

vi.mock("../lib/keys", () => ({
  hasApiKey: (p: string) => hasApiKey(p),
  setApiKey: (...a: unknown[]) => setApiKey(...a),
  clearApiKey: (...a: unknown[]) => clearApiKey(...a),
}));

vi.mock("../lib/db", () => ({
  getSettings: () => getSettings(),
  setSetting: (...a: unknown[]) => setSetting(...a),
  deleteChatsOlderThan: vi.fn(),
}));

vi.mock("../lib/hotkey", () => ({
  applyHotkey: (...a: unknown[]) => applyHotkey(...a),
  DEFAULT_HOTKEY: "CommandOrControl+Shift+Space",
  eventToAccelerator: vi.fn(),
  formatHotkey: (s: string) => s,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setAlwaysOnTop }),
}));

describe("Settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue({
      resume_minutes: 5,
      always_on_top: true,
      show_tray: true,
      default_provider: "google",
      default_model: "gemini-3.8-flash",
      last_opened_at: 0,
      last_chat_id: null,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
    });
    hasApiKey.mockImplementation(async (p: string) => p === "google");
    applyHotkey.mockResolvedValue(undefined);
    setSetting.mockResolvedValue(undefined);
    clearApiKey.mockResolvedValue(undefined);
  });

  it("shows Clear for saved keys and clears on click", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Google/)).toBeInTheDocument());
    const clearBtns = await screen.findAllByRole("button", { name: "Clear" });
    expect(clearBtns.length).toBeGreaterThanOrEqual(1);
    await user.click(clearBtns[0]);
    await waitFor(() => expect(clearApiKey).toHaveBeenCalledWith("google"));
  });

  it("does not show a web search toggle", async () => {
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Settings")).toBeInTheDocument());
    expect(screen.queryByText(/web search/i)).toBeNull();
  });
});
