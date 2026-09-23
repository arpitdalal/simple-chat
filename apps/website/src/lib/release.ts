import { writeFile } from "node:fs/promises";

export type ReleaseAsset = {
  id: number;
  name: string;
  browser_download_url: string;
  size: number;
  state: string;
};

export type GitHubRelease = {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
};

export type ResolvedRelease = {
  tag: string;
  name: string;
  url: string;
  appleSilicon: ReleaseAsset;
  intel: ReleaseAsset;
};

const repository = "arpitdalal/simple-chat";
const repositoryApiUrl = `https://api.github.com/repos/${repository}`;
const repositoryWebUrl = `https://github.com/${repository}`;

export async function getRelease(): Promise<ResolvedRelease> {
  const tag = process.env.RELEASE_TAG?.trim();
  if (!tag) {
    throw new Error("RELEASE_TAG is required to build the website");
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "simple-chat-website-build",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  let response: Response;
  try {
    response = await fetch(`${repositoryApiUrl}/releases/tags/${encodeURIComponent(tag)}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Unable to read GitHub release ${tag}${detail}`);
  }

  if (!response.ok) {
    throw new Error(`Unable to read GitHub release ${tag}: HTTP ${response.status}`);
  }

  const release = (await response.json()) as GitHubRelease;
  const resolved = resolveRelease(release, tag);

  if (process.env.RELEASE_MANIFEST_PATH) {
    await writeFile(
      process.env.RELEASE_MANIFEST_PATH,
      JSON.stringify({
        id: release.id,
        name: resolved.name,
        tag: resolved.tag,
        assets: [resolved.appleSilicon, resolved.intel].map(
          ({ id, name, browser_download_url, size, state }) => ({
            id,
            name,
            browser_download_url,
            size,
            state,
          }),
        ),
      }),
      "utf8",
    );
  }

  return resolved;
}

export function resolveRelease(release: GitHubRelease, requestedTag: string): ResolvedRelease {
  if (!Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error(`Release ${requestedTag} has invalid release id data`);
  }
  if (!release.tag_name || release.tag_name !== requestedTag) {
    throw new Error(`GitHub returned release ${release.tag_name || "(missing tag)"} for ${requestedTag}`);
  }
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error(`Release ${requestedTag} is not stable`);
  }
  const expectedReleaseUrl = `${repositoryWebUrl}/releases/tag/${requestedTag}`;
  if (release.html_url !== expectedReleaseUrl) {
    throw new Error(`Release ${requestedTag} has an invalid release URL`);
  }
  if (!Array.isArray(release.assets)) {
    throw new Error(`Release ${requestedTag} has invalid asset data`);
  }

  const appleSilicon = findSingleAsset(release.assets, "_aarch64.dmg", requestedTag);
  const intel = findSingleAsset(release.assets, "_x64.dmg", requestedTag);

  return {
    tag: release.tag_name,
    name: release.name?.trim() || release.tag_name,
    url: release.html_url,
    appleSilicon,
    intel,
  };
}

function findSingleAsset(assets: ReleaseAsset[], suffix: string, tag: string): ReleaseAsset {
  const matches = assets.filter((asset) => asset.name.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`Release ${tag} must contain exactly one ${suffix} asset; found ${matches.length}`);
  }

  const asset = matches[0];
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0) {
    throw new Error(`Release asset ${asset.name} has invalid id data`);
  }
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`Release asset ${asset.name} has invalid size data`);
  }
  if (asset.state !== "uploaded") {
    throw new Error(`Release asset ${asset.name} is not fully uploaded`);
  }

  const expectedPrefix = `${repositoryWebUrl}/releases/download/${tag}/`;
  if (!asset.browser_download_url.startsWith(expectedPrefix)) {
    throw new Error(`Release asset ${asset.name} has an invalid download URL`);
  }

  return asset;
}

export function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
