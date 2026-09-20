import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
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
});
