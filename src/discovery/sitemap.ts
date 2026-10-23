import { ruleData } from "../guidelines/pack.js";

export interface SitemapEntry {
  url: string;
  /** Only set from frontmatter dates; file timestamps are not trustworthy after a git checkout. */
  lastmod?: string;
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);

/** A single urlset. The 50,000-URL limit per file is enforced by the caller. */
export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => `  <url>\n    <loc>${xml(e.url)}</loc>${e.lastmod ? `\n    <lastmod>${xml(e.lastmod)}</lastmod>` : ""}\n  </url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export const SITEMAP_URL_LIMIT = ruleData<{ maxUrls: number }>("sitemap.limits").maxUrls;
