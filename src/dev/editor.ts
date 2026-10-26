import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { parseDocument } from "yaml";
import { z } from "zod";
import { check } from "../checks/check.js";
import { createPage, slugify } from "../cli/new.js";
import { frontmatterSchema, parseFrontmatter } from "../content/markdown.js";
import { loadConfig, type ModuleLoader, type SiteConfig } from "../core/config.js";
import { scheduledFor } from "../core/dates.js";
import { VageError } from "../core/errors.js";
import { viteLoader } from "../core/loader.js";
import { collectPages } from "../core/pages.js";
import { applyLayoutFields, renderPage, resolveLayout } from "../core/render.js";
import { discoverRoutes, findNotFoundPage, publicPath } from "../core/routes.js";

/**
 * The local editor at /_vage/edit/ in `vage dev`: a list of pages, a form for each page's
 * frontmatter (built from the built-in fields and the layout's own), the Markdown text with
 * a live preview, image upload, and the page's `vage check` findings. It edits the project's
 * files and nothing else, and only exists in the dev server, never in a build.
 *
 * Safety: it runs only when the dev server listens on this computer (not with --host); every
 * request must name a loopback host (no DNS rebinding); API calls need the per-server key
 * from the editor page, which other websites can't read, and must come from the same origin.
 * Writes go only to existing pages in src/pages, new pages via `vage new`, and public/images/.
 */
export const EDITOR_PATH = "/_vage/edit/";

const UI_DIR = fileURLToPath(new URL("../../editor/", import.meta.url));
const UI_FILES: Record<string, string> = { "editor.js": "text/javascript; charset=utf-8", "editor.css": "text/css; charset=utf-8" };
// The same pattern parseFrontmatter uses.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const IMAGE_TYPES = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif"]);
const MAX_JSON = 2 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;

/** The editor runs only on a server that listens on this computer. */
export function editorEnabled(host: string | boolean | undefined): boolean {
  return host === undefined || host === false || (typeof host === "string" && isLoopback(host));
}

function isLoopback(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** The host name from a Host header: "localhost:5173" -> "localhost", "[::1]:5173" -> "::1". */
function hostName(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    return new URL(`http://${header}`).hostname;
  } catch {
    return undefined;
  }
}

export function editorPlugin(root: string, enabled: boolean): Plugin {
  const token = crypto.randomBytes(24).toString("hex");
  return {
    name: "vage:editor",
    configureServer(server) {
      const load = viteLoader(server);
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? "/").split(/[?#]/)[0]!;
        if (pathname !== "/_vage/edit" && !pathname.startsWith(EDITOR_PATH)) return next();
        if (!enabled) return send(res, 404, "text/plain", "The editor only runs when the dev server listens on this computer: start it without --host.");
        const host = hostName(req.headers.host);
        if (!host || !isLoopback(host)) return send(res, 403, "text/plain", "Open the editor at localhost.");
        if (pathname === "/_vage/edit") return redirectTo(res, EDITOR_PATH);
        if (pathname === EDITOR_PATH && req.method === "GET") {
          const page = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8").replace("%TOKEN%", token);
          res.setHeader("Cache-Control", "no-store");
          return send(res, 200, "text/html; charset=utf-8", page);
        }
        const asset = pathname.slice(EDITOR_PATH.length);
        if (UI_FILES[asset] && req.method === "GET") {
          res.setHeader("Cache-Control", "no-cache"); // a vagejs update brings a new editor
          return send(res, 200, UI_FILES[asset]!, fs.readFileSync(path.join(UI_DIR, asset)));
        }
        if (!pathname.startsWith(`${EDITOR_PATH}api/`)) return send(res, 404, "text/plain", "Not found");
        if (!validKey(req.headers["x-vage-token"], token) || !sameOrigin(req)) return json(res, 403, { error: "This request didn't come from the editor page. Reload the editor." });
        try {
          await api(root, load, req, res, pathname.slice(`${EDITOR_PATH}api/`.length));
        } catch (err) {
          if (err instanceof VageError) return json(res, 400, { error: err.detail });
          server.config.logger.error((err as Error).stack ?? String(err));
          json(res, 500, { error: (err as Error).message });
        }
      });
    },
  };
}

function validKey(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== "string" || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/** Browsers send Origin on POST/PUT and Sec-Fetch-Site on all requests; both must say "this site". */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  return origin === undefined || origin === `http://${req.headers.host}`;
}

async function api(root: string, load: ModuleLoader, req: IncomingMessage, res: ServerResponse, action: string) {
  const query = new URL(req.url ?? "/", "http://x").searchParams;
  const site = await loadConfig(root, load);
  const method = req.method ?? "GET";
  if (action === "pages" && method === "GET") return json(res, 200, { site: site.title ?? "", pages: listPages(root, site) });
  if (action === "page" && method === "GET") return json(res, 200, await readPage(root, site, load, query.get("source")));
  if (action === "schema" && method === "GET") return json(res, 200, { fields: await fields(root, load, query.get("layout") || undefined) });
  if (action === "page" && method === "PUT") {
    const { source, data, body } = await readJson(req);
    const { file, text } = compose(root, site, source, data, body);
    await validate(root, load, file, text);
    fs.writeFileSync(file, text);
    return json(res, 200, { ok: true });
  }
  if (action === "preview" && method === "POST") {
    const { source, data, body } = await readJson(req);
    const { file, route, text } = compose(root, site, source, data, body);
    const pages = await collectPages(root, site, load, { skipInvalid: true });
    const page = await renderPage({ root, file, route: route ?? "/404/", notFound: route === undefined, site, load, pages, source: text });
    return send(res, 200, "text/html; charset=utf-8", page.html);
  }
  if (action === "findings" && method === "GET") {
    const { file } = pageFile(root, site, query.get("source"));
    const rel = path.relative(root, file);
    const result = await check(root);
    // Site settings too: e.g. making a page a draft breaks a menu entry that points to it.
    return json(res, 200, { findings: result.findings.filter((f) => f.source === rel), site: result.findings.filter((f) => f.source === "vage.config.ts") });
  }
  if (action === "new" && method === "POST") {
    const { kind, name, title } = await readJson(req);
    if (kind !== "page" && kind !== "post") throw new VageError('kind must be "page" or "post".');
    if (typeof name !== "string") throw new VageError("Give the new page a name.");
    const created = createPage(root, kind, name, kind === "page" && typeof title === "string" && title.trim() ? { title } : {});
    return json(res, 200, { source: created.file.split(path.sep).join("/") });
  }
  if (action === "image" && method === "POST") return json(res, 200, saveImage(root, query.get("name"), await readBody(req, MAX_IMAGE)));
  json(res, 404, { error: `Unknown editor request: ${method} ${action}` });
}

type PageStatus = "published" | "draft" | "scheduled" | "error";

/** Every page in src/pages (drafts and scheduled pages too), as the editor lists them. */
function listPages(root: string, site: SiteConfig) {
  const pagesDir = path.join(root, "src", "pages");
  const files = discoverRoutes(pagesDir, site.trailingSlash).map((e) => ({ file: e.file, route: publicPath(e.route, site.trailingSlash) as string | null }));
  const notFound = findNotFoundPage(pagesDir);
  if (notFound) files.push({ file: notFound, route: null });
  return files.map(({ file, route }) => {
    const source = path.relative(root, file).split(path.sep).join("/");
    try {
      const { frontmatter } = parseFrontmatter(fs.readFileSync(file, "utf8"), file);
      const scheduled = scheduledFor(frontmatter.datePublished);
      const status: PageStatus = frontmatter.draft ? "draft" : scheduled ? "scheduled" : "published";
      return { source, route, title: frontmatter.title, status, date: frontmatter.datePublished ?? null };
    } catch (err) {
      return { source, route, title: source, status: "error" as PageStatus, date: null, error: err instanceof VageError ? err.detail : String(err) };
    }
  });
}

/** Resolves an editor `source` ("src/pages/about.md") to a page file, refusing anything else. */
function pageFile(root: string, site: SiteConfig, source: unknown): { file: string; route?: string } {
  if (typeof source !== "string" || !source.endsWith(".md")) throw new VageError("Pick a page from src/pages.");
  const pagesDir = path.join(root, "src", "pages");
  const file = path.resolve(root, source);
  const entry = discoverRoutes(pagesDir, site.trailingSlash).find((e) => path.resolve(e.file) === file);
  const notFound = findNotFoundPage(pagesDir);
  if (!entry && !(notFound && path.resolve(notFound) === file)) throw new VageError(`${source} isn't a page in src/pages.`);
  // No symlinks: a linked file or folder can point outside the project.
  const realPages = fs.realpathSync(pagesDir);
  if (!fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(realPages + path.sep)) throw new VageError(`${source} leads outside src/pages (a symlink?). Edit it in your text editor.`);
  return { file, route: entry?.route };
}

function split(text: string): { yaml: string; body: string } {
  const match = FRONTMATTER_RE.exec(text);
  return match ? { yaml: match[1] ?? "", body: text.slice(match[0].length) } : { yaml: "", body: text };
}

async function readPage(root: string, site: SiteConfig, load: ModuleLoader, source: unknown) {
  const { file, route } = pageFile(root, site, source);
  const { yaml, body } = split(fs.readFileSync(file, "utf8"));
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new VageError(`The frontmatter (the part between the --- lines) can't be read, so fix it in your text editor first:\n${doc.errors[0]!.message}`);
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (typeof data !== "object" || Array.isArray(data)) throw new VageError("The frontmatter must be a list of fields (key: value). Fix it in your text editor first.");
  return {
    source,
    route: route ? publicPath(route, site.trailingSlash) : null,
    data,
    body,
    fields: await fields(root, load, typeof data.layout === "string" ? data.layout : undefined),
    layouts: layoutNames(root),
  };
}

/**
 * The page file with the edited frontmatter. Comments and field order stay, and only changed,
 * added and removed fields get new values (the yaml library may tidy spacing on other lines).
 */
function compose(root: string, site: SiteConfig, source: unknown, data: unknown, body: unknown): { file: string; route?: string; text: string } {
  const { file, route } = pageFile(root, site, source);
  if (!data || typeof data !== "object" || Array.isArray(data) || typeof body !== "string") throw new VageError("Send the page's fields and text.");
  const original = fs.readFileSync(file, "utf8");
  const doc = parseDocument(split(original).yaml);
  if (doc.errors.length) throw new VageError(`The frontmatter can't be read: ${doc.errors[0]!.message}`);
  const before = (doc.toJS() ?? {}) as Record<string, unknown>;
  const after = data as Record<string, unknown>;
  for (const key of Object.keys(before)) if (!(key in after) || empty(after[key])) doc.delete(key);
  for (const [key, value] of Object.entries(after)) {
    if (!empty(value) && JSON.stringify(before[key]) !== JSON.stringify(value)) doc.set(key, value);
  }
  const crlf = original.includes("\r\n");
  const yaml = Object.keys(doc.toJS() ?? {}).length ? doc.toString() : "";
  let text = `---\n${yaml}---\n${body.replace(/\r\n/g, "\n")}`;
  if (crlf) text = text.replace(/\n/g, "\r\n");
  return { file, route, text };
}

const empty = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** Checks the page the way the build does (built-in fields, then the layout's); throws with the problem. */
async function validate(root: string, load: ModuleLoader, file: string, text: string) {
  const { frontmatter } = parseFrontmatter(text, path.relative(root, file));
  await applyLayoutFields(root, frontmatter, load, path.relative(root, file));
}

function layoutNames(root: string): string[] {
  const dir = path.join(root, "src", "layouts");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^[\w-]+\.(ts|js|mjs)$/.test(f))
    .map((f) => f.replace(/\.\w+$/, ""))
    .sort();
}

export interface EditorField {
  key: string;
  label: string;
  help?: string;
  kind: "text" | "textarea" | "date" | "checkbox" | "number" | "select" | "list" | "json";
  required: boolean;
  options?: string[];
  /** The value used when the field is left out. */
  default?: unknown;
  /** "main" fields show first; "more" are the rarely needed built-in ones; "layout" come from the page's layout. */
  group: "main" | "more" | "layout";
}

/** Built-in fields in the order and words the editor shows them. */
const BUILT_IN: Record<string, { label: string; help: string; group: "main" | "more"; kind?: EditorField["kind"] }> = {
  title: { label: "Title", help: "The page's name, shown in search results and browser tabs.", group: "main" },
  description: { label: "Description", help: "One or two sentences for search results and link previews.", group: "main", kind: "textarea" },
  draft: { label: "Draft", help: "Drafts show here and in the dev server, but aren't published.", group: "main" },
  datePublished: { label: "Date published", help: "YYYY-MM-DD. A future date publishes the page on that day.", group: "main", kind: "date" },
  author: { label: "Author", help: "A real person's name.", group: "main" },
  tags: { label: "Tags", help: "Topics, separated by commas. Each tag gets its own page.", group: "main" },
  layout: { label: "Layout", help: "The design this page uses. Empty: the default layout.", group: "more" },
  type: { label: "Type", help: '"article" for blog posts and news.', group: "more" },
  dateModified: { label: "Date updated", help: "YYYY-MM-DD, when the page last changed in a meaningful way.", group: "more", kind: "date" },
  image: { label: "Share image", help: "Shown when the page is shared, e.g. /images/cover.png.", group: "more" },
  navTitle: { label: "Menu title", help: "A shorter name for menus and breadcrumbs.", group: "more" },
  order: { label: "Order", help: "Position in menus and sidebars (lower first).", group: "more" },
  noindex: { label: "Hide from search engines", help: "The page stays published but asks search engines not to list it.", group: "more" },
  canonical: { label: "Canonical address", help: "Only when this page copies another: that page's address.", group: "more" },
};

type JsonSchema = { type?: string | string[]; enum?: unknown[]; items?: JsonSchema; description?: string; default?: unknown; properties?: Record<string, JsonSchema>; required?: string[] };

const toJson = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;

/** The form fields for a page using `layout`: the built-in ones, then the layout's own. */
async function fields(root: string, load: ModuleLoader, layout: string | undefined): Promise<EditorField[]> {
  const builtIn = toJson(frontmatterSchema);
  const out: EditorField[] = [];
  for (const [key, meta] of Object.entries(BUILT_IN)) {
    const prop = builtIn.properties?.[key] ?? {};
    out.push({
      key,
      label: meta.label,
      help: meta.help,
      kind: key === "layout" ? "select" : (meta.kind ?? kindOf(prop)),
      required: key === "title",
      options: key === "layout" ? layoutNames(root) : prop.enum?.map(String),
      default: prop.default,
      group: meta.group,
    });
  }
  let schema: unknown;
  try {
    ({ schema } = await resolveLayout(root, layout, load, path.join(root, "src", "pages")));
  } catch {
    return out; // A missing or broken layout is reported on save and in the findings.
  }
  if (!schema) return out;
  let own: JsonSchema;
  try {
    own = toJson(schema as z.ZodType);
  } catch {
    return out;
  }
  const required = new Set(own.required ?? []);
  for (const [key, prop] of Object.entries(own.properties ?? {})) {
    const known = out.find((f) => f.key === key);
    if (known) {
      // A layout may make a built-in field required or narrow its choices.
      known.required ||= required.has(key) && prop.default === undefined;
      if (prop.enum) known.options = prop.enum.map(String);
      continue;
    }
    out.push({ key, label: humanize(key), help: prop.description, kind: kindOf(prop), required: required.has(key) && prop.default === undefined, options: prop.enum?.map(String), default: prop.default, group: "layout" });
  }
  return out;
}

function kindOf(prop: JsonSchema): EditorField["kind"] {
  if (prop.enum) return "select";
  const type = Array.isArray(prop.type) ? prop.type.find((t) => t !== "null") : prop.type;
  if (type === "boolean") return "checkbox";
  if (type === "number" || type === "integer") return "number";
  if (type === "string") return "text";
  if (type === "array" && prop.items?.type === "string" && !prop.items.enum) return "list";
  return "json";
}

/** "ctaLabel" -> "Cta label" */
const humanize = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());

function saveImage(root: string, name: string | null, data: Buffer): { path: string } {
  const ext = path.extname(name ?? "").toLowerCase();
  if (!IMAGE_TYPES.has(ext)) throw new VageError("Add a PNG, JPEG, WebP, AVIF or GIF image.");
  if (!data.length) throw new VageError("The image is empty.");
  const base = slugify(path.basename(name!, path.extname(name!))) || "image";
  const publicDir = path.join(root, "public");
  const dir = path.join(publicDir, "images");
  fs.mkdirSync(dir, { recursive: true });
  // public/images must really be inside public/ (no symlinks out of the project).
  if (!fs.realpathSync(dir).startsWith(fs.realpathSync(publicDir) + path.sep)) throw new VageError("public/images leads outside public/ (a symlink?).");
  for (let n = 1; ; n++) {
    const fileName = `${base}${n === 1 ? "" : `-${n}`}${ext === ".jpeg" ? ".jpg" : ext}`;
    try {
      fs.writeFileSync(path.join(dir, fileName), data, { flag: "wx" });
      return { path: `/images/${fileName}` };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new VageError(`That's too large (the limit is ${Math.round(limit / 1024 / 1024)} MB).`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse((await readBody(req, MAX_JSON)).toString("utf8")) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof VageError) throw err;
  }
  throw new VageError("The editor sent a request vagejs couldn't read. Reload the editor.");
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.setHeader("Cache-Control", "no-store");
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function redirectTo(res: ServerResponse, location: string) {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}
