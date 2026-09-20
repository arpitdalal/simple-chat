import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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

const baseProps = {
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
};

describe("Sidebar", () => {
  it("shows Settings tab and opens settings", async () => {
    const user = userEvent.setup();
    const onOpenSettings = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        chats={[chat({ id: "1", title: "Hello" })]}
        onOpenSettings={onOpenSettings}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("shows cmd shortcut numbers without changing row count", () => {
    const chats = [
      chat({ id: "1", title: "A", preview: "one" }),
      chat({ id: "2", title: "B", preview: "two" }),
    ];
    const { rerender } = render(
      <Sidebar {...baseProps} chats={chats} showShortcuts={false} />,
    );
    const rowsOff = screen.getAllByRole("button").filter((b) =>
      within(b).queryByText("A") || within(b).queryByText("B"),
    );
    // chat items are role=button
    const itemsOff = document.querySelectorAll(".chat-item");
    expect(itemsOff).toHaveLength(2);
    expect(screen.queryByText("1")).toBeNull();

    rerender(<Sidebar {...baseProps} chats={chats} showShortcuts />);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(document.querySelectorAll(".chat-item")).toHaveLength(2);
  });

  it("selects a chat on click", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        chats={[chat({ id: "c9", title: "Domains", preview: "at tld" })]}
        activeId={null}
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByText("Domains"));
    expect(onSelect).toHaveBeenCalledWith("c9");
  });

  it("toggles sidebar from search row", async () => {
    const user = userEvent.setup();
    const onToggleSidebar = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        chats={[]}
        onToggleSidebar={onToggleSidebar}
      />,
    );
    await user.click(screen.getByTitle("Hide sidebar (⌘/Ctrl+B)"));
    expect(onToggleSidebar).toHaveBeenCalled();
  });
});
