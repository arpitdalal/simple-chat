export type ReleaseAsset = {
  name: string;
  browser_download_url: string;
  size: number;
};

export type GitHubRelease = {
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

const repositoryUrl = "https://api.github.com/repos/arpitdalal/simple-chat/releases/tags";

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
    response = await fetch(`${repositoryUrl}/${encodeURIComponent(tag)}`, { headers });
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(`Unable to read GitHub release ${tag}${detail}`);
  }

  if (!response.ok) {
    throw new Error(`Unable to read GitHub release ${tag}: HTTP ${response.status}`);
  }

  return resolveRelease((await response.json()) as GitHubRelease, tag);
}

export function resolveRelease(release: GitHubRelease, requestedTag: string): ResolvedRelease {
  if (!release.tag_name || release.tag_name !== requestedTag) {
    throw new Error(`GitHub returned release ${release.tag_name || "(missing tag)"} for ${requestedTag}`);
  }
  if (release.draft || release.prerelease) {
    throw new Error(`Release ${requestedTag} is not stable`);
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
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`Release asset ${asset.name} has invalid size data`);
  }

  const expectedPrefix = `https://github.com/arpitdalal/simple-chat/releases/download/${tag}/`;
  if (!asset.browser_download_url.startsWith(expectedPrefix)) {
    throw new Error(`Release asset ${asset.name} has an invalid download URL`);
  }

  return asset;
}

export function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
