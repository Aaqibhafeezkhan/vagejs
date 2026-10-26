import crypto from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
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
import { directUrl } from "./listen.js";

/**
 * The local editor for `vage dev`: a list of pages, a form for each page's frontmatter
 * (built from the built-in fields, the layout's own and any others in the file), the Markdown
 * text with a live preview, image upload, and the page's `vage check` findings. It edits the
 * project's files and nothing else, and only exists alongside the dev server, never in a build.
 *
 * Safety: it has its own port, so it is a separate origin from the site's pages: scripts on
 * those pages (an embed in a layout, say) can't read it. It runs only when the dev server
 * listens on this computer (not with --host) and listens on the same loopback address; every
 * request must name a loopback host (no DNS rebinding); API calls need the per-server key from
 * the editor page and must come from the editor's own origin. It sends no CORS headers.
 * Writes go only to existing pages in src/pages (refused if the file changed since it was
 * opened), new pages via `vage new`, and new files in public/images/.
 */
export const EDITOR_PATH = "/_vage/edit/";

const UI_DIR = fileURLToPath(new URL("../../editor/", import.meta.url));
const UI_FILES: Record<string, string> = { "/editor.js": "text/javascript; charset=utf-8", "/editor.css": "text/css; charset=utf-8" };
// The same pattern parseFrontmatter uses.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const LAYOUT_NAME = /^[\w-]+$/;
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

/** The URL from a Host header ("localhost:5174", "[::1]:5174"), or undefined. */
function hostUrl(header: string | undefined): URL | undefined {
  if (!header) return undefined;
  try {
    return new URL(`http://${header}`);
  } catch {
    return undefined;
  }
}

// Keyed by the HTTP server: Vite hands plugins a different object than createServer returns.
const editors = new WeakMap<object, Promise<string | undefined>>();

/** The editor's address once the dev server listens; undefined when the editor is off. */
export function editorUrl(server: ViteDevServer): Promise<string | undefined> {
  return (server.httpServer && editors.get(server.httpServer)) ?? Promise.resolve(undefined);
}

export function editorPlugin(root: string, enabled: boolean): Plugin {
  return {
    name: "vage:editor",
    configureServer(server) {
      if (!enabled) return;
      const token = crypto.randomBytes(24).toString("hex");
      const load = viteLoader(server);
      let devPort = 0;
      const editor = http.createServer((req, res) => {
        handle(req, res).catch((err: unknown) => {
          server.config.logger.error((err as Error).stack ?? String(err));
          if (!res.headersSent) json(res, 500, { error: (err as Error).message });
        });
      });

      async function handle(req: IncomingMessage, res: ServerResponse) {
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        const host = hostUrl(req.headers.host);
        if (!host || !isLoopback(host.hostname)) return send(res, 403, "text/plain", "Open the editor at the address vage dev prints.");
        const pathname = (req.url ?? "/").split(/[?#]/)[0]!;
        if (req.method === "GET" && pathname === "/") {
          // The site's pages, on the dev server's port at the same host name: for the preview and "Open page".
          const site = new URL(host.href);
          site.port = String(devPort);
          const page = fs.readFileSync(path.join(UI_DIR, "index.html"), "utf8").replace("%TOKEN%", token).replace("%SITE%", site.origin);
          res.setHeader("Cache-Control", "no-store");
          return send(res, 200, "text/html; charset=utf-8", page);
        }
        if (req.method === "GET" && UI_FILES[pathname]) {
          res.setHeader("Cache-Control", "no-cache"); // a vagejs update brings a new editor
          return send(res, 200, UI_FILES[pathname]!, fs.readFileSync(path.join(UI_DIR, pathname.slice(1))));
        }
        if (!pathname.startsWith("/api/")) return send(res, 404, "text/plain", "Not found");
        if (!validKey(req.headers["x-vage-token"], token) || !sameOrigin(req)) return json(res, 403, { error: "This request didn't come from the editor page. Reload the editor." });
        try {
          await api(root, load, req, res, pathname.slice("/api/".length));
        } catch (err) {
          if (err instanceof VageError) return json(res, 400, { error: err.detail });
          throw err;
        }
      }

      // Same loopback address as the dev server; the next port when it's free, else any free port.
      let ready!: (url: string | undefined) => void;
      if (server.httpServer) editors.set(server.httpServer, new Promise((resolve) => (ready = resolve)));
      server.httpServer?.once("listening", () => {
        const address = server.httpServer!.address() as AddressInfo;
        devPort = address.port;
        const listen = (port: number) =>
          new Promise<void>((resolve, reject) => {
            editor.once("error", reject);
            editor.listen(port, address.address, () => {
              editor.off("error", reject);
              resolve();
            });
          });
        listen(devPort + 1)
          .catch(() => listen(0))
          .then(() => ready(directUrl(editor.address()) ?? `http://localhost:${(editor.address() as AddressInfo).port}/`))
          .catch((err: unknown) => {
            server.config.logger.error(`The editor couldn't start: ${(err as Error).message}`);
            ready(undefined);
          });
      });
      server.httpServer?.once("close", () => editor.close());

      // /_vage/edit/ on the dev server leads to the editor's own address.
      server.middlewares.use(async (req, res, next) => {
        const pathname = (req.url ?? "/").split(/[?#]/)[0]!;
        if (pathname !== "/_vage/edit" && pathname !== EDITOR_PATH) return next();
        const url = await editorUrl(server);
        return url ? redirectTo(res, url) : next();
      });
    },
  };
}

function validKey(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== "string" || given.length !== token.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/** Browsers send Origin on POST/PUT and Sec-Fetch-Site on all requests; both must say "this origin". */
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
  if (action === "schema" && method === "GET") {
    const layout = query.get("layout") || undefined;
    if (layout !== undefined && !LAYOUT_NAME.test(layout)) throw new VageError("A layout name is a file name in src/layouts, without the extension.");
    return json(res, 200, { fields: await fields(root, load, layout) });
  }
  if (action === "page" && method === "PUT") {
    const { source, data, body, version } = await readJson(req);
    const { file, text, original } = compose(root, site, source, data, body);
    // Someone else (an AI agent, another editor tab) changed the file since it was opened: don't overwrite their work.
    if (version !== hash(original)) return json(res, 409, { error: "This page changed on disk since you opened it, perhaps in another tab or by an AI agent. Copy your changes, then reload the page to see the new version." });
    await validate(root, load, file, text);
    fs.writeFileSync(file, text);
    return json(res, 200, { ok: true, version: hash(text) });
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
  const text = fs.readFileSync(file, "utf8");
  const { yaml, body } = split(text);
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new VageError(`The frontmatter (the part between the --- lines) can't be read, so fix it in your text editor first:\n${doc.errors[0]!.message}`);
  const data = (doc.toJS() ?? {}) as Record<string, unknown>;
  if (typeof data !== "object" || Array.isArray(data)) throw new VageError("The frontmatter must be a list of fields (key: value). Fix it in your text editor first.");
  return {
    source,
    route: route ? publicPath(route, site.trailingSlash) : null,
    data,
    body,
    /** Sent back on save, so a file changed in the meantime isn't overwritten. */
    version: hash(text),
    fields: await fields(root, load, typeof data.layout === "string" && LAYOUT_NAME.test(data.layout) ? data.layout : undefined),
    layouts: layoutNames(root),
  };
}

/**
 * The page file with the edited frontmatter. Comments and field order stay, and only changed,
 * added and removed fields get new values (the yaml library may tidy spacing on other lines).
 */
function compose(root: string, site: SiteConfig, source: unknown, data: unknown, body: unknown): { file: string; route?: string; text: string; original: string } {
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
  return { file, route, text, original };
}

const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

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
  /** Choices for "select", as the values they stand for (strings or numbers). */
  options?: unknown[];
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
      options: key === "layout" ? layoutNames(root) : prop.enum,
      default: prop.default,
      group: meta.group,
    });
  }
  if (layout !== undefined && !LAYOUT_NAME.test(layout)) return out; // only files in src/layouts
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
      if (prop.enum) known.options = prop.enum;
      continue;
    }
    out.push({ key, label: humanize(key), help: prop.description, kind: kindOf(prop), required: required.has(key) && prop.default === undefined, options: prop.enum, default: prop.default, group: "layout" });
  }
  return out;
}

function kindOf(prop: JsonSchema): EditorField["kind"] {
  if (prop.enum) return "select";
  const types = (Array.isArray(prop.type) ? prop.type : [prop.type]).filter((t) => t !== "null");
  if (types.length !== 1) return "json"; // e.g. string | number: JSON keeps the value's type
  const type = types[0];
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
