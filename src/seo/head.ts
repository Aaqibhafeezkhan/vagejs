import type { Frontmatter } from "../content/markdown.js";
import type { SiteConfig } from "../core/config.js";
import { VageError } from "../core/errors.js";
import { escapeHtml } from "../core/html.js";
import { feedTitle } from "../discovery/feed.js";
import { article, jsonLdScript, organization, website, type Thing } from "./jsonld.js";
import { publicPath } from "../core/routes.js";
import type { Translation } from "../core/i18n.js";
import { absoluteUrl } from "./urls.js";

export interface PageMeta {
  /** Route key (always with a trailing slash). */
  route: string;
  frontmatter: Frontmatter;
  /** Absolute canonical URL, when `site` is configured and the page is indexable. */
  canonical?: string;
  noindex: boolean;
  /** Language versions of the page (i18n), for hreflang links; set when rendering. */
  translations?: Translation[];
}

export function pageMeta(site: SiteConfig, route: string, frontmatter: Frontmatter, notFound = false): PageMeta {
  const noindex = notFound || frontmatter.noindex;
  const canonical = noindex ? undefined : absoluteUrl(site.site, frontmatter.canonical ?? publicPath(route, site.trailingSlash));
  return { route, frontmatter, canonical, noindex };
}

interface Tag {
  /** Matches an equivalent tag the layout already wrote; if found, ours is skipped. */
  exists: RegExp;
  html: string;
}

const meta = (attr: "name" | "property", key: string, content: string): Tag => ({
  exists: new RegExp(`<meta[^>]+${attr}=["']${key}["']`, "i"),
  html: `<meta ${attr}="${key}" content="${escapeHtml(content)}" />`,
});

/** Builds the SEO tags for a page. Tags are omitted when their data is unknown; nothing is invented. */
export function headTags(site: SiteConfig, m: PageMeta): Tag[] {
  const fm = m.frontmatter;
  const description = fm.description ?? site.description;
  const image = fm.image ? absoluteUrl(site.site, fm.image) : undefined;
  const tags: Tag[] = [];

  if (description) tags.push(meta("name", "description", description));
  if (m.noindex) tags.push(meta("name", "robots", "noindex"));
  if (m.canonical) {
    tags.push({
      exists: /<link[^>]+rel=["']canonical["']/i,
      html: `<link rel="canonical" href="${escapeHtml(m.canonical)}" />`,
    });
  }

  // hreflang: every indexable language version, itself included, plus x-default for the main language.
  const alternates = m.canonical ? (m.translations ?? []).filter((t) => t.url) : [];
  if (alternates.length > 1) {
    const link = (lang: string, url: string): Tag => ({
      exists: new RegExp(`<link[^>]+hreflang=["']${lang}["']`, "i"),
      html: `<link rel="alternate" hreflang="${escapeHtml(lang)}" href="${escapeHtml(url)}" />`,
    });
    for (const t of alternates) tags.push(link(t.lang, t.url!));
    const main = alternates.find((t) => t.lang === site.lang);
    if (main) tags.push(link("x-default", main.url!));
  }

  tags.push(meta("property", "og:title", fm.title));
  tags.push(meta("property", "og:type", fm.type));
  if (description) tags.push(meta("property", "og:description", description));
  if (m.canonical) tags.push(meta("property", "og:url", m.canonical));
  if (site.title) tags.push(meta("property", "og:site_name", site.title));
  if (image) tags.push(meta("property", "og:image", image));
  tags.push(meta("name", "twitter:card", image ? "summary_large_image" : "summary"));

  // Markdown copy for AI tools (seo.markdownCopies), on pages that are listed.
  if (site.seo.markdownCopies && m.canonical && m.canonical === absoluteUrl(site.site, publicPath(m.route, site.trailingSlash))) {
    const href = m.route === "/" ? "/index.md" : `${m.route.slice(0, -1)}.md`;
    tags.push({ exists: /<link[^>]+text\/markdown/i, html: `<link rel="alternate" type="text/markdown" href="${escapeHtml(href)}" />` });
  }

  // Feed discovery: pages in a section with a feed point readers to it.
  for (const feed of site.site ? site.seo.feeds : []) {
    if (!m.route.startsWith(feed.under)) continue;
    const href = `${site.site}${feed.under}feed.xml`;
    tags.push({
      exists: /<link[^>]+application\/rss\+xml/i,
      html: `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(feedTitle(site, feed))}" href="${escapeHtml(href)}" />`,
    });
  }

  const schemas = structuredData(site, m, description, image);
  if (schemas.length) {
    tags.push({ exists: /<script[^>]+application\/ld\+json/i, html: jsonLdScript(schemas.length === 1 ? schemas[0]! : schemas) });
  }
  return tags;
}

function structuredData(site: SiteConfig, m: PageMeta, description?: string, image?: string): Thing[] {
  const options = site.seo.structuredData;
  if (!options || m.noindex) return [];
  const out: Thing[] = [];
  if (m.route === "/") {
    if (site.title && site.site) out.push(website({ name: site.title, url: `${site.site}/` }));
    if (options.organization) {
      const { logo, ...org } = options.organization;
      out.push(organization({ ...org, logo: logo ? absoluteUrl(site.site, logo) : undefined }));
    }
  }
  if (m.frontmatter.type === "article") {
    const fm = m.frontmatter;
    out.push(
      article({
        headline: fm.title,
        description,
        url: m.canonical,
        image,
        datePublished: fm.datePublished,
        dateModified: fm.dateModified,
        author: fm.author,
      }),
    );
  }
  return out;
}

/** Inserts tags before </head>, skipping any the layout already provides. */
export function injectHead(html: string, tags: Tag[], file: string): string {
  const index = html.search(/<\/head>/i);
  if (index === -1) throw new VageError("Layout output has no </head>; vagejs needs it to add SEO tags.", file);
  const head = html.slice(0, index);
  const add = tags.filter((t) => !t.exists.test(head)).map((t) => `    ${t.html}\n`).join("");
  // Insert at the start of the </head> line when it is only indented, to keep the output tidy.
  const lineStart = head.lastIndexOf("\n") + 1;
  const at = /^\s*$/.test(head.slice(lineStart)) ? lineStart : index;
  return html.slice(0, at) + add + html.slice(at);
}
