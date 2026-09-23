import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings";

const runtimeMocks = vi.hoisted(() => ({
  getVersion: vi.fn(async () => "1.2.3"),
  getPlatform: vi.fn(() => "macos"),
  getOsVersion: vi.fn(() => "15.6"),
  getArchitecture: vi.fn(() => "aarch64"),
  openUrl: vi.fn(async () => undefined),
  writeText: vi.fn(async () => undefined),
  checkForAppUpdate: vi.fn(async () => ({ status: "none" })),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: runtimeMocks.getVersion }));
vi.mock("@tauri-apps/plugin-os", () => ({
  arch: runtimeMocks.getArchitecture,
  platform: runtimeMocks.getPlatform,
  version: runtimeMocks.getOsVersion,
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: runtimeMocks.openUrl }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: runtimeMocks.writeText,
}));

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
    const failed: string[] = [];
    for (const p of ["openai", "anthropic", "google"] as const) {
      try {
        const has = await hasApiKey(p);
        if (has) ready.push(p);
      } catch {
        failed.push(p);
      }
    }
    return failed.length
      ? { ready, ok: false, failed, error: "probe failed" }
      : { ready, ok: true };
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
  checkForAppUpdate: runtimeMocks.checkForAppUpdate,
}));

const isAutostartEnabled = vi.hoisted(() => vi.fn(async () => false));
const setAutostartEnabled = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../lib/autostart", () => ({
  isAutostartEnabled,
  setAutostartEnabled,
  shouldPromptAutostart: () => false,
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
    runtimeMocks.getVersion.mockResolvedValue("1.2.3");
    runtimeMocks.getPlatform.mockReturnValue("macos");
    runtimeMocks.getOsVersion.mockReturnValue("15.6");
    runtimeMocks.getArchitecture.mockReturnValue("aarch64");
    runtimeMocks.openUrl.mockResolvedValue(undefined);
    runtimeMocks.writeText.mockResolvedValue(undefined);
    runtimeMocks.checkForAppUpdate.mockResolvedValue({ status: "none" });
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
      autostart_prompted: false,
    });
    isAutostartEnabled.mockResolvedValue(false);
    setAutostartEnabled.mockResolvedValue(undefined);
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

  it("loads the installed version beside the update action and copies it", async () => {
    const user = userEvent.setup();
    let resolveVersion!: (version: string) => void;
    runtimeMocks.getVersion.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveVersion = resolve;
      }),
    );
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText("Version Loading…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy version" })).toBeDisabled();
    resolveVersion("1.2.3");
    expect(await screen.findByText("Version 1.2.3")).toBeInTheDocument();
    const updates = screen.getByRole("heading", { name: "Updates" }).closest("section");
    expect(within(updates!).getByRole("button", { name: "Check for updates" })).toBeInTheDocument();

    await user.click(within(updates!).getByRole("button", { name: "Copy version" }));
    expect(runtimeMocks.writeText).toHaveBeenCalledWith("1.2.3");
    expect(await within(updates!).findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("opens source and builds a prefilled issue report from runtime metadata", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);

    await screen.findByText("Version 1.2.3");
    const updates = screen.getByRole("heading", { name: "Updates" }).closest("section");
    const history = screen.getByRole("heading", { name: "History" }).closest("section");
    const about = screen.getByRole("heading", { name: "About" }).closest("section");
    expect(updates!.compareDocumentPosition(history!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(history!.compareDocumentPosition(about!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(about!).getByText("Simple Chat")).toBeInTheDocument();
    expect(about!.querySelector("img")).toHaveAttribute("src", "/logo.png");

    await user.click(within(about!).getByRole("button", { name: "View source" }));
    expect(runtimeMocks.openUrl).toHaveBeenNthCalledWith(
      1,
      "https://github.com/arpitdalal/simple-chat",
    );

    await user.click(within(about!).getByRole("button", { name: "Report an issue" }));
    expect(runtimeMocks.openUrl).toHaveBeenCalledTimes(2);
    const issueUrl = new URL(runtimeMocks.openUrl.mock.calls[1][0] as string);
    expect(`${issueUrl.origin}${issueUrl.pathname}`).toBe(
      "https://github.com/arpitdalal/simple-chat/issues/new",
    );
    expect(issueUrl.searchParams.get("title")).toBeNull();
    expect(issueUrl.searchParams.get("body")).toBe(
      [
        "Version: 1.2.3",
        "OS: macOS 15.6",
        "Architecture: aarch64",
        "",
        "Description:",
        "",
        "Steps to reproduce:",
        "",
        "1.",
        "",
        "Expected behavior:",
      ].join("\n"),
    );
  });

  it("keeps update checks working from Settings", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);

    await screen.findByText("Version 1.2.3");
    await user.click(
      screen.getByRole("button", { name: "Check for updates" }),
    );
    expect(runtimeMocks.checkForAppUpdate).toHaveBeenCalledOnce();
    expect(await screen.findByText("Up to date")).toBeInTheDocument();
  });

  it("keeps an unavailable version disabled and retries loading", async () => {
    const user = userEvent.setup();
    runtimeMocks.getVersion.mockRejectedValueOnce(
      new Error("IPC unavailable"),
    );
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);

    expect(await screen.findByText("Version Unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy version" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Version 1.2.3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy version" })).toBeEnabled();
  });

  it("does not open an issue report with incomplete runtime metadata", async () => {
    const user = userEvent.setup();
    const onNotify = vi.fn();
    runtimeMocks.getArchitecture.mockReturnValue("");
    render(
      <Settings
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onNotify={onNotify}
      />,
    );

    await screen.findByText("Version 1.2.3");
    await user.click(
      screen.getByRole("button", { name: "Report an issue" }),
    );
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith(
        "Could not read complete app details. Try again.",
        "err",
      ),
    );
    expect(runtimeMocks.openUrl).not.toHaveBeenCalled();
  });

  it("clears stale copy feedback before a new write settles", async () => {
    const user = userEvent.setup();
    let finishWrite!: () => void;
    runtimeMocks.writeText
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
      );
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);

    await screen.findByText("Version 1.2.3");
    await user.click(screen.getByRole("button", { name: "Copy version" }));
    await screen.findByRole("button", { name: "Copied" });
    await user.click(screen.getByRole("button", { name: "Copied" }));
    expect(screen.getByRole("button", { name: "Copy version" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    finishWrite();
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
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

  it("toggles start on login against the OS login item", async () => {
    const user = userEvent.setup();
    const onAutostartSettled = vi.fn();
    render(
      <Settings
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAutostartSettled={onAutostartSettled}
      />,
    );
    const box = await screen.findByRole("checkbox", { name: /start on login/i });
    await waitFor(() => expect(box).not.toBeDisabled());
    expect(box).not.toBeChecked();
    await user.click(box);
    await waitFor(() => expect(setAutostartEnabled).toHaveBeenCalledWith(true));
    expect(setSetting).toHaveBeenCalledWith("autostart_prompted", true);
    expect(onAutostartSettled).toHaveBeenCalledOnce();
    await waitFor(() => expect(box).toBeChecked());
  });

  it("does not settle the first-run prompt when the flag write fails", async () => {
    const user = userEvent.setup();
    const onAutostartSettled = vi.fn();
    const onNotify = vi.fn();
    setSetting.mockRejectedValueOnce(new Error("db locked"));
    render(
      <Settings
        onClose={vi.fn()}
        onSaved={vi.fn()}
        onAutostartSettled={onAutostartSettled}
        onNotify={onNotify}
      />,
    );
    const box = await screen.findByRole("checkbox", { name: /start on login/i });
    await waitFor(() => expect(box).not.toBeDisabled());
    await user.click(box);
    await waitFor(() => expect(setAutostartEnabled).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(onNotify).toHaveBeenCalledWith("db locked", "err"),
    );
    expect(onAutostartSettled).not.toHaveBeenCalled();
  });

  it("retries login-item read after a failed probe", async () => {
    const user = userEvent.setup();
    isAutostartEnabled
      .mockRejectedValueOnce(new Error("no login item"))
      .mockResolvedValueOnce(false);
    render(<Settings onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/no login item/)).toBeInTheDocument(),
    );
    const box = screen.getByRole("checkbox", { name: /start on login/i });
    expect(box).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(box).not.toBeDisabled());
    expect(screen.queryByText(/no login item/)).toBeNull();
  });
});
