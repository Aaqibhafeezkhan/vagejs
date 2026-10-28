import { ruleData } from "../guidelines/pack.js";

export interface SitemapEntry {
  url: string;
  /** Only set from frontmatter dates; file timestamps are not trustworthy after a git checkout. */
  lastmod?: string;
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);

/**
 * Every <lastmod> as a plain date (YYYY-MM-DD), so one sitemap never mixes formats: frontmatter
 * gives dates, git gives timestamps, and a date can't be given a time it doesn't have. A
 * timestamp keeps the day it has in its own time zone.
 */
export function lastmodDate(value: string): string | undefined {
  return /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
}

/** A single urlset. The 50,000-URL limit per file is enforced by the caller. */
export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map((e) => {
      const lastmod = e.lastmod && lastmodDate(e.lastmod);
      return `  <url>\n    <loc>${xml(e.url)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ""}\n  </url>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export const SITEMAP_URL_LIMIT = ruleData<{ maxUrls: number }>("sitemap.limits").maxUrls;
