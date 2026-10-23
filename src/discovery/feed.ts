import type { SiteConfig } from "../core/config.js";
import type { SitePage } from "../core/site.js";

export interface FeedConfig {
  under: string;
  title?: string;
  description?: string;
  limit: number;
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);

/** Where a section's feed is published: "/blog/" -> "blog/feed.xml". */
export function feedPath(under: string): string {
  return `${under.replace(/^\/+/, "")}feed.xml`;
}

/** RFC 822 date, as RSS requires: "Thu, 23 Oct 2026 00:00:00 GMT". */
function rfc822(iso: string): string {
  return new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toUTCString();
}

/**
 * RSS 2.0 for one section: its listed pages, newest datePublished first (undated last).
 * Item descriptions are the page descriptions; dates come only from frontmatter, so the
 * feed is the same on every build.
 */
export function rssFeed(site: SiteConfig, feed: FeedConfig, pages: SitePage[], origin: string): string {
  const items = pages
    .filter((p) => p.route.startsWith(feed.under) && p.route !== feed.under)
    .sort((a, b) => {
      const da = a.frontmatter.datePublished ?? "";
      const db = b.frontmatter.datePublished ?? "";
      return da === db ? a.frontmatter.title.localeCompare(b.frontmatter.title) : da && db ? db.localeCompare(da) : da ? -1 : 1;
    })
    .slice(0, feed.limit);
  const section = pages.find((p) => p.route === feed.under);
  const title = feed.title ?? (section ? `${section.frontmatter.title}${site.title ? ` | ${site.title}` : ""}` : (site.title ?? feed.under));
  const description = feed.description ?? section?.frontmatter.description ?? site.description ?? title;
  const self = `${origin}/${feedPath(feed.under)}`;
  const newest = items.find((p) => p.frontmatter.datePublished)?.frontmatter.datePublished;
  const body = items
    .map((p) => {
      const link = p.meta.canonical ?? `${origin}${p.route}`;
      const date = p.frontmatter.datePublished;
      return [
        "    <item>",
        `      <title>${xml(p.frontmatter.title)}</title>`,
        `      <link>${xml(link)}</link>`,
        `      <guid isPermaLink="true">${xml(link)}</guid>`,
        p.frontmatter.description ? `      <description>${xml(p.frontmatter.description)}</description>` : "",
        date ? `      <pubDate>${rfc822(date)}</pubDate>` : "",
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(title)}</title>
    <link>${xml(`${origin}${feed.under}`)}</link>
    <description>${xml(description)}</description>
    <language>${xml(site.lang)}</language>
    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml" />${newest ? `\n    <lastBuildDate>${rfc822(newest)}</lastBuildDate>` : ""}
${body}
  </channel>
</rss>
`;
}
