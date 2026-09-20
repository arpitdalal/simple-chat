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
const eventToAccelerator = vi.fn();
const getActiveHotkey = vi.fn();
const onSaved = vi.fn();

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
  eventToAccelerator: (...a: unknown[]) => eventToAccelerator(...a),
  formatHotkey: (s: string) => s,
  getActiveHotkey: () => getActiveHotkey(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setAlwaysOnTop }),
}));

describe("Settings behaviors", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue({
      resume_minutes: 5,
      always_on_top: false,
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
    getActiveHotkey.mockReturnValue("CommandOrControl+Shift+Space");
    setSetting.mockResolvedValue(undefined);
  });

  it("keeps prior hotkey when registration fails", async () => {
    const user = userEvent.setup();
    eventToAccelerator.mockReturnValue("CommandOrControl+Shift+K");
    applyHotkey.mockRejectedValue(
      new Error("Could not register ⌘/Ctrl + ⇧ + K — already taken"),
    );
    getActiveHotkey.mockReturnValue("CommandOrControl+Shift+Space");
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    await waitFor(() =>
      expect(
        screen.getByText(/Could not register/i),
      ).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith(
        "hotkey",
        "CommandOrControl+Shift+Space",
      ),
    );
  });

  it("keeps last-good hotkey when active binding is null", async () => {
    const user = userEvent.setup();
    eventToAccelerator.mockReturnValue("CommandOrControl+Shift+K");
    applyHotkey.mockRejectedValue(
      new Error("Could not register ⌘/Ctrl + ⇧ + K — already taken"),
    );
    getActiveHotkey.mockReturnValue(null);
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith(
        "hotkey",
        "CommandOrControl+Shift+Space",
      ),
    );
    expect(screen.getByText(/Could not register/i)).toBeInTheDocument();
  });

  it("toggles always on top and persists", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Always on top")).toBeInTheDocument());
    await user.click(screen.getByRole("checkbox", { name: /always on top/i }));
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith("always_on_top", true),
    );
    await waitFor(() => expect(setAlwaysOnTop).toHaveBeenCalledWith(true));
  });

  it("records a new hotkey", async () => {
    const user = userEvent.setup();
    eventToAccelerator.mockReturnValue("CommandOrControl+Shift+K");
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    expect(screen.getByText(/Press keys/i)).toBeInTheDocument();
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith(
        "hotkey",
        "CommandOrControl+Shift+K",
      ),
    );
  });

  it("resets hotkey to default", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Reset")).toBeInTheDocument());
    await user.click(screen.getByText("Reset"));
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith(
        "hotkey",
        "CommandOrControl+Shift+Space",
      ),
    );
  });

  it("saves API key on blur", async () => {
    const user = userEvent.setup();
    hasApiKey.mockResolvedValue(false);
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    const inputs = await screen.findAllByPlaceholderText("Paste key");
    await user.type(inputs[0], "sk-test");
    await user.tab();
    await waitFor(() => expect(setApiKey).toHaveBeenCalled());
  });

  it("updates resume minutes", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    const input = await screen.findByDisplayValue("5");
    await user.clear(input);
    await user.type(input, "10");
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith("resume_minutes", 10),
    );
  });

  it("saves default model from picker", async () => {
    const user = userEvent.setup();
    hasApiKey.mockImplementation(async () => true);
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() =>
      expect(screen.getByTitle("Select model")).toBeInTheDocument(),
    );
    await user.click(screen.getByTitle("Select model"));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    await user.type(screen.getByPlaceholderText("Search…"), "gpt-4o");
    const opts = await screen.findAllByRole("option");
    const gpt4o = opts.find(
      (o) => o.textContent?.includes("GPT-4o") && !o.textContent?.includes("mini"),
    );
    await user.click(gpt4o!);
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith("default_model", "gpt-4o"),
    );
    expect(setSetting).toHaveBeenCalledWith("default_provider", "openai");
  });
});
