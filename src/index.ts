export { defineConfig, type SiteConfig, type UserConfig } from "./core/config.js";
export { escapeHtml, html, raw, type SafeHtml } from "./core/html.js";
export { contactForm, type ContactFormLabels } from "./content/contact-form.js";
/** Zod, for layout field schemas: `export const frontmatter = z.object({ ... })`. Same instance vagejs validates with. */
export { z } from "zod";
export type { Layout, LayoutProps } from "./core/render.js";
export type { MenuItem } from "./core/menus.js";
export type { Frontmatter } from "./content/markdown.js";
export { breadcrumbs, collection, flatten, neighbors, tagList, tagSlug, tree, type CollectionOptions, type PageSummary, type TagSummary, type TreeNode } from "./core/pages.js";
export { build, type BuildResult } from "./core/build.js";
export { startDevServer } from "./dev/server.js";
export { startPreviewServer } from "./dev/preview.js";
export { VageError } from "./core/errors.js";
export { check, type CheckResult, type Finding } from "./checks/check.js";
export { article, breadcrumbList, jsonLdScript, organization, website, type Thing } from "./seo/jsonld.js";
export { AI_CRAWLERS, type CrawlerToken } from "./discovery/crawlers.js";
