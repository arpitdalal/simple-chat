import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Markdown } from "./Markdown";

const openUrl = vi.fn(async () => undefined);

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (...args: unknown[]) => openUrl(...args),
}));

describe("Markdown", () => {
  beforeEach(() => {
    openUrl.mockReset();
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

  it("opens https links in the system browser and keeps the webview put", async () => {
    const user = userEvent.setup();
    render(<Markdown content={"see [docs](https://example.com/a)"} />);
    const link = screen.getByRole("link", { name: "docs" });

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);

    await user.click(link);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/a");
  });

  it("opens mailto links in the system handler", async () => {
    const user = userEvent.setup();
    render(<Markdown content={"email [me](mailto:hi@example.com)"} />);
    await user.click(screen.getByRole("link", { name: "me" }));
    expect(openUrl).toHaveBeenCalledWith("mailto:hi@example.com");
  });

  it("does not open same-origin or relative links", async () => {
    const user = userEvent.setup();
    render(<Markdown content={"go [home](/chat) or [rel](./local)"} />);
    await user.click(screen.getByRole("link", { name: "home" }));
    await user.click(screen.getByRole("link", { name: "rel" }));
    expect(openUrl).not.toHaveBeenCalled();
  });
});
