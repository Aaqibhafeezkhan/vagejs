import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { frontmatterSchema, parseMarkdown, type Frontmatter } from "../content/markdown.js";
import { enhanceImages } from "../content/images.js";
import { sanitizeHtml } from "../content/sanitize.js";
import type { ModuleLoader, SiteConfig } from "./config.js";
import { VageError } from "./errors.js";
import { escapeHtml, isSafeHtml, type SafeHtml } from "./html.js";
import { headTags, injectHead, pageMeta, type PageMeta } from "../seo/head.js";
import { analyticsTags, injectAnalytics } from "../integrations/tags.js";
import type { PageSummary } from "./pages.js";

export interface LayoutProps {
  /** Rendered page body HTML. Insert as-is; do not escape. */
  content: string;
  page: {
    route: string;
    title: string;
    description?: string;
    /** Absolute canonical URL, when `site` is set and the page is indexable. */
    url?: string;
    frontmatter: Frontmatter;
  };
  site: SiteConfig;
  /**
   * Every published page (drafts excluded), sorted by route. Use `collection()` to
   * pick a section and order it, e.g. a blog index or a sidebar.
   */
  pages: PageSummary[];
}

/** Returns the page's HTML: a string, or `html\`...\`` (escapes values automatically). */
export type Layout = (props: LayoutProps) => string | SafeHtml | Promise<string | SafeHtml>;

export interface RenderedPage {
  html: string;
  frontmatter: Frontmatter;
  /** Markdown body without frontmatter. */
  body: string;
  meta: PageMeta;
}

export async function renderPage(options: {
  root: string;
  file: string;
  route: string;
  site: SiteConfig;
  load: ModuleLoader;
  /** Renders the 404 page: always noindex, no canonical. */
  notFound?: boolean;
  /** Add configured analytics tags. Off in the dev server so development traffic is never measured. */
  analytics?: boolean;
  /** Published pages for `props.pages`. */
  pages?: PageSummary[];
}): Promise<RenderedPage> {
  const { root, file, route, site, load } = options;
  const parsed = parseMarkdown(fs.readFileSync(file, "utf8"), file);
  const { frontmatter, body } = parsed;
  const clean = site.markdown.html === "allow" ? parsed.html : await sanitizeHtml(parsed.html);
  const content = enhanceImages(clean, path.join(root, "public"));
  const { layout, schema } = await resolveLayout(root, frontmatter.layout, load, file);
  if (schema) Object.assign(frontmatter, validateLayoutFields(frontmatter, schema, frontmatter.layout ?? "default", file));
  const meta = pageMeta(site, route, frontmatter, options.notFound);
  const result = await layout({
    content,
    page: { route, title: frontmatter.title, description: frontmatter.description, url: meta.canonical, frontmatter },
    site,
    pages: options.pages ?? [],
  });
  const html = isSafeHtml(result) ? result.value : result;
  if (typeof html !== "string") {
    throw new VageError(`Layout "${frontmatter.layout ?? "default"}" must return an HTML string or html\`...\`.`, file);
  }
  let out = injectHead(html, headTags(site, meta), file);
  const tags = options.analytics ? analyticsTags(site) : undefined;
  if (tags) out = injectAnalytics(out, tags, file);
  return { html: out, frontmatter, body, meta };
}

const LAYOUT_EXTENSIONS = [".ts", ".js", ".mjs"];

/** A Zod schema a layout can export as `frontmatter` to declare its own fields. */
type FieldSchema = { safeParse: (data: unknown) => { success: boolean; data?: unknown; error?: unknown }; strict?: () => FieldSchema };

async function resolveLayout(
  root: string,
  name: string | undefined,
  load: ModuleLoader,
  pageFile: string,
): Promise<{ layout: Layout; schema?: FieldSchema }> {
  const base = path.join(root, "src", "layouts", name ?? "default");
  const file = LAYOUT_EXTENSIONS.map((ext) => base + ext).find((f) => fs.existsSync(f));
  if (!file) {
    if (!name) return { layout: defaultLayout };
    throw new VageError(`Layout "${name}" not found. Expected src/layouts/${name}.ts`, pageFile);
  }
  const mod = await load(file);
  const layout = mod.default;
  if (typeof layout !== "function") {
    throw new VageError("Layout files must default-export a function that returns an HTML string.", file);
  }
  const schema = mod.frontmatter as FieldSchema | undefined;
  if (schema !== undefined && typeof schema?.safeParse !== "function") {
    throw new VageError('`export const frontmatter` in a layout must be a Zod object schema: z.object({ ... }) (import { z } from "vagejs").', file);
  }
  return { layout: layout as Layout, schema };
}

const BUILT_IN_FIELDS = new Set(Object.keys(frontmatterSchema.shape));

/**
 * Checks the fields a page adds for its layout against the layout's schema. Unknown
 * fields are errors (a typo would otherwise do nothing); defaults are filled in.
 */
function validateLayoutFields(frontmatter: Frontmatter, schema: FieldSchema, layoutName: string, file: string): Record<string, unknown> {
  const own = Object.fromEntries(Object.entries(frontmatter).filter(([k]) => !BUILT_IN_FIELDS.has(k)));
  const result = (schema.strict ? schema.strict() : schema).safeParse(own);
  if (!result.success) {
    const detail = result.error instanceof z.ZodError ? z.prettifyError(result.error) : String(result.error);
    throw new VageError(`Frontmatter doesn't match the "${layoutName}" layout's fields:\n${detail}`, file);
  }
  return result.data as Record<string, unknown>;
}

/** Used when a project has no src/layouts/default.ts. */
export const defaultLayout: Layout = ({ content, page, site }) => {
  const title = site.title && site.title !== page.title ? `${page.title} | ${site.title}` : page.title;
  return `<!doctype html>
<html lang="${escapeHtml(site.lang)}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    <main>
${content}
    </main>
  </body>
</html>
`;
};
