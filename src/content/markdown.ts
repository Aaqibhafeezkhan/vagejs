import { Marked } from "marked";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { VageError } from "../core/errors.js";

// YAML may produce Date objects for unquoted timestamps; normalize to ISO strings.
const isoDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.union([z.iso.date(), z.iso.datetime({ offset: true })], { error: "must be an ISO date (2026-01-31) or datetime" }),
);

// Single line, no control characters: these values end up in <title>, meta tags and llms.txt lines.
const singleLine = z.string().regex(/^[^\u0000-\u001f\u007f]*$/, "must be a single line without control characters");
// A site path ("/x", not "//host") or an absolute http(s) URL.
const pathOrUrl = /^(\/(?!\/)|https?:\/\/)/;

export const frontmatterSchema = z.looseObject({
  title: singleLine.min(1, "title is required").describe("Page title. Required; never invented."),
  description: singleLine.min(1).optional().describe("Meta description, og:description and llms.txt summary."),
  draft: z.boolean().default(false).describe("Skipped in builds; still visible in dev."),
  layout: z
    .string()
    .regex(/^[\w-]+$/, "layout must be a file name without extension")
    .optional()
    .describe("Loads src/layouts/<layout>.ts. Defaults to 'default'."),
  noindex: z.boolean().default(false).describe("Adds robots noindex; excludes the page from sitemap.xml and llms.txt."),
  canonical: z
    .string()
    .regex(pathOrUrl, 'must be a site path starting with a single "/" or an http(s) URL')
    .optional()
    .describe("Canonical URL override (site path or absolute URL). Defaults to the page's own URL."),
  image: z.string().regex(pathOrUrl, 'must be a site path starting with a single "/" or an http(s) URL').optional().describe("Social preview image: site path (e.g. /images/og.png) or absolute URL."),
  type: z.enum(["website", "article"]).default("website").describe('"article" emits og:type=article and Article JSON-LD.'),
  author: singleLine.min(1).optional().describe("Article author name. Only use a real author."),
  datePublished: isoDate.optional().describe("ISO date or datetime. Only use a real date."),
  dateModified: isoDate.optional().describe("ISO date or datetime; also the sitemap <lastmod>."),
  order: z.number().finite().optional().describe('Position in navigation lists (lower first). Used by collection(pages, { sort: "order" }) and tree().'),
  navTitle: singleLine.min(1).optional().describe("Shorter title for menus and breadcrumbs. Defaults to the title."),
  translationOf: z
    .string()
    .regex(/^\/(?!\/)[^?#]*$/, 'must be a page address like "/about/"')
    .optional()
    .describe("Multi-language sites (i18n): the main-language page this page translates, when its address differs, e.g. translationOf: /about/ on fr/a-propos.md."),
  tags: z
    .array(singleLine.regex(/[\p{L}\p{N}]/u, "each tag needs a letter or digit (it becomes the address /tags/<tag>/)"))
    .optional()
    .describe('Topics, e.g. [SEO, AI]. Each tag gets a page at /tags/<tag>/ listing its pages (tags.pages); collection(pages, { tag: "SEO" }) picks them.'),
});

export type Frontmatter = z.output<typeof frontmatterSchema>;

export interface MarkdownPage {
  frontmatter: Frontmatter;
  /** Markdown body without frontmatter. */
  body: string;
  /** Rendered HTML of the Markdown body. */
  html: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const marked = new Marked({ gfm: true });

export function parseMarkdown(source: string, file: string): MarkdownPage {
  const { frontmatter, body } = parseFrontmatter(source, file);
  return { frontmatter, body, html: marked.parse(body, { async: false }) };
}

/** Frontmatter and Markdown body, without rendering HTML (cheap enough to run on every page). */
export function parseFrontmatter(source: string, file: string): Omit<MarkdownPage, "html"> {
  const match = FRONTMATTER_RE.exec(source);
  let data: unknown = {};
  if (match) {
    try {
      data = parseYaml(match[1] ?? "") ?? {};
    } catch (err) {
      const hint = quoteHint(err, match[1] ?? "");
      throw new VageError(hint ?? `Invalid YAML frontmatter: ${(err as Error).message}`, file);
    }
  }
  const result = frontmatterSchema.safeParse(data);
  if (!result.success) {
    throw new VageError(`Invalid frontmatter:\n${z.prettifyError(result.error)}`, file);
  }
  const body = match ? source.slice(match[0].length) : source;
  return { frontmatter: result.data, body };
}

/** The usual cause of "Nested mappings…": a value with ": " in it, which YAML reads as another key. */
function quoteHint(err: unknown, yaml: string): string | undefined {
  const line = (err as { linePos?: { line: number }[] }).linePos?.[0]?.line;
  if (!/Nested mappings are not allowed/.test((err as Error).message) || !line) return undefined;
  const m = /^(\s*)([\w-]+):\s*(.*?\S)(\s+#.*)?\s*$/.exec(yaml.split(/\r?\n/)[line - 1] ?? "");
  if (!m) return undefined;
  // Line numbers count from the file's first line, which is the opening "---".
  return `Invalid YAML frontmatter on line ${line + 1}: the value of "${m[2]}" contains ": ", so YAML reads it as another key. Wrap the value in quotes:\n  ${m[2]}: ${JSON.stringify(m[3])}${m[4] ?? ""}`;
}
