import fs from "node:fs";
import path from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { VageError } from "../core/errors.js";
import type { SiteModel } from "../core/site.js";

/**
 * Defenses against injected spam (the classic hacked-site problem): links hidden with
 * CSS, outbound links nobody approved, and common spam vocabulary. These run in
 * `vage check` on the final HTML, so they cover page content and layouts alike.
 */

export const LINK_LOCK = "links.lock.json";

// ---------------------------------------------------------------- hidden links

const HIDING_STYLES: [RegExp, string][] = [
  [/display\s*:\s*none/i, "display:none"],
  [/visibility\s*:\s*(hidden|collapse)/i, "visibility:hidden"],
  [/opacity\s*:\s*0(\.0+)?\s*(;|$|!)/i, "opacity:0"],
  [/font-size\s*:\s*0(\.0+)?(px|em|rem|%)?\s*(;|$|!)/i, "font-size:0"],
  [/(^|;|\s)(width|height|max-width|max-height)\s*:\s*0(px)?\s*(;|$|!)/i, "zero size"],
  [/(^|;|\s)(left|top|right|bottom|margin-left|margin-top)\s*:\s*-\s*\d{3,}/i, "positioned off-screen"],
  [/text-indent\s*:\s*-\s*\d{3,}/i, "text pushed off-screen"],
  [/clip\s*:\s*rect\(\s*0/i, "clipped away"],
  [/clip-path\s*:\s*inset\(\s*(50%|100%)/i, "clipped away"],
];

export interface Hidden {
  reason: string;
  /** "strong": a CSS/SVG trick with no legitimate use around a link. "soft": hidden by a mechanism sites also use for menus (hidden, closed <details>). */
  strength: "strong" | "soft";
}

/** Why this element (or an ancestor) is hidden from people, if it is. Only inline signals; stylesheets aren't evaluated. */
export function hiddenReason(el: HTMLElement): Hidden | undefined {
  // A menu: a <details> menu button (on small screens) with a <nav> in or around it.
  let inNav = false;
  for (let node: HTMLElement | null = el; node && node.tagName; node = node.parentNode as HTMLElement | null) {
    const tag = node.tagName.toLowerCase();
    if (tag === "nav") inNav = true;
    const where = node === el ? "" : "inside ";
    const style = node.getAttribute?.("style");
    if (style) {
      const hit = HIDING_STYLES.find(([re]) => re.test(style));
      if (hit) return { reason: `${where ? "inside an element " : ""}hidden with ${hit[1]}`, strength: "strong" };
    }
    if (node.getAttribute?.("aria-hidden") === "true") return { reason: `${where}aria-hidden="true"`, strength: "strong" };
    if (tag === "svg" && (/^0(px)?$/.test(node.getAttribute("width") ?? "") || /^0(px)?$/.test(node.getAttribute("height") ?? ""))) {
      return { reason: "inside a zero-size <svg>", strength: "strong" };
    }
    if (node.hasAttribute?.("hidden")) return { reason: `inside a hidden <${tag}>`, strength: "soft" };
    if (tag === "details" && node !== el && !node.hasAttribute("open") && !el.closest?.("summary") && !inNav && !node.closest?.("nav")) {
      return { reason: "inside a closed <details>", strength: "soft" };
    }
  }
  return undefined;
}

/** A link with nothing a visitor can see or a screen reader can announce. */
export function isEmptyLink(a: HTMLElement): boolean {
  return !a.text.trim() && !a.getAttribute("aria-label") && !a.querySelector("img[alt]:not([alt=''])");
}

/** href of <a>/<area>, including SVG's xlink:href. */
export function linkTarget(a: HTMLElement): string | undefined {
  return a.getAttribute("href") ?? a.getAttribute("xlink:href") ?? undefined;
}

// ---------------------------------------------------------------- outbound links

/** Normalized host of an external http(s) link ("www." dropped), or undefined for internal/other links. */
export function externalHost(href: string, site: string | undefined): string | undefined {
  let url: URL;
  try {
    url = new URL(href.trim(), site ?? "https://site.invalid");
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const host = normalizeHost(url.hostname);
  const own = site ? normalizeHost(new URL(site).hostname) : "site.invalid";
  return host === own ? undefined : host;
}

/** Lowercase, punycode, no "www.", no trailing dot: one spelling per host. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** Places in a page that send visitors or search engines elsewhere, beyond <a>: all go through the link lock. */
const OTHER_TARGETS: [string, (el: HTMLElement) => string | undefined][] = [
  ['link[rel="canonical"]', (el) => el.getAttribute("href")],
  ['meta[property="og:url"]', (el) => el.getAttribute("content")],
  ["meta[http-equiv]", (el) => (/^refresh$/i.test(el.getAttribute("http-equiv") ?? "") ? /url\s*=\s*['"]?([^'";]+)/i.exec(el.getAttribute("content") ?? "")?.[1] : undefined)],
  ["iframe[src]", (el) => el.getAttribute("src")],
  ["form[action]", (el) => el.getAttribute("action")],
];

/** Every external host the built site links to, with the pages that link there. */
export function outboundHosts(model: SiteModel): Map<string, { route: string; source: string }[]> {
  const hosts = new Map<string, { route: string; source: string }[]>();
  const pages = model.notFound ? [...model.pages, model.notFound] : model.pages;
  for (const page of pages) {
    const seen = new Set<string>();
    const doc = parse(page.html);
    const targets = [
      ...doc.querySelectorAll("a, area").map(linkTarget),
      ...OTHER_TARGETS.flatMap(([selector, read]) => doc.querySelectorAll(selector).map(read)),
    ];
    for (const target of targets) {
      if (!target) continue;
      const host = externalHost(target, model.site.site);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      hosts.set(host, [...(hosts.get(host) ?? []), { route: page.route, source: page.source }]);
    }
  }
  return new Map([...hosts].sort(([a], [b]) => a.localeCompare(b)));
}

export interface LinkLock {
  domains: string[];
}

export function readLinkLock(root: string): LinkLock | undefined {
  const file = path.join(root, LINK_LOCK);
  if (!fs.existsSync(file)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new VageError(`${LINK_LOCK} is not valid JSON: ${(err as Error).message}`, file);
  }
  const domains = (data as { domains?: unknown })?.domains;
  if (!Array.isArray(domains) || !domains.every((d) => typeof d === "string")) {
    throw new VageError(`${LINK_LOCK} must look like { "domains": ["example.com"] }.`, file);
  }
  return { domains: domains.map(normalizeHost) };
}

export function writeLinkLock(root: string, domains: Iterable<string>): void {
  const sorted = [...new Set(domains)].sort();
  const body = {
    $comment: "External domains this site may link to. vage check fails on links to any other domain. Only the site owner approves new ones: npx vage links approve <domain>",
    domains: sorted,
  };
  fs.writeFileSync(path.join(root, LINK_LOCK), `${JSON.stringify(body, null, 2)}\n`);
}

// ---------------------------------------------------------------- spam vocabulary

/** Words that rarely appear on legitimate business sites but are staples of injected spam. Warnings only. */
export const SPAM_PATTERNS: [RegExp, string][] = [
  [/\b(online|best|free|top)\s+casinos?\b|\bcasino\s+(bonus|online|games?|sites?)\b/i, "casino"],
  [/\b(viagra|cialis|levitra|kamagra)\b/i, "pharmacy spam"],
  [/\bpayday\s+loans?\b/i, "payday loans"],
  [/\breplica\s+(watches|handbags|bags|rolex)\b/i, "replica goods"],
  [/\bescort\s+(girls|agency|agencies)\b/i, "escort ads"],
  [/\bporn\b|\bxxx\s+(videos?|porn|sex)\b/i, "adult content"],
  [/\bbuy\s+(cheap\s+)?(followers|backlinks|likes)\b/i, "bought followers or backlinks"],
  [/\bonline\s+slots\b|\bslot\s+gacor\b|\bjudi\s+online\b/i, "online gambling"],
];

export function spamHits(text: string): string[] {
  return [...new Set(SPAM_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label))];
}
