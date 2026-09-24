import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Markdown } from "./Markdown";

const openUrl = vi.fn(async () => undefined);

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

function click(link: Element, init?: MouseEventInit) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  link.dispatchEvent(event);
  return event;
}

describe("Markdown", () => {
  beforeEach(() => {
    openUrl.mockReset();
    openUrl.mockResolvedValue(undefined);
  });

  it("renders headings and lists", () => {
    render(<Markdown content={"## Hello\n\n- one\n- two"} />);
    expect(screen.getByRole("heading", { name: "Hello" })).toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
  });

  it("renders fenced code", () => {
    render(<Markdown content={"```ts\nconst x = 1\n```"} />);
    expect(screen.getByText("const x = 1")).toBeInTheDocument();
  });

  it("strips raw HTML instead of escaping it as text", () => {
    const { container } = render(
      <Markdown content={'<script>alert(1)</script><img src=x onerror="alert(1)"><b>ok</b>'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    // rehype-sanitize drops html nodes; without it react-markdown escapes them as text
    expect(container.textContent).toBe("");
  });

  it("removes href from javascript: links", () => {
    const { container } = render(
      <Markdown content={"[click me](javascript:alert(1))"} />,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    // sanitize omits href; defaultUrlTransform alone leaves href=""
    expect(link!.hasAttribute("href")).toBe(false);
  });

  it("opens https links in the system browser and keeps the webview put", () => {
    render(<Markdown content={"see [docs](https://example.com/a)"} />);
    const event = click(screen.getByRole("link", { name: "docs" }));
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
  });

  it("opens mailto links in the system handler", () => {
    render(<Markdown content={"email [me](mailto:hi@example.com)"} />);
    const event = click(screen.getByRole("link", { name: "me" }));
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("mailto:hi@example.com");
  });

  it("opens middle-clicked https links without navigating the webview", () => {
    render(<Markdown content={"see [docs](https://example.com/a)"} />);
    const event = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    screen.getByRole("link", { name: "docs" }).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
  });

  it("blocks same-origin and relative links from navigating the webview", () => {
    render(<Markdown content={"go [home](/chat) or [rel](./local)"} />);
    for (const name of ["home", "rel"]) {
      const event = click(screen.getByRole("link", { name }));
      expect(event.defaultPrevented).toBe(true);
    }
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("keeps the webview put and reports when the system browser fails", async () => {
    openUrl.mockRejectedValueOnce(new Error("boom"));
    const onLinkError = vi.fn();
    render(
      <Markdown content={"see [docs](https://example.com/a)"} onLinkError={onLinkError} />,
    );
    const event = click(screen.getByRole("link", { name: "docs" }));
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(onLinkError).toHaveBeenCalledWith("boom"));
  });
});
