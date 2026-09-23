---
status: accepted
---

# Deploy the marketing site from stable releases

The marketing site will be a static Astro application in `apps/website`, hosted at `https://arpitdalal.github.io/simple-chat`. Pull requests and pushes to `main` will build and validate it, but Pages will deploy only when a stable GitHub release is published or when a manual recovery run names a stable release tag. The deployment checks out that tag and builds its download links from the matching release assets, failing if the release or either macOS DMG is missing. Frequent merges to `main` therefore do not change the public site, and every published download page matches one stable release.
