import type { SiteConfig } from "../core/config.js";
import { publicPath } from "../core/routes.js";
import { instant } from "../core/dates.js";
import { pageLang } from "../core/i18n.js";
import type { SitePage } from "../core/site.js";

export interface FeedConfig {
  under: string;
  title?: string;
  description?: string;
  limit: number;
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);

/** The feed's title: configured, else the site title. Used for the channel and the page links. */
export function feedTitle(site: SiteConfig, feed: { title?: string; under: string }): string {
  return feed.title ?? site.title ?? feed.under;
}

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
    // With i18n, a feed lists only its own language: "/" doesn't include /fr/... pages.
    .filter((p) => p.route.startsWith(feed.under) && p.route !== feed.under && pageLang(site, p.route) === pageLang(site, feed.under))
    .sort((a, b) => {
      // Compare as instants: "2026-10-23T23:00:00-05:00" is after "2026-10-24".
      const ta = instant(a.frontmatter.datePublished);
      const tb = instant(b.frontmatter.datePublished);
      if (ta === tb || (Number.isNaN(ta) && Number.isNaN(tb))) return a.frontmatter.title.localeCompare(b.frontmatter.title);
      return Number.isNaN(ta) ? 1 : Number.isNaN(tb) ? -1 : tb - ta;
    })
    .slice(0, feed.limit);
  const section = pages.find((p) => p.route === feed.under);
  // Same default as the <link rel="alternate"> title on the pages.
  const title = feedTitle(site, feed);
  const description = feed.description ?? section?.frontmatter.description ?? site.description ?? title;
  const self = `${origin}/${feedPath(feed.under)}`;
  const newest = items.find((p) => p.frontmatter.datePublished)?.frontmatter.datePublished; // items are sorted newest first
  const body = items
    .map((p) => {
      const link = p.meta.canonical ?? `${origin}${publicPath(p.route, site.trailingSlash)}`;
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
    <link>${xml(`${origin}${publicPath(feed.under, site.trailingSlash)}`)}</link>
    <description>${xml(description)}</description>
    <language>${xml(pageLang(site, feed.under))}</language>
    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml" />${newest ? `\n    <lastBuildDate>${rfc822(newest)}</lastBuildDate>` : ""}
${body}
  </channel>
</rss>
`;
}
