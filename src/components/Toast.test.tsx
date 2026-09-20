import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Toast } from "./Toast";

describe("Toast", () => {
  it("renders ok toast and auto-dismisses", async () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<Toast toast={{ text: "Branched chat", kind: "ok" }} onDismiss={onDismiss} />);
    expect(screen.getByRole("status")).toHaveTextContent("Branched chat");
    await act(async () => {
      vi.advanceTimersByTime(2800);
    });
    expect(onDismiss).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("renders error as alert", () => {
    render(
      <Toast toast={{ text: "No API key", kind: "err" }} onDismiss={vi.fn()} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("No API key");
  });
});
