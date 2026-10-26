import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { cssWithBase } from "./base.js";

/**
 * Stylesheets, scripts and fonts from public/ (assets.minifyCss, assets.fingerprint).
 *
 * With fingerprint on, each one also gets a copy named from its content under
 * /_vage/assets/ (`/styles.css` -> `/_vage/assets/styles.3f9a1c2b.css`), pages and
 * stylesheets point to the copies, and _headers lets hosts cache that folder for a year:
 * a changed file gets a new name, so nobody keeps an old one. The original files stay
 * where they were, so links from other sites keep working.
 */
export const ASSETS_DIR = "_vage/assets";
// .mjs is left out: modules import each other by relative path, which renaming would break.
const FINGERPRINTED = /\.(css|js|woff2?|ttf|otf)$/i;

export interface AssetPlan {
  /** Site path -> its fingerprinted path, e.g. "/styles.css" -> "/_vage/assets/styles.3f9a1c2b.css". */
  rename: Map<string, string>;
  /** Files to write: path under dist/ (no leading slash) -> contents. Minified stylesheets and the fingerprinted copies. */
  files: Map<string, Buffer>;
}

type Minify = (css: string, file: string) => string;

/**
 * lightningcss, which ships with Vite (vagejs's own dependency), loaded only when a site
 * minifies. Targets older browsers (Safari 14, Chrome and Firefox 100) so fallbacks such as
 * `height: 100vh; height: 100dvh` are kept; light-dark() is left as written.
 */
function lightningcss(): Minify {
  const require = createRequire(createRequire(import.meta.url).resolve("vite"));
  const lc = require(require.resolve("lightningcss")) as {
    transform: (o: object) => { code: Buffer };
    Features: { LightDark: number };
  };
  const targets = { safari: 14 << 16, chrome: 100 << 16, firefox: 100 << 16 };
  return (css, file) => lc.transform({ filename: file, code: Buffer.from(css), minify: true, errorRecovery: true, targets, exclude: lc.Features.LightDark }).code.toString();
}

function publicFiles(dir: string, prefix = ""): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) return publicFiles(path.join(dir, e.name), rel);
    return e.isFile() ? [rel] : [];
  });
}

const short = (data: Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 10);

/** `url(...)` and `@import "..."` targets in a stylesheet, resolved to site paths. */
const CSS_REF = /url\(\s*(["']?)([^"')]+)\1\s*\)|@import\s+(["'])([^"']+)\3/g;
function cssRefPath(ref: string, from: string): string | undefined {
  if (/^(data:|https?:|\/\/|#)/i.test(ref)) return undefined;
  const clean = ref.split(/[?#]/)[0]!;
  return ref.startsWith("/") ? clean : path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
}

/**
 * Works out what the build writes for public/'s stylesheets, scripts and fonts. `base` is a
 * subfolder site's prefix ("/repo"), applied to stylesheets first, as the build does.
 */
export function planAssets(root: string, options: { minifyCss: boolean; fingerprint: boolean; base: string }, minify?: Minify): AssetPlan {
  const publicDir = path.join(root, "public");
  const plan: AssetPlan = { rename: new Map(), files: new Map() };
  const all = publicFiles(publicDir);
  const read = (p: string) => fs.readFileSync(path.join(publicDir, p));

  // Stylesheets as the build publishes them (prefix, then minified).
  const css = new Map<string, string>();
  for (const p of all.filter((f) => /\.css$/i.test(f))) {
    let text = read(p).toString("utf8");
    if (options.base) text = cssWithBase(text, options.base);
    if (options.minifyCss) {
      try {
        minify ??= lightningcss();
        text = minify(text, p);
      } catch {
        // Invalid CSS is published as written; browsers skip what they can't read.
      }
      plan.files.set(p.slice(1), Buffer.from(text));
    }
    css.set(p, text);
  }
  if (!options.fingerprint) return plan;

  const fingerprinted = (p: string, data: Buffer) => {
    const ext = path.posix.extname(p);
    const named = `/${ASSETS_DIR}${p.slice(0, -ext.length)}.${short(data)}${ext}`;
    plan.rename.set(p, named);
    plan.files.set(named.slice(1), data);
  };
  // Fonts and scripts first: stylesheets refer to fonts, and their names come from their content.
  for (const p of all.filter((f) => FINGERPRINTED.test(f) && !/\.css$/i.test(f))) fingerprinted(p, read(p));
  // Stylesheets: point their references at the copies, then name them. @import chains are followed.
  const done = new Set<string>();
  const visit = (p: string, seen: Set<string>) => {
    if (done.has(p) || seen.has(p)) return;
    seen.add(p);
    const base = options.base;
    // The copy lives in /_vage/assets/, so every relative reference becomes a site path
    // (renamed when the target was fingerprinted, with its ?query or #fragment kept).
    const point = (ref: string) => {
      const target = cssRefPath(base && ref.startsWith(`${base}/`) ? ref.slice(base.length) : ref, p);
      if (!target) return ref;
      if (css.has(target)) visit(target, seen);
      const suffix = /[?#].*$/.exec(ref)?.[0] ?? "";
      return `${base}${plan.rename.get(target) ?? target}${suffix}`;
    };
    const text = css
      .get(p)!
      .replace(CSS_REF, (match, _q1, urlRef: string | undefined, _q2, importRef: string | undefined) => {
        const ref = urlRef ?? importRef!;
        return match.replace(ref, point(ref));
      })
      .replace(/image-set\(([^)]*)\)/gi, (_match, inner: string) => `image-set(${inner.replace(/(["'])([^"']+)\1/g, (_m, q: string, ref: string) => `${q}${point(ref)}${q}`)})`);
    fingerprinted(p, Buffer.from(text));
    done.add(p);
  };
  for (const p of css.keys()) visit(p, new Set());
  return plan;
}

/**
 * Points a page's stylesheet, script and font references at their fingerprinted copies
 * (before any subfolder prefix). Only <link> and <script> tags are touched, never the code
 * inside a script, and module scripts keep their names (their imports are relative).
 */
export function withAssetNames(html: string, rename: Map<string, string>): string {
  if (!rename.size) return html;
  const tag = (t: string) =>
    (/^<script\b/i.test(t) && /\btype\s*=\s*["']?module/i.test(t)) || /\brel\s*=\s*["']?modulepreload/i.test(t)
      ? t
      : t.replace(/(\s(?:href|src)\s*=\s*)(["'])(\/[^"'?#]+)([^"']*)\2/i, (match, eq: string, q: string, p: string, rest: string) => {
          const renamed = rename.get(p);
          return renamed ? `${eq}${q}${renamed}${rest}${q}` : match;
        });
  // Script bodies are copied as they are; only the tags around them are read.
  return html.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)|<link\b[^>]*>/gi, (match, open: string | undefined, body: string, close: string) =>
    open ? `${tag(open)}${body}${close}` : tag(match),
  );
}
