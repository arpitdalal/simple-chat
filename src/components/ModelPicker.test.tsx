import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelPicker } from "./ModelPicker";

const hasApiKey = vi.fn();

vi.mock("../lib/keys", () => ({
  hasApiKey: (p: string) => hasApiKey(p),
  keyErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : String(err),
}));

describe("ModelPicker", () => {
  beforeEach(() => {
    hasApiKey.mockReset();
    hasApiKey.mockImplementation(async (p: string) => p === "google");
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
    hasApiKey.mockImplementation(async () => true);
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
    // exact GPT-4o mini still matches "gpt-4o" substring — Gemini must be gone
    expect(within(list).queryByText("Gemini 3.8 Flash")).toBeNull();
  });

  it("shows keychain error instead of add-key hint when probe fails", async () => {
    const user = userEvent.setup();
    hasApiKey.mockRejectedValue(
      new Error("Could not access the OS credential store"),
    );
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
    hasApiKey.mockImplementation(async (p: string) => {
      if (p === "openai") throw new Error("Could not access the OS credential store");
      return p === "google";
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
    hasApiKey.mockResolvedValue(false);
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
});
