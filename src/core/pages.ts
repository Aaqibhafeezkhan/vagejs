import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter, type Frontmatter } from "../content/markdown.js";
import { pageMeta } from "../seo/head.js";
import type { ModuleLoader, SiteConfig } from "./config.js";
import { clonePlain } from "./clone.js";
import { applyLayoutFields } from "./render.js";
import { VageError } from "./errors.js";
import { discoverRoutes } from "./routes.js";

/** One published page, as layouts see it in `props.pages`. */
export interface PageSummary {
  /** URL path with a trailing slash, e.g. "/blog/first-post/". */
  route: string;
  /** Absolute canonical URL, when `site` is set and the page is indexable. */
  url?: string;
  title: string;
  /** Menu and breadcrumb text: `navTitle`, or the title. */
  label: string;
  description?: string;
  /** Source path relative to the project root, e.g. "src/pages/blog/first-post.md". */
  source: string;
  frontmatter: Frontmatter;
}

/**
 * Every published page (drafts and 404.md excluded), sorted by route. Reads frontmatter
 * and applies each page's layout schema, so list entries get the same defaults as the
 * page itself. The result is frozen: layouts share it, so none may change it.
 * `skipInvalid` (dev server, `vage check`) leaves out pages whose frontmatter is invalid;
 * they report their own error instead of breaking every page that lists others.
 */
export async function collectPages(root: string, site: SiteConfig, load: ModuleLoader, options: { skipInvalid?: boolean } = {}): Promise<readonly PageSummary[]> {
  const pagesDir = path.join(root, "src", "pages");
  const out: PageSummary[] = [];
  for (const entry of discoverRoutes(pagesDir)) {
    let frontmatter: Frontmatter;
    try {
      ({ frontmatter } = parseFrontmatter(fs.readFileSync(entry.file, "utf8"), entry.file));
      if (frontmatter.draft) continue;
      await applyLayoutFields(root, frontmatter, load, entry.file);
    } catch (err) {
      // Any failure (bad frontmatter, a layout that throws or doesn't compile) is that page's own error.
      if (options.skipInvalid) continue;
      throw err;
    }
    out.push({
      route: entry.route,
      url: pageMeta(site, entry.route, frontmatter).canonical,
      title: frontmatter.title,
      label: frontmatter.navTitle ?? frontmatter.title,
      description: frontmatter.description,
      source: path.relative(root, entry.file),
      frontmatter,
    });
  }
  // A frozen deep copy: shared by every layout, and never the objects a page renders with.
  return deepFreeze(clonePlain(out));
}

/** Freezes plain data only; URL/Date/class instances from schema transforms stay usable. */
function deepFreeze<T>(value: T): T {
  const plain = Array.isArray(value) || (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)));
  if (plain && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const SORTS = ["date", "title", "route", "order"];

export interface CollectionOptions {
  /** Only pages below this route, e.g. "/blog/". The section's own index page is left out unless `includeIndex`. */
  under?: string;
  includeIndex?: boolean;
  /**
   * "date": newest `datePublished` first (undated pages last, then by title).
   * "order": by the `order` field, lowest first (pages without one last, then by title).
   * "title": A to Z. "route" (default): by URL. Or a compare function.
   */
  sort?: "date" | "title" | "route" | "order" | ((a: PageSummary, b: PageSummary) => number);
  limit?: number;
}

/**
 * Picks and orders pages for lists such as a blog index, a sidebar or "latest posts":
 *   collection(pages, { under: "/blog/", sort: "date", limit: 5 })
 */
/** By `order` (lowest first; pages without one last), then title. */
export function byOrder(a: PageSummary, b: PageSummary): number {
  const oa = a.frontmatter.order;
  const ob = b.frontmatter.order;
  if (oa !== ob) return oa === undefined ? 1 : ob === undefined ? -1 : oa - ob;
  return a.title.localeCompare(b.title);
}

export function collection(pages: readonly PageSummary[], options: CollectionOptions = {}): PageSummary[] {
  if (!Array.isArray(pages)) throw new VageError("collection(): pass the layout's `pages` as the first argument.");
  const { under, includeIndex = false, sort = "route", limit } = options;
  if (under !== undefined && !/^\/(?!\/)/.test(under)) {
    throw new VageError(`collection(): "under" must be a site path starting with "/", like "/blog/" (got ${JSON.stringify(under)}).`);
  }
  if (typeof sort !== "function" && !SORTS.includes(sort)) {
    throw new VageError(`collection(): "sort" must be "date", "order", "title", "route" or a compare function (got ${JSON.stringify(sort)}).`);
  }
  if (typeof includeIndex !== "boolean") throw new VageError(`collection(): "includeIndex" must be true or false (got ${JSON.stringify(includeIndex)}).`);
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
    throw new VageError(`collection(): "limit" must be a whole number of 0 or more (got ${JSON.stringify(limit)}).`);
  }
  const prefix = under ? (under.endsWith("/") ? under : `${under}/`) : undefined;
  const picked = pages.filter((p) => !prefix || (p.route.startsWith(prefix) && (includeIndex || p.route !== prefix)));
  const byTitle = (a: PageSummary, b: PageSummary) => a.title.localeCompare(b.title);
  const compare =
    typeof sort === "function"
      ? sort
      : sort === "title"
        ? byTitle
        : sort === "order"
          ? byOrder
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

/** The pages before and after `route` in an ordered list (e.g. from collection()), for "Previous / Next" links. */
export function neighbors(list: readonly PageSummary[], route: string): { prev?: PageSummary; next?: PageSummary } {
  const i = list.findIndex((p) => p.route === route);
  if (i === -1) return {};
  return { prev: list[i - 1], next: list[i + 1] };
}

/**
 * The trail from the home page to `route`, using the pages that exist at each level:
 * /docs/guides/setup/ -> [Home, Docs, Guides, Setup] (missing levels are skipped).
 */
export function breadcrumbs(pages: readonly PageSummary[], route: string): PageSummary[] {
  const byRoute = new Map(pages.map((p) => [p.route, p]));
  const parts = route.split("/").filter(Boolean);
  const trail: PageSummary[] = [];
  for (let i = 0; i <= parts.length; i++) {
    const r = i === 0 ? "/" : `/${parts.slice(0, i).join("/")}/`;
    const page = byRoute.get(r);
    if (page) trail.push(page);
  }
  return trail;
}

export interface TreeNode {
  page: PageSummary;
  children: TreeNode[];
}

/**
 * Pages under `under` as a nested tree (folders become levels), each level sorted by
 * `order`, then title: ready for a sidebar. A folder without its own index page is
 * skipped; its pages move up a level.
 */
export function tree(pages: readonly PageSummary[], under = "/"): TreeNode[] {
  if (!/^\/(?!\/)/.test(under)) throw new VageError(`tree(): "under" must be a site path starting with "/" (got ${JSON.stringify(under)}).`);
  const prefix = under.endsWith("/") ? under : `${under}/`;
  const inside = pages.filter((p) => p.route.startsWith(prefix) && p.route !== prefix);
  const routes = new Set(inside.map((p) => p.route));
  const parentOf = (route: string): string | undefined => {
    const parts = route.split("/").filter(Boolean);
    for (let i = parts.length - 1; i > 0; i--) {
      const r = `/${parts.slice(0, i).join("/")}/`;
      if (r.length <= prefix.length) return undefined;
      if (routes.has(r)) return r;
    }
    return undefined;
  };
  const nodes = new Map(inside.map((p) => [p.route, { page: p, children: [] as TreeNode[] }]));
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf(node.page.route);
    (parent ? nodes.get(parent)!.children : roots).push(node);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => byOrder(a.page, b.page));
    for (const n of list) sort(n.children);
    return list;
  };
  return sort(roots);
}

/** A tree() in sidebar reading order (each page, then its children), for neighbors() in nested docs. */
export function flatten(nodes: readonly TreeNode[]): PageSummary[] {
  return nodes.flatMap((n) => [n.page, ...flatten(n.children)]);
}
