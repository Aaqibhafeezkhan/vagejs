import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "node-html-parser";
import { VageError } from "../core/errors.js";
import { createBuildLoader } from "../core/loader.js";
import { renderSite } from "../core/site.js";

/**
 * `vage verify`: compares the live site with a fresh local render of the project. Anything
 * on the live site that isn't in your files (extra links, extra scripts, changed text, extra
 * pages in sitemap.xml) means the site was changed outside your repository: a hacked host
 * account, a compromised deploy, or a CDN injecting content.
 */

export interface PageFingerprint {
  links: string[];
  scripts: string[];
  text: string;
}

export interface Difference {
  route: string;
  severity: "error" | "warning";
  kind: "unreachable" | "links-added" | "links-removed" | "scripts-added" | "text-changed" | "sitemap-extra";
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  url: string;
  pagesChecked: number;
  differences: Difference[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** What matters for injected spam: link targets, scripts and visible text, independent of formatting. */
export function fingerprint(html: string, pageUrl: string): PageFingerprint {
  const doc = parse(html);
  const links = new Set<string>();
  for (const a of doc.querySelectorAll("a[href], area[href]")) {
    const href = a.getAttribute("href")!.trim();
    let abs: string;
    try {
      abs = new URL(href, pageUrl).href;
    } catch {
      abs = href;
    }
    // Cloudflare's email protection rewrites mailto: links; not a content change.
    if (/\/cdn-cgi\//.test(abs) || href.startsWith("mailto:")) continue;
    links.add(abs);
  }
  const scripts = new Set<string>();
  for (const s of doc.querySelectorAll("script")) {
    const src = s.getAttribute("src");
    if (src) scripts.add(`src:${new URL(src, pageUrl).href}`);
    else if (s.getAttribute("type") !== "application/ld+json") scripts.add(`inline:${sha(s.text.trim())}`);
  }
  for (const s of doc.querySelectorAll("script, style, noscript, template")) s.remove();
  // Whitespace between elements depends on formatting, not content, so it's ignored entirely.
  const text = (doc.querySelector("body") ?? doc).text.replace(/\s+/g, "");
  return { links: [...links].sort(), scripts: [...scripts].sort(), text };
}

export function compare(route: string, local: PageFingerprint, live: PageFingerprint): Difference[] {
  const out: Difference[] = [];
  const added = live.links.filter((l) => !local.links.includes(l));
  const removed = local.links.filter((l) => !live.links.includes(l));
  const scripts = live.scripts.filter((s) => !local.scripts.includes(s));
  if (added.length) out.push({ route, severity: "error", kind: "links-added", detail: `Links on the live page that aren't in your files: ${added.slice(0, 5).join(", ")}${added.length > 5 ? ` (+${added.length - 5})` : ""}` });
  if (scripts.length) out.push({ route, severity: "error", kind: "scripts-added", detail: `Scripts on the live page that aren't in your files: ${scripts.slice(0, 5).join(", ")}` });
  if (removed.length) out.push({ route, severity: "warning", kind: "links-removed", detail: `Links missing from the live page: ${removed.slice(0, 5).join(", ")}${removed.length > 5 ? ` (+${removed.length - 5})` : ""}` });
  if (local.text !== live.text) out.push({ route, severity: "warning", kind: "text-changed", detail: "The live page's text differs from your files (an old deploy, or content changed outside the repository)." });
  return out;
}

function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

export async function verifySite(
  root: string,
  options: { url?: string; fetch?: typeof fetch; concurrency?: number } = {},
): Promise<VerifyResult> {
  root = path.resolve(root);
  const doFetch = options.fetch ?? fetch;
  const loader = await createBuildLoader(root);
  try {
    const model = await renderSite(root, loader.load);
    const origin = (options.url ?? model.site.site)?.replace(/\/+$/, "");
    if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) throw new VageError('Pass the live site\'s origin with --url https://example.com, or set "site" in vage.config.ts.');
    const get = async (url: string) => {
      try {
        const res = await doFetch(url, { redirect: "follow", headers: { "user-agent": "vagejs-verify" }, signal: AbortSignal.timeout(20_000) });
        return { status: res.status, body: res.ok ? await res.text() : "" };
      } catch (err) {
        return { status: 0, body: "", error: (err as Error).message };
      }
    };

    const differences: Difference[] = [];
    const queue = [...model.pages];
    const worker = async () => {
      for (let page = queue.shift(); page; page = queue.shift()) {
        const url = `${origin}${page.route}`;
        const live = await get(url);
        if (live.status !== 200) {
          differences.push({ route: page.route, severity: "error", kind: "unreachable", detail: live.status ? `HTTP ${live.status}` : "no response" });
          continue;
        }
        differences.push(...compare(page.route, fingerprint(page.html, url), fingerprint(live.body, url)));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));

    // Pages someone added on the server announce themselves in the live sitemap.
    const localSitemap = model.files.get("sitemap.xml");
    if (localSitemap) {
      const live = await get(`${origin}/sitemap.xml`);
      if (live.status === 200) {
        const known = new Set(sitemapUrls(localSitemap).map((u) => new URL(u).pathname));
        const extra = sitemapUrls(live.body).filter((u) => {
          try {
            return !known.has(new URL(u).pathname);
          } catch {
            return true;
          }
        });
        if (extra.length) differences.push({ route: "/sitemap.xml", severity: "error", kind: "sitemap-extra", detail: `The live sitemap lists pages that aren't in your files: ${extra.slice(0, 5).join(", ")}${extra.length > 5 ? ` (+${extra.length - 5})` : ""}` });
      }
    }

    differences.sort((a, b) => (a.severity === b.severity ? a.route.localeCompare(b.route) : a.severity === "error" ? -1 : 1));
    return { ok: !differences.some((d) => d.severity === "error"), url: origin, pagesChecked: model.pages.length, differences };
  } finally {
    await loader.close();
  }
}
