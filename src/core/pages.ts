import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, type Frontmatter } from "../content/markdown.js";
import { pageMeta } from "../seo/head.js";
import type { SiteConfig } from "./config.js";
import { VageError } from "./errors.js";
import { discoverRoutes } from "./routes.js";

/** One published page, as layouts see it in `props.pages`. */
export interface PageSummary {
  /** URL path with a trailing slash, e.g. "/blog/first-post/". */
  route: string;
  /** Absolute canonical URL, when `site` is set and the page is indexable. */
  url?: string;
  title: string;
  description?: string;
  /** Source path relative to the project root, e.g. "src/pages/blog/first-post.md". */
  source: string;
  frontmatter: Frontmatter;
}

/**
 * Every published page (drafts and 404.md excluded), sorted by route. Reads frontmatter only.
 * `skipInvalid` (dev server) leaves out pages whose frontmatter doesn't parse, so one broken
 * page shows its own error instead of breaking every page that lists others.
 */
export function collectPages(root: string, site: SiteConfig, options: { skipInvalid?: boolean } = {}): PageSummary[] {
  const pagesDir = path.join(root, "src", "pages");
  const out: PageSummary[] = [];
  for (const entry of discoverRoutes(pagesDir)) {
    let frontmatter: Frontmatter;
    try {
      ({ frontmatter } = parseFrontmatter(fs.readFileSync(entry.file, "utf8"), entry.file));
    } catch (err) {
      if (options.skipInvalid && err instanceof VageError) continue;
      throw err;
    }
    if (frontmatter.draft) continue;
    out.push({
      route: entry.route,
      url: pageMeta(site, entry.route, frontmatter).canonical,
      title: frontmatter.title,
      description: frontmatter.description,
      source: path.relative(root, entry.file),
      frontmatter,
    });
  }
  return out;
}

export interface CollectionOptions {
  /** Only pages below this route, e.g. "/blog/". The section's own index page is left out unless `includeIndex`. */
  under?: string;
  includeIndex?: boolean;
  /**
   * "date": newest `datePublished` first (undated pages last, then by title).
   * "title": A to Z. "route" (default): by URL. Or a compare function.
   */
  sort?: "date" | "title" | "route" | ((a: PageSummary, b: PageSummary) => number);
  limit?: number;
}

/**
 * Picks and orders pages for lists such as a blog index, a sidebar or "latest posts":
 *   collection(pages, { under: "/blog/", sort: "date", limit: 5 })
 */
export function collection(pages: readonly PageSummary[], options: CollectionOptions = {}): PageSummary[] {
  const { under, includeIndex = false, sort = "route", limit } = options;
  const prefix = under ? (under.endsWith("/") ? under : `${under}/`) : undefined;
  const picked = pages.filter((p) => !prefix || (p.route.startsWith(prefix) && (includeIndex || p.route !== prefix)));
  const byTitle = (a: PageSummary, b: PageSummary) => a.title.localeCompare(b.title);
  const compare =
    typeof sort === "function"
      ? sort
      : sort === "title"
        ? byTitle
        : sort === "date"
          ? (a: PageSummary, b: PageSummary) => {
              const da = a.frontmatter.datePublished ?? "";
              const db = b.frontmatter.datePublished ?? "";
              if (da !== db) return da && db ? db.localeCompare(da) : da ? -1 : 1;
              return byTitle(a, b);
            }
          : (a: PageSummary, b: PageSummary) => a.route.localeCompare(b.route);
  const sorted = [...picked].sort(compare);
  return limit === undefined ? sorted : sorted.slice(0, limit);
}
