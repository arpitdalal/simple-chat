import { describe, expect, it } from "vitest";
import { formatFileSize, resolveRelease, type GitHubRelease } from "../src/lib/release";

const release: GitHubRelease = {
  id: 101,
  tag_name: "v1.2.3",
  name: "Simple Chat v1.2.3",
  html_url: "https://github.com/arpitdalal/simple-chat/releases/tag/v1.2.3",
  draft: false,
  prerelease: false,
  assets: [
    {
      id: 201,
      name: "Simple.Chat_1.2.3_aarch64.dmg",
      browser_download_url: "https://github.com/arpitdalal/simple-chat/releases/download/v1.2.3/Simple.Chat_1.2.3_aarch64.dmg",
      size: 5_242_880,
      state: "uploaded",
    },
    {
      id: 202,
      name: "Simple.Chat_1.2.3_x64.dmg",
      browser_download_url: "https://github.com/arpitdalal/simple-chat/releases/download/v1.2.3/Simple.Chat_1.2.3_x64.dmg",
      size: 5_767_168,
      state: "uploaded",
    },
  ],
};

describe("release resolution", () => {
  it("selects both required macOS assets", () => {
    const resolved = resolveRelease(release, "v1.2.3");

    expect(resolved.appleSilicon.name).toMatch(/_aarch64\.dmg$/);
    expect(resolved.intel.name).toMatch(/_x64\.dmg$/);
    expect(formatFileSize(resolved.appleSilicon.size)).toBe("5.0 MB");
  });

  it.each([
    ["draft", { draft: true }],
    ["prerelease", { prerelease: true }],
    ["a mismatched tag", { tag_name: "v1.2.2" }],
  ])("rejects %s releases", (_label, override) => {
    expect(() => resolveRelease({ ...release, ...override }, "v1.2.3")).toThrow();
  });

  it("rejects incomplete and invalid release data", () => {
    expect(() => resolveRelease({ ...release, assets: release.assets.slice(0, 1) }, "v1.2.3")).toThrow();
    expect(() => resolveRelease({ ...release, html_url: "" }, "v1.2.3")).toThrow();
    expect(() => resolveRelease({ ...release, id: 0 }, "v1.2.3")).toThrow();
    expect(() =>
      resolveRelease(
        {
          ...release,
          assets: release.assets.map((asset) =>
            asset.name.endsWith("_aarch64.dmg") ? { ...asset, state: "starter" } : asset,
          ),
        },
        "v1.2.3",
      ),
    ).toThrow();
    expect(() =>
      resolveRelease(
        {
          ...release,
          assets: release.assets.map((asset) =>
            asset.name.endsWith("_aarch64.dmg") ? { ...asset, browser_download_url: "https://example.com/app.dmg" } : asset,
          ),
        },
        "v1.2.3",
      ),
    ).toThrow();
  });

  it("rejects assets from a different release", () => {
    expect(() =>
      resolveRelease(
        {
          ...release,
          assets: release.assets.map((asset) =>
            asset.name.endsWith("_aarch64.dmg")
              ? {
                  ...asset,
                  browser_download_url: asset.browser_download_url.replace("v1.2.3", "v1.2.2"),
                }
              : asset,
          ),
        },
        "v1.2.3",
      ),
    ).toThrow();
  });
});
