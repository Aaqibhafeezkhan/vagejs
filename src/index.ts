export { defineConfig, type SiteConfig, type UserConfig } from "./core/config.js";
export { escapeHtml } from "./core/html.js";
export type { Layout, LayoutProps } from "./core/render.js";
export type { Frontmatter } from "./content/markdown.js";
export { build, type BuildResult } from "./core/build.js";
export { startDevServer } from "./dev/server.js";
export { startPreviewServer } from "./dev/preview.js";
export { VageError } from "./core/errors.js";
