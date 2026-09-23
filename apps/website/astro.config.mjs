import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://arpitdalal.github.io/simple-chat",
  base: "/simple-chat",
  output: "static",
  trailingSlash: "never",
  integrations: [sitemap()],
});
