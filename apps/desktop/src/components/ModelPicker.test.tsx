import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelPicker } from "./ModelPicker";
import type { ProviderId } from "../lib/models";

const listReadyProviders = vi.fn();

vi.mock("../lib/keys", () => ({
  listReadyProviders: () => listReadyProviders(),
  keyErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

describe("ModelPicker", () => {
  beforeEach(() => {
    listReadyProviders.mockReset();
    listReadyProviders.mockResolvedValue({ ready: ["google"] as ProviderId[], ok: true });
  });

  it("only lists models for providers with API keys", async () => {
    const user = userEvent.setup();
    render(
      <ModelPicker
        provider="google"
        modelId="gemini-3.8-flash"
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /gemini 3.8 flash/i }));
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toBeInTheDocument();
    });
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("Gemini 3.8 Flash")).toBeInTheDocument();
    expect(within(list).queryByText("GPT-4o")).toBeNull();
    expect(within(list).queryByText("Claude Haiku 4.5")).toBeNull();
    expect(within(list).getAllByRole("option").length).toBeGreaterThan(1);
  });

  it("Escape closes menu and does not leave it open", async () => {
    const user = userEvent.setup();
    render(
      <ModelPicker
        provider="google"
        modelId="gemini-3.8-flash"
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /gemini 3.8 flash/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("arrow keys move highlight and Enter selects", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ModelPicker
        provider="google"
        modelId="gemini-3.8-flash"
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /gemini 3.8 flash/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0]).toBe("google");
  });

  it("filters models by typed query", async () => {
    const user = userEvent.setup();
    listReadyProviders.mockResolvedValue({
      ready: ["google", "openai", "anthropic"] as ProviderId[],
      ok: true,
    });
    render(
      <ModelPicker
        provider="google"
        modelId="gemini-3.8-flash"
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /gemini 3.8 flash/i }));
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    const filter = screen.getByPlaceholderText("Search…");
    await user.type(filter, "gpt-4o");
    const list = screen.getByRole("listbox");
    await waitFor(() => {
      expect(within(list).getByText("GPT-4o")).toBeInTheDocument();
    });
    expect(within(list).queryByText("Gemini 3.8 Flash")).toBeNull();
  });

  it("shows keychain error instead of add-key hint when probe fails", async () => {
    const user = userEvent.setup();
    listReadyProviders.mockResolvedValue({
      ready: [],
      ok: false,
      error: "Could not access the OS credential store",
    });
    render(
      <ModelPicker
        provider="google"
        modelId="gemini-3.8-flash"
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /gemini 3.8 flash/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/Could not access the OS credential store/),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Add an API key in Settings/)).toBeNull();
  });

  it("keeps partial ready providers and still shows keychain error", async () => {
    const user = userEvent.setup();
    listReadyProviders.mockResolvedValue({
      ready: ["google"] as ProviderId[],
      ok: true,
      error: "Could not access the OS credential store",
    });
    render(
      <ModelPicker
        provider="google"
        modelId="gemini-3.8-flash"
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /gemini 3.8 flash/i }));
    await waitFor(() =>
      expect(
        screen.getByText(/Could not access the OS credential store/),
      ).toBeInTheDocument(),
    );
    expect(within(screen.getByRole("listbox")).getByText("Gemini 3.8 Flash")).toBeInTheDocument();
  });

  it("shows Add API key and calls onNeedKey when no keys", async () => {
    const user = userEvent.setup();
    const onNeedKey = vi.fn();
    listReadyProviders.mockResolvedValue({ ready: [], ok: true });
    render(
      <ModelPicker
        provider="openai"
        modelId="gpt-5.6-luna"
        onChange={vi.fn()}
        onNeedKey={onNeedKey}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /add api key/i })).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /add api key/i }));
    expect(onNeedKey).toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("knownNoKeys shows Add API key before probe finishes", () => {
    listReadyProviders.mockReturnValue(new Promise(() => {}));
    render(
      <ModelPicker
        provider="openai"
        modelId="gpt-5.6-luna"
        onChange={vi.fn()}
        knownNoKeys
        onNeedKey={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /add api key/i })).toBeInTheDocument();
  });

  it("failed re-probe clears ready and notifies onReady(null)", async () => {
    const onReady = vi.fn();
    listReadyProviders
      .mockResolvedValueOnce({ ready: ["google"] as ProviderId[], ok: true })
      .mockResolvedValueOnce({
        ready: [],
        ok: false,
        error: "Could not access the OS credential store",
      });
    const user = userEvent.setup();
    render(
      <ModelPicker
        provider="google"
        modelId="gemini-3.8-flash"
        onChange={vi.fn()}
        onReady={onReady}
      />,
    );
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(["google"]));
    await user.click(screen.getByRole("button", { name: /gemini 3.8 flash/i }));
    await waitFor(() => expect(onReady).toHaveBeenCalledWith(null));
    expect(
      screen.getByText(/Could not access the OS credential store/),
    ).toBeInTheDocument();
  });
});
