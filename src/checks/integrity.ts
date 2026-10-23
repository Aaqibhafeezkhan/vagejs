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

/** Why this element (or an ancestor) is hidden from people, if it is. Only inline signals; stylesheets aren't evaluated. */
export function hiddenReason(el: HTMLElement): string | undefined {
  for (let node: HTMLElement | null = el; node && node.tagName; node = node.parentNode as HTMLElement | null) {
    if (node.hasAttribute?.("hidden")) return `inside a hidden <${node.tagName.toLowerCase()}>`;
    const style = node.getAttribute?.("style");
    if (style) {
      const hit = HIDING_STYLES.find(([re]) => re.test(style));
      if (hit) return node === el ? `hidden with ${hit[1]}` : `inside an element hidden with ${hit[1]}`;
    }
  }
  return undefined;
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
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const own = site ? new URL(site).hostname.toLowerCase().replace(/^www\./, "") : "site.invalid";
  return host === own ? undefined : host;
}

/** Every external host the built site links to, with the pages that link there. */
export function outboundHosts(model: SiteModel): Map<string, { route: string; source: string }[]> {
  const hosts = new Map<string, { route: string; source: string }[]>();
  const pages = model.notFound ? [...model.pages, model.notFound] : model.pages;
  for (const page of pages) {
    const seen = new Set<string>();
    for (const a of parse(page.html).querySelectorAll("a[href], area[href]")) {
      const host = externalHost(a.getAttribute("href")!, model.site.site);
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
  return { domains: domains.map((d) => d.toLowerCase().replace(/^www\./, "")) };
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
  [/\b(online\s+)?casinos?\b/i, "casino"],
  [/\b(viagra|cialis|levitra|kamagra)\b/i, "pharmacy spam"],
  [/\bpayday\s+loans?\b/i, "payday loans"],
  [/\breplica\s+(watches|handbags|bags|rolex)\b/i, "replica goods"],
  [/\bescort\s+(service|services|girls|agency)\b/i, "escort ads"],
  [/\b(porn|xxx)\b/i, "adult content"],
  [/\bbuy\s+(cheap\s+)?(followers|backlinks|likes)\b/i, "bought followers or backlinks"],
  [/\bonline\s+slots?\b|\bslot\s+gacor\b/i, "online slots"],
];

export function spamHits(text: string): string[] {
  return [...new Set(SPAM_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label))];
}
