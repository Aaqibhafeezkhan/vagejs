/**
 * Sites served from a subfolder, e.g. GitHub Pages project sites at
 * https://owner.github.io/repo/. `site` keeps the path ("https://owner.github.io/repo"), so
 * absolute URLs built from it are right; everything else in vagejs works with root paths
 * ("/about/"), and the build adds the subfolder to the root-relative URLs in its output.
 */

/** "/repo" for "https://owner.github.io/repo"; "" for a site at the root of its domain. */
export function basePath(site: string | undefined): string {
  return site ? new URL(site).pathname.replace(/\/+$/, "") : "";
}

/** The scheme and host of `site`, without its path. */
export function siteOrigin(site: string | undefined): string | undefined {
  return site ? new URL(site).origin : undefined;
}

/** "/about/" -> "/repo/about/"; leaves "//host", relative and absolute URLs alone. */
export function prefixPath(url: string, base: string): string {
  return base && url.startsWith("/") && !url.startsWith("//") ? `${base}${url}` : url;
}

const ATTRS = new Set(["href", "src", "action", "formaction", "poster", "data", "xlink:href"]);
// url("/a b.png"), url('/x'), url(&quot;/x&quot;) (in a style attribute), url(/x), and @import "/x.css".
const CSS_URL = /(url\(\s*)(["']|&quot;)(\/(?!\/)[\s\S]*?)\2(\s*\))|(url\(\s*)(\/(?!\/)[^"')\s]*)(\s*\))|(@import\s+)(["'])(\/(?!\/)[^"']*)\9/g;

/** CSS root-relative references (`url(/...)`, `@import "/..."`), e.g. fonts and images in a stylesheet from public/. */
export function cssWithBase(css: string, base: string): string {
  if (!base) return css;
  return css.replace(CSS_URL, (...m: (string | undefined)[]) => {
    if (m[1] !== undefined) return `${m[1]}${m[2]}${base}${m[3]}${m[2]}${m[4]}`;
    if (m[5] !== undefined) return `${m[5]}${base}${m[6]}${m[7]}`;
    return `${m[8]}${m[9]}${base}${m[10]}${m[9]}`;
  });
}

/**
 * Adds the subfolder to root-relative URLs in finished HTML: link, image and form attributes,
 * srcset lists, inline style url(), <style> blocks and meta refresh targets. Only real tags
 * are touched: text (including code samples, whose < is escaped), comments and scripts stay
 * as written.
 */
export function withBase(html: string, base: string): string {
  if (!base) return html;
  // A start tag, quote-aware so a ">" inside an attribute value (alt="a > b") doesn't end it.
  const TAG = `<[a-zA-Z](?:[^<>"']|"[^"]*"|'[^']*')*>`;
  // <script> and <textarea> keep their contents as written (code and text); only their own tag is changed.
  const parts = new RegExp(`<!--[\\s\\S]*?-->|(<(script|textarea)\\b(?:[^<>"']|"[^"]*"|'[^']*')*>)[\\s\\S]*?<\\/\\2\\s*>|(<style\\b[^>]*>)([\\s\\S]*?)(<\\/style\\s*>)|${TAG}`, "gi");
  return html.replace(parts, (match, script?: string, _name?: string, open?: string, css?: string, close?: string) => {
    if (match.startsWith("<!--")) return match;
    if (script !== undefined) return tagWithBase(script, base) + match.slice(script.length); // src only, never the code
    if (open !== undefined) return `${open}${cssWithBase(css!, base)}${close}`;
    return tagWithBase(match, base);
  });
}

function tagWithBase(tag: string, base: string): string {
  const refresh = /^<meta\b/i.test(tag) && /\bhttp-equiv\s*=\s*["']?refresh/i.test(tag);
  // Quoted (href="/x") or unquoted (href=/x) values.
  return tag.replace(/(\s)([\w:-]+)(\s*=\s*)(?:(["'])([\s\S]*?)\4|([^\s"'=<>`]+))/g, (all, space: string, name: string, eq: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    const q = quote ?? "";
    const value = quoted ?? bare ?? "";
    const attr = name.toLowerCase();
    let next = value;
    if (ATTRS.has(attr)) next = prefixPath(value.trim(), base);
    else if (attr === "srcset" || attr === "imagesrcset") next = value.replace(/(^|,)(\s*)(\/(?!\/)\S*)/g, (_, sep: string, ws: string, url: string) => `${sep}${ws}${base}${url}`);
    else if (attr === "style") next = cssWithBase(value, base);
    else if (attr === "content" && refresh) next = value.replace(/(url\s*=\s*['"]?)(\/(?!\/))/i, `$1${base}$2`);
    return next === value ? all : `${space}${name}${eq}${q}${next}${q}`;
  });
}
