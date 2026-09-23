import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
let html = "";

beforeAll(async () => {
  html = await readFile(`${distDirectory}index.html`, "utf8");
});

describe("production landing page", () => {
  it("contains the core product story", () => {
    expect(html).toContain("Your AI, one keystroke away");
    expect(html).toContain("Bring your own keys. Keep your chat history on your Mac.");
    expect(html).toContain("Prompts still reach the provider whose key you selected.");
    expect(html).toContain("One shortcut. Four small moves.");
    expect(html).toContain("Six useful defaults");
    expect(html).toContain("Frequently asked");
  });

  it("generates separate downloads from the selected release", () => {
    expect(html).toContain("Download for Apple Silicon");
    expect(html).toContain("Download for Intel");
    expect(html).toMatch(/https:\/\/github\.com\/arpitdalal\/simple-chat\/releases\/download\/[^"']+_aarch64\.dmg/);
    expect(html).toMatch(/https:\/\/github\.com\/arpitdalal\/simple-chat\/releases\/download\/[^"']+_x64\.dmg/);
    expect(html).not.toContain("uarch");
  });

  it("ships production metadata and accessible local assets", () => {
    expect(html).toContain('<link rel="canonical" href="https://arpitdalal.github.io/simple-chat">');
    expect(html).toContain('property="og:image" content="https://arpitdalal.github.io/simple-chat/og-image.png"');
    expect(html).toContain('name="twitter:card"');
    expect(html).toContain('alt="Simple Chat showing a short Lisbon packing conversation"');
    expect(html).toContain('href="#main-content"');
  });

  it("has no client scripts or third-party runtime resources", () => {
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link[^>]+rel="(?:stylesheet|icon)"[^>]+href=["']https?:\/\//i);
    expect(html).not.toMatch(/<img[^>]+src=["']https?:\/\//i);
    expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//i);
    expect(html).not.toContain("fetch(");
  });
});
