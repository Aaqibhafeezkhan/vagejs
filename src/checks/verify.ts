import { createHash } from "node:crypto";
import path from "node:path";
import { parse } from "node-html-parser";
import { VageError } from "../core/errors.js";
import { createBuildLoader } from "../core/loader.js";
import { renderSite } from "../core/site.js";
import { spamHits } from "./integrity.js";

/**
 * `vage verify`: compares the live site with a fresh local render of the project. Anything
 * on the live site that isn't in your files (extra links, extra scripts, changed text, extra
 * pages in sitemap.xml) means the site was changed outside your repository: a hacked host
 * account, a compromised deploy, or a CDN injecting content.
 */

export interface PageFingerprint {
  /** Where the page sends people and crawlers: links, canonical/og:url, meta refresh, iframes, embeds, forms. */
  links: string[];
  /** Scripts (src or hash), inline event handlers (hash) and JSON-LD blocks (hash). */
  scripts: string[];
  /** Scripts a CDN injected (Cloudflare email protection, Web Analytics): not content, but they can break your security policy. */
  cdnScripts: string[];
  text: string;
  /** Spam vocabulary in the visible text (read with spaces intact). */
  spam: string[];
}

export interface Difference {
  route: string;
  severity: "error" | "warning";
  kind:
    | "unreachable"
    | "links-added"
    | "links-removed"
    | "scripts-added"
    | "text-changed"
    | "sitemap-extra"
    | "robots-changed"
    | "cdn-script"
    | "crawler-blocked"
    | "robots-blocked"
    | "noindex-header"
    | "redirect-missing"
    | "duplicate-host";
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  url: string;
  pagesChecked: number;
  /** Crawlers probed by the crawlability check (0 when skipped or when the site blocks everyone). */
  crawlersChecked: number;
  differences: Difference[];
}

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Scripts Cloudflare adds by itself, matched by their exact shape so an injected script
 * that merely mentions /cdn-cgi/ is still reported as an added script.
 */
const BEACON = /^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js(\/[\w.]*)?$/;
const CDN_PATH = /^\/cdn-cgi\/(scripts\/[0-9a-f]+\/cloudflare-static\/email-decode\.min\.js|challenge-platform\/(h\/[a-z]\/)?scripts\/jsd\/main\.js)$/;
/** Cloudflare's scripts: the Web Analytics beacon, or a /cdn-cgi/ script on the site's own host (never another site's). */
const isCdnScript = (url: string, pageHost: string) => {
  if (BEACON.test(url)) return true;
  try {
    const u = new URL(url);
    return u.host === pageHost && !u.search && CDN_PATH.test(u.pathname);
  } catch {
    return false;
  }
};
/** Cloudflare's JS-detection loader: sets window.__CF$cv$params and loads /cdn-cgi/challenge-platform/.../main.js, nothing else. */
const CDN_INLINE = /^\s*\(function\(\)\{function c\(\)\{var b=a\.contentDocument\|\|a\.contentWindow\.document;if\(b\)\{var d=b\.createElement\('script'\);d\.innerHTML="window\.__CF\$cv\$params=\{r:'[0-9a-f]+',t:'[A-Za-z0-9+\/=]+'\};var a=document\.createElement\('script'\);a\.src='\/cdn-cgi\/challenge-platform\/scripts\/jsd\/main\.js';document\.getElementsByTagName\('head'\)\[0\]\.appendChild\(a\);";b\.getElementsByTagName\('head'\)\[0\]\.appendChild\(d\)\}\}if\(document\.body\)\{var a=document\.createElement\('iframe'\);a\.height=1;a\.width=1;a\.style\.position='absolute';a\.style\.top=0;a\.style\.left=0;a\.style\.border='none';a\.style\.visibility='hidden';document\.body\.appendChild\(a\);if\('loading'!==document\.readyState\)c\(\);else if\(window\.addEventListener\)document\.addEventListener\('DOMContentLoaded',c\);else\{var e=document\.onreadystatechange\|\|function\(\)\{\};document\.onreadystatechange=function\(b\)\{e\(b\);'loading'!==document\.readyState&&\(document\.onreadystatechange=e,c\(\)\)\}\}\}\}\)\(\);\s*$/;
/** Cloudflare email protection rewrites mailto: links to this (on the site's own host); not a content change. */
const isCdnLink = (url: string, pageHost: string) => {
  try {
    const u = new URL(url);
    return u.host === pageHost && u.pathname === "/cdn-cgi/l/email-protection" && !u.search && /^(#[0-9a-f]*)?$/.test(u.hash);
  } catch {
    return false;
  }
};

/** Every link-like target in a text file (Markdown, RSS, llms.txt), normalized for comparison. */
export function textLinks(text: string): Set<string> {
  const found = new Set<string>();
  const add = (raw: string) => found.add(raw.trim().replace(/[.,;:!?]+$/, "").toLowerCase());
  for (const m of text.matchAll(/\]\(\s*<?([^)\s>]+)/g)) add(m[1]!); // [text](target)
  for (const m of text.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)/gm)) add(m[1]!); // [ref]: target
  for (const m of text.matchAll(/<((?:[a-z][a-z0-9+.-]*:|\/\/)[^>\s]+)>/gi)) add(m[1]!); // <autolink>
  for (const m of text.matchAll(/(?:\b[a-z][a-z0-9+.-]*:)?\/\/[^\s)<>"'\]]+|\bwww\.[^\s)<>"'\]]+/gi)) add(m[0]); // bare URLs, //host, www.
  for (const m of text.matchAll(/<link>([^<]+)<\/link>|<guid[^>]*>([^<]+)<\/guid>/gi)) add((m[1] ?? m[2])!); // RSS
  return found;
}

const TARGETS: [string, string, (el: import("node-html-parser").HTMLElement) => string | null | undefined][] = [
  ["a, area", "", (el) => el.getAttribute("href") ?? el.getAttribute("xlink:href")],
  ["link[href]", "link:", (el) => el.getAttribute("href")],
  ['meta[property="og:url"]', "og:url:", (el) => el.getAttribute("content")],
  ["meta[http-equiv]", "refresh:", (el) => (/^refresh$/i.test(el.getAttribute("http-equiv") ?? "") ? /url\s*=\s*['"]?([^'";]+)/i.exec(el.getAttribute("content") ?? "")?.[1] : undefined)],
  ["iframe[src], embed[src], frame[src]", "frame:", (el) => el.getAttribute("src")],
  ["object[data]", "object:", (el) => el.getAttribute("data")],
  ["form[action]", "form:", (el) => el.getAttribute("action")],
];

/** What matters for injected spam: where the page sends people, what runs on it, and its visible text, independent of formatting. */
export function fingerprint(html: string, pageUrl: string): PageFingerprint {
  const doc = parse(html);
  const pageHost = new URL(pageUrl).host;
  const abs = (href: string) => {
    try {
      return new URL(href.trim(), pageUrl).href;
    } catch {
      return href.trim();
    }
  };
  const links = new Set<string>();
  for (const [selector, prefix, read] of TARGETS) {
    for (const el of doc.querySelectorAll(selector)) {
      const value = read(el);
      if (!value || value.trim().startsWith("mailto:")) continue;
      const url = abs(value);
      if (isCdnLink(url, pageHost)) continue;
      links.add(prefix + url);
    }
  }
  const scripts = new Set<string>();
  const cdnScripts = new Set<string>();
  for (const el of doc.querySelectorAll("script")) {
    const src = el.getAttribute("src");
    if (src) {
      const url = abs(src);
      if (isCdnScript(url, pageHost)) cdnScripts.add(url.replace(/\?.*$/, ""));
      else scripts.add(`src:${url}`);
    } else if (el.getAttribute("type") === "application/ld+json") scripts.add(`json-ld:${sha(el.text.replace(/\s+/g, ""))}`);
    else if (CDN_INLINE.test(el.text)) cdnScripts.add("Cloudflare's inline bot-detection script (/cdn-cgi/challenge-platform/)");
    else scripts.add(`inline:${sha(el.text.trim())}`);
  }
  for (const el of doc.querySelectorAll("*")) {
    for (const [name, value] of Object.entries(el.attributes)) {
      if (/^on/i.test(name)) scripts.add(`handler:${el.tagName.toLowerCase()}.${name.toLowerCase()}:${sha(value)}`);
    }
  }
  for (const el of doc.querySelectorAll("script, style, noscript, template")) el.remove();
  // Whitespace between elements depends on formatting, not content, so it's ignored entirely.
  const visible = (doc.querySelector("body") ?? doc).text;
  return { links: [...links].sort(), scripts: [...scripts].sort(), cdnScripts: [...cdnScripts].sort(), text: visible.replace(/\s+/g, ""), spam: spamHits(visible.replace(/\s+/g, " ")) };
}

export function compare(route: string, local: PageFingerprint, live: PageFingerprint): Difference[] {
  const out: Difference[] = [];
  const added = live.links.filter((l) => !local.links.includes(l));
  const removed = local.links.filter((l) => !live.links.includes(l));
  const scripts = live.scripts.filter((s) => !local.scripts.includes(s));
  if (added.length) out.push({ route, severity: "error", kind: "links-added", detail: `Links on the live page that aren't in your files: ${added.slice(0, 5).join(", ")}${added.length > 5 ? ` (+${added.length - 5})` : ""}` });
  if (scripts.length) out.push({ route, severity: "error", kind: "scripts-added", detail: `Scripts on the live page that aren't in your files: ${scripts.slice(0, 5).join(", ")}` });
  if (removed.length) out.push({ route, severity: "warning", kind: "links-removed", detail: `Links missing from the live page: ${removed.slice(0, 5).join(", ")}${removed.length > 5 ? ` (+${removed.length - 5})` : ""}` });
  if (local.text !== live.text) {
    const spam = live.spam.filter((h) => !local.spam.includes(h));
    out.push(
      spam.length
        ? { route, severity: "error", kind: "text-changed", detail: `The live page's text differs from your files and contains spam words (${spam.join(", ")}).` }
        : { route, severity: "warning", kind: "text-changed", detail: "The live page's text differs from your files (an old deploy, or content changed outside the repository)." },
    );
  }
  return out;
}

function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
}

/** Browser-like request headers: some CDNs only inject scripts for browsers, and those are what visitors get. */
const BROWSER = "Mozilla/5.0 (compatible; vagejs-verify) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function verifySite(
  root: string,
  options: { url?: string; fetch?: typeof fetch; concurrency?: number; crawlers?: boolean } = {},
): Promise<VerifyResult> {
  root = path.resolve(root);
  const doFetch = options.fetch ?? fetch;
  const loader = await createBuildLoader(root);
  try {
    const model = await renderSite(root, loader.load);
    const origin = (options.url ?? model.site.site)?.replace(/\/+$/, "");
    if (!origin || !/^https?:\/\/[^/]+$/.test(origin)) throw new VageError('Pass the live site\'s origin with --url https://example.com, or set "site" in vage.config.ts.');
    const get = async (url: string, userAgent = BROWSER) => {
      try {
        const res = await doFetch(url, { redirect: "follow", headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,*/*;q=0.8" }, signal: AbortSignal.timeout(20_000) });
        return { status: res.status, body: res.ok ? await res.text() : "" };
      } catch (err) {
        return { status: 0, body: "", error: (err as Error).message };
      }
    };

    const differences: Difference[] = [];
    const cdnSeen = new Set<string>();
    const queue = [...model.pages];
    const worker = async () => {
      for (let page = queue.shift(); page; page = queue.shift()) {
        const url = `${origin}${page.route}`;
        const live = await get(url);
        if (live.status !== 200) {
          differences.push({ route: page.route, severity: "error", kind: "unreachable", detail: live.status ? `HTTP ${live.status}` : "no response" });
          continue;
        }
        const local = fingerprint(page.html, url);
        const livePrint = fingerprint(live.body, url);
        const seen = compare(page.route, local, livePrint);
        differences.push(...seen);
        for (const src of livePrint.cdnScripts) cdnSeen.add(src);
        // Hacked sites often show spam only to search engines ("cloaking"): look again as Googlebot.
        // Skipped when Googlebot gets a challenge page (the crawlability check reports that once).
        const bot = await get(url, GOOGLEBOT);
        if (bot.status === 200 && !/<title>\s*(Just a moment|Attention Required|Access denied|Checking your browser)/i.test(bot.body)) {
          for (const d of compare(page.route, local, fingerprint(bot.body, url))) {
            if (!seen.some((x) => x.kind === d.kind && x.detail === d.detail)) differences.push({ ...d, detail: `Only when visited as Googlebot: ${d.detail}` });
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 4) }, worker));

    // A planted Sitemap: line or new rules in robots.txt point crawlers at spam.
    const localRobots = model.files.get("robots.txt");
    if (localRobots) {
      const live = await get(`${origin}/robots.txt`);
      const lines = (t: string) => t.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean).join("\n");
      if (live.status === 200 && lines(live.body) !== lines(localRobots)) {
        differences.push({ route: "/robots.txt", severity: "error", kind: "robots-changed", detail: "The live robots.txt differs from the one your build writes." });
      }
    }

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

    for (const src of cdnSeen) {
      differences.push({
        route: "/",
        severity: "warning",
        kind: "cdn-script",
        detail: `Your host or CDN adds ${src} to pages. It isn't in your files, and your security policy may block it (browser console errors). Turn the feature off at your host, or allow it in security.cspSources.`,
      });
    }
    // Generated files must match too: the feed, Markdown copies and optimized images.
    const generated = [...model.files.keys()].filter((name) => name.endsWith("feed.xml") || name === "llms.txt" || name === "llms-full.txt" || (name.endsWith(".md") && !name.includes("/_")));
    for (const name of generated) {
      const live = await get(`${origin}/${name}`);
      const local = model.files.get(name)!;
      const norm = (t: string) => t.replace(/\s+/g, "");
      if (live.status !== 200) differences.push({ route: `/${name}`, severity: "error", kind: "unreachable", detail: live.status ? `HTTP ${live.status}` : "no response" });
      else if (norm(live.body) !== norm(local)) {
        // Any URL in the live file that isn't in the build is treated like an added link.
        const known = textLinks(local);
        const added = [...textLinks(live.body)].filter((u) => !known.has(u));
        const spam = spamHits(live.body).filter((h) => !spamHits(local).includes(h));
        if (added.length) differences.push({ route: `/${name}`, severity: "error", kind: "links-added", detail: `Links in the live file that aren't in your build: ${added.slice(0, 5).join(", ")}` });
        // Generated files are the same on every build, so any difference means the live file was changed
        // (or is out of date): an error, however the change is written.
        differences.push({ route: `/${name}`, severity: "error", kind: "text-changed", detail: `The live file differs from your build${spam.length ? ` and contains spam words (${spam.join(", ")})` : ""}. Redeploy, and if you didn't change it, check who can deploy your site.` });
      }
    }
    const images = new Set(model.pages.flatMap((p) => [...p.assets.keys()]));
    for (const image of images) {
      const live = await get(`${origin}/${image}`);
      if (live.status !== 200) differences.push({ route: `/${image}`, severity: "error", kind: "unreachable", detail: `Optimized image missing on the live site (HTTP ${live.status || "no response"}); browsers using srcset would show a broken image.` });
    }

    let crawlersChecked = 0;
    if (options.crawlers !== false) {
      const { checkCrawlability } = await import("./crawlability.js");
      const crawl = await checkCrawlability(origin, { fetch: doFetch });
      differences.push(...crawl.differences);
      crawlersChecked = crawl.crawlersChecked;
    }

    differences.sort((a, b) => (a.severity === b.severity ? a.route.localeCompare(b.route) : a.severity === "error" ? -1 : 1));
    return { ok: !differences.some((d) => d.severity === "error"), url: origin, pagesChecked: model.pages.length, crawlersChecked, differences };
  } finally {
    await loader.close();
  }
}
