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
const clearHotkey = vi.fn();
const setAlwaysOnTop = vi.fn();
const eventToAccelerator = vi.fn();
const getActiveHotkey = vi.fn();
const onSaved = vi.fn();
let focusHandler: ((e: { payload: boolean }) => void) | null = null;

vi.mock("../lib/keys", () => ({
  hasApiKey: (p: string) => hasApiKey(p),
  listReadyProviders: async () => {
    const ready: string[] = [];
    let ok = false;
    for (const p of ["openai", "anthropic", "google"] as const) {
      try {
        const has = await hasApiKey(p);
        ok = true;
        if (has) ready.push(p);
      } catch {
        /* skip */
      }
    }
    return { ready, ok };
  },
  setApiKey: (...a: unknown[]) => setApiKey(...a),
  clearApiKey: (...a: unknown[]) => clearApiKey(...a),
  keyErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

vi.mock("../lib/db", () => ({
  getSettings: () => getSettings(),
  setSetting: (...a: unknown[]) => setSetting(...a),
  deleteChatsOlderThan: vi.fn(),
}));

vi.mock("../lib/hotkey", () => ({
  applyHotkey: (...a: unknown[]) => applyHotkey(...a),
  clearHotkey: (...a: unknown[]) => clearHotkey(...a),
  DEFAULT_HOTKEY: "CommandOrControl+Shift+Space",
  eventToAccelerator: (...a: unknown[]) => eventToAccelerator(...a),
  formatHotkey: (s: string) => s,
  getActiveHotkey: () => getActiveHotkey(),
  isValidAccelerator: (s: string) => s.includes("+"),
}));

vi.mock("../lib/updater", () => ({
  checkForAppUpdate: vi.fn(async () => ({ status: "none" })),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setAlwaysOnTop,
    onFocusChanged: async (handler: (e: { payload: boolean }) => void) => {
      focusHandler = handler;
      return () => {
        focusHandler = null;
      };
    },
  }),
}));

describe("Settings behaviors", () => {
  beforeEach(() => {
    focusHandler = null;
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
    clearHotkey.mockResolvedValue(undefined);
    getActiveHotkey.mockReturnValue("CommandOrControl+Shift+Space");
    setSetting.mockResolvedValue(undefined);
  });

  it("accepts a typed accelerator when Record cannot hear OS-owned combos", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    const input = await screen.findByLabelText(/Global hotkey accelerator/i);
    await user.clear(input);
    await user.type(input, "CommandOrControl+Shift+K");
    await user.tab();
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith(
        "hotkey",
        "CommandOrControl+Shift+K",
      ),
    );
    expect(applyHotkey).toHaveBeenCalledWith("CommandOrControl+Shift+K");
  });

  it("re-registers last-good when a recorded hotkey is rejected", async () => {
    const user = userEvent.setup();
    eventToAccelerator.mockReturnValue("CommandOrControl+Shift+K");
    getActiveHotkey.mockReturnValue(null);
    applyHotkey.mockImplementation(async (accel: unknown) => {
      if (String(accel).includes("Shift+K")) {
        throw new Error("Could not register");
      }
    });
    clearHotkey.mockResolvedValue(undefined);
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await waitFor(() => expect(clearHotkey).toHaveBeenCalled());
    await user.keyboard("{Meta>}{Shift>}k{/Shift}{/Meta}");
    await waitFor(() =>
      expect(applyHotkey).toHaveBeenCalledWith("CommandOrControl+Shift+K"),
    );
    await waitFor(() =>
      expect(applyHotkey).toHaveBeenCalledWith("CommandOrControl+Shift+Space"),
    );
  });

  it("cancels pending save before Record clears the grab", async () => {
    const user = userEvent.setup();
    clearHotkey.mockResolvedValue(undefined);
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    const input = await screen.findByLabelText(/Global hotkey accelerator/i);
    await user.clear(input);
    await user.type(input, "CommandOrControl+Shift+Z");
    applyHotkey.mockClear();
    setSetting.mockClear();
    // Clicking Record blurs the input (queues save) then flushes before clear.
    await user.click(screen.getByText("Record"));
    await waitFor(() => expect(clearHotkey).toHaveBeenCalled());
    // Flush should have applied the typed accelerator before clear.
    expect(applyHotkey).toHaveBeenCalledWith("CommandOrControl+Shift+Z");
  });

  it("rejects typed accelerators without modifiers", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    const input = await screen.findByLabelText(/Global hotkey accelerator/i);
    await user.clear(input);
    await user.type(input, "A");
    await user.tab();
    await waitFor(() =>
      expect(screen.getByText(/at least one modifier/i)).toBeInTheDocument(),
    );
    expect(applyHotkey).not.toHaveBeenCalledWith("A");
  });

  it("commits typed hotkey on Escape before panel can close", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Settings onClose={onClose} onSaved={onSaved} />);
    const input = await screen.findByLabelText(/Global hotkey accelerator/i);
    await user.clear(input);
    await user.type(input, "CommandOrControl+Alt+Z");
    // Mimic App: Escape on focused input must commit; parent closes Settings.
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith(
        "hotkey",
        "CommandOrControl+Alt+Z",
      ),
    );
  });

  it("restores last-good when Record clear fails", async () => {
    const user = userEvent.setup();
    clearHotkey.mockRejectedValue(new Error("Could not release hotkeys"));
    applyHotkey.mockClear();
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await waitFor(() =>
      expect(screen.getByText(/Could not release hotkeys/i)).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(applyHotkey).toHaveBeenCalledWith("CommandOrControl+Shift+Space"),
    );
  });

  it("disables Record while already recording", async () => {
    const user = userEvent.setup();
    clearHotkey.mockResolvedValue(undefined);
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await waitFor(() =>
      expect(screen.getByDisplayValue(/Press keys/i)).toBeInTheDocument(),
    );
    expect(screen.getByText("Record").closest("button")).toBeDisabled();
  });

  it("disarms Record pause when pre-clear flush rejects", async () => {
    const user = userEvent.setup();
    clearHotkey.mockResolvedValue(undefined);
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    const input = await screen.findByLabelText(/Global hotkey accelerator/i);
    await user.clear(input);
    await user.type(input, "CommandOrControl+Shift+Z");
    setSetting.mockRejectedValueOnce(new Error("db locked"));
    applyHotkey.mockClear();
    await user.click(screen.getByText("Record"));
    await waitFor(() =>
      expect(screen.getByText(/db locked/i)).toBeInTheDocument(),
    );
    expect(clearHotkey).not.toHaveBeenCalled();
    // Pause disarmed — typed edits work again.
    await user.clear(input);
    await user.type(input, "CommandOrControl+Alt+Y");
    expect(input).toHaveValue("CommandOrControl+Alt+Y");
  });

  it("keeps Reset-to-default when closing during Record", async () => {
    const user = userEvent.setup();
    clearHotkey.mockResolvedValue(undefined);
    const { unmount } = render(
      <Settings onClose={vi.fn()} onSaved={onSaved} />,
    );
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await waitFor(() => expect(clearHotkey).toHaveBeenCalled());
    setSetting.mockClear();
    applyHotkey.mockClear();
    await user.click(screen.getByText("Reset"));
    unmount();
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith(
        "hotkey",
        "CommandOrControl+Shift+Space",
      ),
    );
  });

  it("surfaces an error when paused hotkey restore fails", async () => {
    const user = userEvent.setup();
    clearHotkey.mockResolvedValue(undefined);
    applyHotkey.mockImplementation(async (accel: unknown) => {
      if (String(accel).includes("Shift+Space")) {
        throw new Error("Could not restore hotkey");
      }
    });
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await waitFor(() => expect(clearHotkey).toHaveBeenCalled());
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.getByText(/Could not restore hotkey/i)).toBeInTheDocument(),
    );
  });

  it("restores hotkey when window blurs during Record", async () => {
    const user = userEvent.setup();
    clearHotkey.mockResolvedValue(undefined);
    applyHotkey.mockClear();
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await waitFor(() =>
      expect(screen.getByDisplayValue(/Press keys/i)).toBeInTheDocument(),
    );
    applyHotkey.mockClear();
    focusHandler?.({ payload: false });
    await waitFor(() =>
      expect(applyHotkey).toHaveBeenCalledWith("CommandOrControl+Shift+Space"),
    );
    await waitFor(() =>
      expect(
        screen.queryByDisplayValue(/Press keys/i),
      ).not.toBeInTheDocument(),
    );
  });

  it("flushes settings changed during Record after Escape", async () => {
    const user = userEvent.setup();
    clearHotkey.mockResolvedValue(undefined);
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await waitFor(() => expect(clearHotkey).toHaveBeenCalled());
    setSetting.mockClear();
    await user.click(screen.getByRole("checkbox", { name: /always on top/i }));
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith("always_on_top", true),
    );
  });

  it("clears the live grab when Record starts", async () => {
    const user = userEvent.setup();
    clearHotkey.mockResolvedValue(undefined);
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    await waitFor(() => expect(screen.getByText("Record")).toBeInTheDocument());
    await user.click(screen.getByText("Record"));
    await waitFor(() => expect(clearHotkey).toHaveBeenCalled());
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
    expect(screen.getByDisplayValue(/Press keys/i)).toBeInTheDocument();
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

  it("shifts default model to the provider of a newly saved key", async () => {
    const user = userEvent.setup();
    getSettings.mockResolvedValue({
      resume_minutes: 5,
      always_on_top: false,
      show_tray: true,
      default_provider: "openai",
      default_model: "gpt-5.6-luna",
      last_opened_at: 0,
      last_chat_id: null,
      web_search: true,
      hotkey: "CommandOrControl+Shift+Space",
    });
    hasApiKey.mockResolvedValue(false);
    setApiKey.mockImplementation(async () => {
      hasApiKey.mockImplementation(async (p: string) => p === "google");
    });
    render(<Settings onClose={vi.fn()} onSaved={onSaved} />);
    const inputs = await screen.findAllByPlaceholderText("Paste key");
    // openai, anthropic, google
    await user.type(inputs[2], "AIza-test");
    await user.tab();
    await waitFor(() => expect(setApiKey).toHaveBeenCalled());
    await waitFor(() =>
      expect(setSetting).toHaveBeenCalledWith("default_provider", "google"),
    );
    expect(setSetting).toHaveBeenCalledWith(
      "default_model",
      "gemini-3.8-flash",
    );
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
