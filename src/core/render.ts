import fs from "node:fs";
import path from "node:path";
import { parseMarkdown, type Frontmatter } from "../content/markdown.js";
import type { ModuleLoader, SiteConfig } from "./config.js";
import { VageError } from "./errors.js";
import { escapeHtml } from "./html.js";

export interface LayoutProps {
  /** Rendered page body HTML. Insert as-is; do not escape. */
  content: string;
  page: {
    route: string;
    title: string;
    description?: string;
    frontmatter: Frontmatter;
  };
  site: SiteConfig;
}

export type Layout = (props: LayoutProps) => string | Promise<string>;

export interface RenderedPage {
  html: string;
  frontmatter: Frontmatter;
}

export async function renderPage(options: {
  root: string;
  file: string;
  route: string;
  site: SiteConfig;
  load: ModuleLoader;
}): Promise<RenderedPage> {
  const { root, file, route, site, load } = options;
  const { frontmatter, html: content } = parseMarkdown(fs.readFileSync(file, "utf8"), file);
  const layout = await resolveLayout(root, frontmatter.layout, load, file);
  const html = await layout({
    content,
    page: { route, title: frontmatter.title, description: frontmatter.description, frontmatter },
    site,
  });
  if (typeof html !== "string") {
    throw new VageError(`Layout "${frontmatter.layout ?? "default"}" must return an HTML string.`, file);
  }
  return { html, frontmatter };
}

const LAYOUT_EXTENSIONS = [".ts", ".js", ".mjs"];

async function resolveLayout(
  root: string,
  name: string | undefined,
  load: ModuleLoader,
  pageFile: string,
): Promise<Layout> {
  const base = path.join(root, "src", "layouts", name ?? "default");
  const file = LAYOUT_EXTENSIONS.map((ext) => base + ext).find((f) => fs.existsSync(f));
  if (!file) {
    if (!name) return defaultLayout;
    throw new VageError(`Layout "${name}" not found. Expected src/layouts/${name}.ts`, pageFile);
  }
  const layout = (await load(file)).default;
  if (typeof layout !== "function") {
    throw new VageError("Layout files must default-export a function that returns an HTML string.", file);
  }
  return layout as Layout;
}

/** Used when a project has no src/layouts/default.ts. */
export const defaultLayout: Layout = ({ content, page, site }) => {
  const title = site.title && site.title !== page.title ? `${page.title} | ${site.title}` : page.title;
  const description = page.description ?? site.description;
  return `<!doctype html>
<html lang="${escapeHtml(site.lang)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>${description ? `\n    <meta name="description" content="${escapeHtml(description)}" />` : ""}
  </head>
  <body>
    <main>
${content}
    </main>
  </body>
</html>
`;
};
