import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "./Sidebar";
import type { Chat } from "../lib/db";

function chat(partial: Partial<Chat> & Pick<Chat, "id" | "title">): Chat {
  return {
    model_id: "gemini-3.8-flash",
    provider: "google",
    created_at: Date.now(),
    updated_at: Date.now(),
    preview: "Ask AI anything…",
    pinned: 0,
    ...partial,
  };
}

function props(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  return {
    activeId: "1" as string | null,
    query: "",
    onQuery: vi.fn(),
    onSelect: vi.fn(),
    onNew: vi.fn(),
    onToggleSidebar: vi.fn(),
    onOpenSettings: vi.fn(),
    settingsActive: false,
    onRename: vi.fn(),
    onPin: vi.fn(),
    onClear: vi.fn(),
    onDelete: vi.fn(),
    onCopyChat: vi.fn(),
    showShortcuts: false,
    hasMore: false,
    loadingMore: false,
    loadError: null,
    onLoadMore: vi.fn(),
    chats: [chat({ id: "1", title: "Alpha", preview: "a" })],
    ...overrides,
  };
}

describe("Sidebar actions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("filters chats by search query", () => {
    render(
      <Sidebar
        {...props({
          query: "beta",
          chats: [
            chat({ id: "1", title: "Alpha", preview: "a" }),
            chat({ id: "2", title: "Beta thread", preview: "b" }),
          ],
        })}
      />,
    );
    expect(screen.getByText("Beta thread")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("opens action menu and renames / pins / clears / deletes / copies", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onPin = vi.fn();
    const onClear = vi.fn();
    const onDelete = vi.fn();
    const onCopyChat = vi.fn();
    render(
      <Sidebar
        {...props({
          chats: [chat({ id: "1", title: "Alpha", preview: "a", pinned: 0 })],
          onRename,
          onPin,
          onClear,
          onDelete,
          onCopyChat,
        })}
      />,
    );

    await user.click(screen.getByTitle("Actions"));
    const menu = document.querySelector(".action-menu") as HTMLElement;
    expect(menu).toBeTruthy();

    await user.click(within(menu).getByText("Pin Chat"));
    expect(onPin).toHaveBeenCalledWith("1", true);

    await user.click(screen.getByTitle("Actions"));
    await user.click(within(document.querySelector(".action-menu")!).getByText("Copy Chat"));
    expect(onCopyChat).toHaveBeenCalledWith("1");

    await user.click(screen.getByTitle("Actions"));
    await user.click(within(document.querySelector(".action-menu")!).getByText("Clear Chat"));
    expect(onClear).toHaveBeenCalledWith("1");

    await user.click(screen.getByTitle("Actions"));
    await user.click(within(document.querySelector(".action-menu")!).getByText("Delete Chat"));
    expect(onDelete).toHaveBeenCalledWith("1");

    await user.click(screen.getByTitle("Actions"));
    await user.click(within(document.querySelector(".action-menu")!).getByText("Rename"));
    const input = screen.getByDisplayValue("Alpha");
    await user.clear(input);
    await user.type(input, "Renamed{Enter}");
    expect(onRename).toHaveBeenCalledWith("1", "Renamed");
  });

  it("context menu opens actions", async () => {
    const user = userEvent.setup();
    render(<Sidebar {...props()} />);
    await user.pointer({
      keys: "[MouseRight>]",
      target: screen.getByText("Alpha"),
    });
    await waitFor(() => expect(document.querySelector(".action-menu")).toBeTruthy());
    expect(screen.getByText("Rename")).toBeInTheDocument();
  });

  it("shows Unpin when chat is pinned", async () => {
    const user = userEvent.setup();
    render(
      <Sidebar
        {...props({
          chats: [chat({ id: "1", title: "Alpha", preview: "a", pinned: 1 })],
        })}
      />,
    );
    await user.click(screen.getByTitle("Actions"));
    expect(screen.getByText("Unpin Chat")).toBeInTheDocument();
  });
});
