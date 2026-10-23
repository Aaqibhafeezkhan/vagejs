import fs from "node:fs";
import path from "node:path";
import { VageError } from "./errors.js";

export interface RouteEntry {
  /** URL path, always with a trailing slash, e.g. "/blog/first-post/". */
  route: string;
  /** Absolute path of the source file. */
  file: string;
  /** Output path relative to the build directory, e.g. "blog/first-post/index.html". */
  outFile: string;
}

export const NOT_FOUND_PAGE = "404.md";

/**
 * Maps src/pages/**\/*.md to routes:
 *   index.md       -> /
 *   about.md       -> /about/
 *   blog/index.md  -> /blog/
 *   blog/post.md   -> /blog/post/
 * Files and directories starting with "_" are ignored. The top-level 404.md is
 * not a route; use findNotFoundPage() for it.
 */
export function discoverRoutes(pagesDir: string): RouteEntry[] {
  if (!fs.existsSync(pagesDir)) return [];
  const routes = new Map<string, RouteEntry>();

  for (const rel of walk(pagesDir)) {
    if (rel === NOT_FOUND_PAGE) continue;
    const segments = routeSegments(rel);
    const route = segments.length ? `/${segments.join("/")}/` : "/";
    const file = path.join(pagesDir, rel);

    const existing = routes.get(route);
    if (existing) {
      throw new VageError(
        `Two pages map to the route "${route}": ${path.relative(pagesDir, existing.file)} and ${rel}. Remove or rename one of them.`,
        file,
      );
    }
    routes.set(route, { route, file, outFile: path.posix.join(...segments, "index.html") });
  }

  return [...routes.values()].sort((a, b) => a.route.localeCompare(b.route));
}

function routeSegments(rel: string): string[] {
  const segments = rel.slice(0, -".md".length).split("/");
  if (segments.at(-1) === "index") segments.pop();
  return segments;
}

/** Route for a page path relative to src/pages (works for deleted files too). */
export function routeForPage(rel: string): string | undefined {
  if (!rel.endsWith(".md") || rel === NOT_FOUND_PAGE || rel.split("/").some((s) => s.startsWith("_") || s.startsWith("."))) return undefined;
  const segments = routeSegments(rel);
  return segments.length ? `/${segments.join("/")}/` : "/";
}

export function findNotFoundPage(pagesDir: string): string | undefined {
  const file = path.join(pagesDir, NOT_FOUND_PAGE);
  return fs.existsSync(file) ? file : undefined;
}

/** Normalizes a request path ("/about", "/about/index.html") to a route key ("/about/"). */
export function normalizeRequestPath(urlPath: string): string {
  let p = decodeURIComponent(urlPath.split(/[?#]/)[0] ?? "/");
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  else if (p.endsWith(".html")) p = p.slice(0, -".html".length);
  return p.endsWith("/") ? p : `${p}/`;
}

function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}
