import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings";

const hasApiKey = vi.fn();
const setApiKey = vi.fn();
const clearApiKey = vi.fn();
const getSettings = vi.fn();
const setSetting = vi.fn();
const setDefaultModel = vi.fn();
const applyHotkey = vi.fn();
const setAlwaysOnTop = vi.fn();

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
  setDefaultModel: (...a: unknown[]) => setDefaultModel(...a),
  deleteChatsOlderThan: vi.fn(),
}));

vi.mock("../lib/hotkey", () => ({
  applyHotkey: (...a: unknown[]) => applyHotkey(...a),
  clearHotkey: vi.fn(async () => undefined),
  DEFAULT_HOTKEY: "CommandOrControl+Shift+Space",
  eventToAccelerator: vi.fn(),
  formatHotkey: (s: string) => s,
  getActiveHotkey: () => "CommandOrControl+Shift+Space",
  isValidAccelerator: (s: string) => s.includes("+"),
}));

vi.mock("../lib/updater", () => ({
  checkForAppUpdate: vi.fn(async () => ({ status: "none" })),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setAlwaysOnTop,
    onFocusChanged: async () => () => {},
  }),
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
    setDefaultModel.mockImplementation(async (provider: string, modelId: string) => {
      const s = await getSettings();
      return { ...s, default_provider: provider, default_model: modelId };
    });
    setApiKey.mockResolvedValue(undefined);
    clearApiKey.mockResolvedValue(undefined);
  });

  it("shows Clear for saved keys and clears on click", async () => {
    const user = userEvent.setup();
    clearApiKey.mockImplementation(async () => {
      hasApiKey.mockResolvedValue(false);
    });
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/Google/)).toBeInTheDocument());
    const clearBtns = await screen.findAllByRole("button", { name: "Clear" });
    expect(clearBtns.length).toBeGreaterThanOrEqual(1);
    await user.click(clearBtns[0]);
    await waitFor(() => expect(clearApiKey).toHaveBeenCalledWith("google"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull(),
    );
  });

  it("surfaces keychain errors when saving a key fails", async () => {
    const user = userEvent.setup();
    const onNotify = vi.fn();
    hasApiKey.mockResolvedValue(false);
    setApiKey.mockRejectedValue(
      new Error(
        "Could not access the OS credential store. Unlock or repair Keychain / Credential Manager / Secret Service, then try again.",
      ),
    );
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} onNotify={onNotify} />);
    const inputs = await screen.findAllByPlaceholderText("Paste key");
    await user.type(inputs[0], "sk-test");
    await user.tab();
    await waitFor(() =>
      expect(
        screen.getByText(/Could not access the OS credential store/),
      ).toBeInTheDocument(),
    );
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining("OS credential store"),
      "err",
    );
    expect(screen.queryByText(/key saved/i)).toBeNull();
  });

  it("surfaces keychain errors when clearing a key fails", async () => {
    const user = userEvent.setup();
    const onNotify = vi.fn();
    clearApiKey.mockRejectedValue(new Error("Credential store error (locked)"));
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} onNotify={onNotify} />);
    await waitFor(() => expect(screen.getByText(/Google/)).toBeInTheDocument());
    const clearBtns = await screen.findAllByRole("button", { name: "Clear" });
    await user.click(clearBtns[0]);
    await waitFor(() =>
      expect(screen.getByText(/Credential store error/)).toBeInTheDocument(),
    );
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining("Credential store error"),
      "err",
    );
    expect(screen.getByText(/Google · saved/)).toBeInTheDocument();
  });

  it("surfaces keychain errors when probing saved keys fails", async () => {
    const onNotify = vi.fn();
    hasApiKey.mockRejectedValue(
      new Error("Could not access the OS credential store (NoDefaultStore)"),
    );
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} onNotify={onNotify} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Could not access the OS credential store/),
      ).toBeInTheDocument(),
    );
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining("OS credential store"),
      "err",
    );
  });

  it("keeps partial saved-key state when one provider probe fails", async () => {
    const onNotify = vi.fn();
    hasApiKey.mockImplementation(async (p: string) => {
      if (p === "anthropic") throw new Error("Could not access the OS credential store");
      return p === "google";
    });
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} onNotify={onNotify} />);
    await waitFor(() =>
      expect(
        screen.getByText(/Could not access the OS credential store/),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText(/Google · saved/)).toBeInTheDocument();
    expect(onNotify).toHaveBeenCalledWith(
      expect.stringContaining("OS credential store"),
      "err",
    );
  });

  it("shows Clear when probe fails because a saved credential is unreadable", async () => {
    hasApiKey.mockImplementation(async (p: string) => {
      if (p === "google") {
        throw new Error(
          "A saved credential is unreadable. Clear the key in Settings and paste it again.",
        );
      }
      return false;
    });
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/unreadable/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("keeps unreadable guidance after saving a different provider", async () => {
    const user = userEvent.setup();
    hasApiKey.mockImplementation(async (p: string) => {
      if (p === "google") {
        throw new Error(
          "A saved credential is unreadable. Clear the key in Settings and paste it again.",
        );
      }
      return false;
    });
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/unreadable/i)).toBeInTheDocument(),
    );
    const inputs = await screen.findAllByPlaceholderText("Paste key");
    await user.type(inputs[0], "sk-other");
    await user.tab();
    await waitFor(() => expect(setApiKey).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText(/unreadable/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("keeps a draft typed while a save is still pending", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    hasApiKey.mockResolvedValue(false);
    setApiKey.mockImplementation(async () => {
      await gate;
    });
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);
    const inputs = await screen.findAllByPlaceholderText("Paste key");
    await user.type(inputs[0], "sk-first");
    await user.tab();
    await waitFor(() => expect(setApiKey).toHaveBeenCalled());
    await user.click(inputs[0]);
    await user.clear(inputs[0]);
    await user.type(inputs[0], "sk-replacement");
    release();
    await waitFor(() =>
      expect((inputs[0] as HTMLInputElement).value).toBe("sk-replacement"),
    );
  });

  it("does not show a web search toggle", async () => {
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Settings")).toBeInTheDocument());
    expect(screen.queryByText(/web search/i)).toBeNull();
  });
});
