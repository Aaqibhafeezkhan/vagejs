import fs from "node:fs";
import path from "node:path";
import { llmsFullTxt, llmsTxt, type LlmsPage } from "../discovery/llms.js";
import { feedPath, rssFeed } from "../discovery/feed.js";
import { gitPageDates } from "../discovery/git-dates.js";
import { copySource, htmlToMarkdown, markdownCopy, markdownCopyPath } from "../discovery/markdown-copy.js";
import { robotsTxt } from "../discovery/robots.js";
import { SITEMAP_URL_LIMIT, sitemapXml } from "../discovery/sitemap.js";
import { copyCanonicalsFit, headersFile } from "../deploy/headers.js";
import { cloudflareRedirects, netlifyRedirects } from "../deploy/redirects.js";
import { findSecrets } from "../deploy/secrets.js";
import { rulePack } from "../guidelines/pack.js";
import { absoluteUrl } from "../seo/urls.js";
import { loadConfig, type ModuleLoader, type SiteConfig } from "./config.js";
import { VageError } from "./errors.js";
import { escapeHtml } from "./html.js";
import { renderPage, type RenderedPage } from "./render.js";
import { parseFrontmatter } from "../content/markdown.js";
import { sharpResize } from "../content/optimize.js";
import { scheduledFor } from "./dates.js";
import { collection, collectPages, tagList, type PageSummary } from "./pages.js";
import { menuPageProblems } from "./menus.js";
import { discoverRoutes, findNotFoundPage, normalizeRequestPath, outFileFor, publicPath, routeKey } from "./routes.js";

export interface SitePage extends RenderedPage {
  route: string;
  /** Source path relative to the project root. */
  source: string;
  outFile: string;
}

export interface SiteRedirect {
  from: string;
  to: string;
  outFile: string;
  html: string;
}

export interface PageError {
  /** Source path relative to the project root. */
  source: string;
  /** The route the page would have had (links to it aren't reported again as broken). */
  route?: string;
  message: string;
}

export interface SiteModel {
  site: SiteConfig;
  /** Pages that failed to render (only with `collectErrors`; otherwise the first failure throws). */
  pageErrors: PageError[];
  /** Published pages (drafts excluded). */
  pages: SitePage[];
  skippedDrafts: string[];
  /** Routes of draft pages; links to them are broken in production. */
  draftRoutes: string[];
  /** Pages whose datePublished is still ahead: skipped until a build on or after that date. */
  skippedScheduled: { source: string; route: string; date: string }[];
  notFound?: SitePage;
  redirects: SiteRedirect[];
  /** Generated discovery files: output path -> content. */
  files: Map<string, string>;
  warnings: string[];
}

/** Renders every page and derives discovery files from the same data, without writing anything. */
export async function renderSite(root: string, load: ModuleLoader, options: { collectErrors?: boolean } = {}): Promise<SiteModel> {
  const pagesDir = path.join(root, "src", "pages");
  if (!fs.existsSync(pagesDir)) {
    throw new VageError(`No src/pages directory found in ${root}. Is this a vagejs project?`);
  }
  const site = await loadConfig(root, load);
  const pinned = site.guidelines.rulePack;
  if (pinned && pinned !== rulePack.version) {
    throw new VageError(
      `This project pins rule pack ${pinned}, but the installed vagejs ships ${rulePack.version}. ` +
        `Review what changed with "vage guidelines", then update guidelines.rulePack in vage.config.ts.`,
    );
  }
  const model: SiteModel = { site, pageErrors: [], pages: [], skippedDrafts: [], draftRoutes: [], skippedScheduled: [], redirects: [], files: new Map(), warnings: [] };
  const collect = options.collectErrors === true;
  const attempt = async (file: string, route: string | undefined, work: () => Promise<void>) => {
    try {
      await work();
    } catch (err) {
      if (!collect) throw err;
      // Layout code can throw anything (or fail to compile); report it as this page's error.
      const message = err instanceof VageError ? err.detail : `Layout or render error: ${(err as Error)?.message ?? String(err)}`;
      model.pageErrors.push({ source: path.relative(root, file), route, message });
    }
  };

  const pages = await collectPages(root, site, load, { skipInvalid: collect });
  // vage check reports these as menu-link findings instead.
  const menuProblems = collect ? [] : menuPageProblems(site, pages);
  if (menuProblems.length) throw new VageError(menuProblems.join("\n"), "vage.config.ts");
  // Loaded once for the whole site, so a missing sharp is one clear error, not one per page.
  const resize = site.images.optimize ? await sharpResize(root) : undefined;
  for (const entry of discoverRoutes(pagesDir, site.trailingSlash)) {
    const source = path.relative(root, entry.file);
    await attempt(entry.file, entry.route, async () => {
      // Drafts and scheduled pages are skipped before rendering, so their fields can't fail a build.
      const { frontmatter } = parseFrontmatter(fs.readFileSync(entry.file, "utf8"), entry.file);
      if (frontmatter.draft) {
        model.skippedDrafts.push(source);
        model.draftRoutes.push(entry.route);
        return;
      }
      const date = scheduledFor(frontmatter.datePublished);
      if (date) {
        model.skippedScheduled.push({ source, route: entry.route, date });
        return;
      }
      const page = await renderPage({ root, file: entry.file, route: entry.route, site, load, analytics: true, pages, resize });
      model.pages.push({ ...page, route: entry.route, source, outFile: entry.outFile });
    });
  }
  if (site.tags.pages) {
    // Only published pages can clash: a draft or scheduled page at a tag address isn't in the build.
    const taken = new Map(model.pages.map((p) => [p.route, p.source]));
    for (const tag of tagList(pages, site.trailingSlash)) {
      const file = path.join(pagesDir, "tags", `${tag.slug}.md`);
      const source = `(tag "${tag.name}")`;
      const route = routeKey(tag.route);
      await attempt(file, route, async () => {
        if (taken.has(route)) {
          throw new VageError(`${taken.get(route)} and the tag "${tag.name}" both make ${tag.route}. Rename one, or set tags.pages: false in vage.config.ts.`);
        }
        const page = await renderPage({ root, file, route, site, load, analytics: true, pages, resize, source: tagPageSource(site, tag.name, collection(pages, { tag: tag.name, sort: "date" })) });
        model.pages.push({ ...page, route, source, outFile: outFileFor(route, site.trailingSlash) });
      });
    }
  }
  const notFound = findNotFoundPage(pagesDir);
  if (notFound) {
    await attempt(notFound, undefined, async () => {
      const page = await renderPage({ root, file: notFound, route: "/404/", site, load, notFound: true, analytics: true, pages, resize });
      model.notFound = { ...page, route: "/404/", source: path.relative(root, notFound), outFile: "404.html" };
    });
  }

  checkPublicDir(root, model.warnings);
  // Markdown versions of pages, converted from their sanitized HTML (copies and llms-full.txt).
  const markdown = new Map<string, string>();
  if (site.seo.markdownCopies || (site.seo.llmsTxt && site.seo.llmsTxt.full)) {
    for (const p of listedPages(model)) markdown.set(p.route, await htmlToMarkdown(await copySource(p.html, p.content), { route: publicPath(p.route, site.trailingSlash), origin: site.site }));
  }
  model.redirects = buildRedirects(site, new Set(model.pages.map((p) => p.route)));
  addDiscoveryFiles(root, model, markdown);
  return model;
}

/** A tag page's Markdown: a heading and the tagged pages, newest first. Written as HTML so tag and page names can't become Markdown. */
export function tagPageSource(site: SiteConfig, name: string, tagged: PageSummary[]): string {
  const items = tagged.map((p) => `<li><a href="${escapeHtml(p.route)}">${escapeHtml(p.title)}</a>${p.description ? `: ${escapeHtml(p.description)}` : ""}</li>`);
  const description = `Pages${site.title ? ` on ${site.title}` : ""} tagged ${name}.`;
  return [
    "---",
    `title: ${JSON.stringify(`Tagged: ${name}`)}`,
    `description: ${JSON.stringify(description)}`,
    ...(site.tags.layout ? [`layout: ${site.tags.layout}`] : []),
    "---",
    "",
    `<h1>Tagged: ${escapeHtml(name)}</h1>`,
    "",
    `<ul>\n${items.join("\n")}\n</ul>`,
    "",
  ].join("\n");
}

/** Pages that should appear in sitemap.xml and llms.txt: indexable and canonical to themselves. */
export function listedPages(model: SiteModel): SitePage[] {
  return model.pages.filter((p) => !p.meta.noindex && p.meta.canonical === absoluteUrl(model.site.site, publicPath(p.route, model.site.trailingSlash)));
}

function addDiscoveryFiles(root: string, model: SiteModel, markdown: Map<string, string>) {
  const { site, files, warnings } = model;
  const listed = listedPages(model);
  const generate = (name: string, content: () => string) => {
    if (files.has(name)) throw new VageError(`Two generated files would be written to ${name}. Rename one of the pages behind it.`);
    if (fs.existsSync(path.join(root, "public", name))) {
      throw new VageError(
        `public/${name} conflicts with the generated ${name}. Delete it, or turn generation off in vage.config.ts (seo).`,
      );
    }
    files.set(name, content());
  };

  if (site.site && /^https?:\/\/(www\.)?example\.(com|org|net)$/.test(site.site)) {
    warnings.push(`"site" is still the placeholder ${site.site}; canonical URLs and sitemap.xml will point there. Set your real origin.`);
  }
  if (!site.site) {
    warnings.push('"site" is not set in vage.config.ts: canonical URLs, og:url, sitemap.xml and absolute image URLs are skipped.');
  }
  if (site.seo.robots) {
    const robots = site.seo.robots;
    generate("robots.txt", () => robotsTxt(site, robots));
  }
  if (site.seo.sitemap && site.site) {
    if (listed.length > SITEMAP_URL_LIMIT) {
      throw new VageError(`sitemap.xml would list ${listed.length} URLs; sitemap indexes (over ${SITEMAP_URL_LIMIT}) are not supported yet.`);
    }
    let gitDates: Map<string, string> | undefined;
    if (site.seo.lastmod === "git") {
      const result = gitPageDates(root);
      gitDates = result.dates;
      if (result.problem) warnings.push(`seo.lastmod is "git", but ${result.problem}; sitemap dates come from frontmatter instead.`);
    }
    generate("sitemap.xml", () =>
      sitemapXml(listed.map((p) => ({ url: p.meta.canonical!, lastmod: p.frontmatter.dateModified ?? gitDates?.get(p.source) ?? p.frontmatter.datePublished }))),
    );
  }
  for (const feed of site.seo.feeds) {
    if (!site.site) {
      warnings.push(`seo.feeds: the feed for ${feed.under} needs "site" in vage.config.ts and was skipped.`);
      continue;
    }
    if (!listed.some((p) => p.route.startsWith(feed.under) && p.route !== feed.under)) {
      warnings.push(`seo.feeds: no published pages under ${feed.under}, so its feed is empty.`);
    }
    generate(feedPath(feed.under), () => rssFeed(site, feed, listed, site.site!));
  }
  if (site.seo.markdownCopies) {
    for (const p of listed) generate(markdownCopyPath(p.route), () => markdownCopy(p.frontmatter.title, p.frontmatter.description, markdown.get(p.route) ?? ""));
  }
  const indexNow = site.integrations.indexNow;
  if (indexNow) generate(`${indexNow.key}.txt`, () => `${indexNow.key}\n`);
  // Cloudflare Pages, Workers static assets and Netlify all read _redirects and _headers.
  const netlify = site.deploy.target === "netlify";
  const cloudflare = site.deploy.target === "cloudflare-pages" || site.deploy.target === "cloudflare-workers";
  if (cloudflare && model.redirects.length) generate("_redirects", () => cloudflareRedirects(model.redirects));
  if (netlify && model.redirects.length) generate("_redirects", () => netlifyRedirects(model.redirects));
  if ((cloudflare || netlify) && site.security.headers) {
    const html = [...model.pages, ...(model.notFound ? [model.notFound] : []), ...model.redirects].map((p) => p.html);
    // Each Markdown copy names its HTML page as canonical, so search engines don't index both.
    const copies = site.seo.markdownCopies && site.site ? listed.map((p) => ({ path: `/${markdownCopyPath(p.route)}`, canonical: p.meta.canonical! })).filter((c) => /^\/[A-Za-z0-9._~\/-]+$/.test(c.path) && /^[^\s<>]+$/.test(c.canonical)) : [];
    if (!copyCanonicalsFit(copies.length)) {
      warnings.push(`_headers: ${copies.length} Markdown copies need more header rules than Cloudflare allows, so they're published without a canonical Link header.`);
    }
    generate("_headers", () => headersFile(html, site, copies));
  }
  if (site.seo.llmsTxt) {
    if (!site.title) {
      warnings.push('"title" is not set in vage.config.ts: llms.txt needs a site title and was skipped.');
    } else {
      const pages: LlmsPage[] = listed.map((p) => ({
        title: p.frontmatter.title,
        // With Markdown copies, AI tools are pointed at the plain-text version (llmstxt.org).
        url: site.seo.markdownCopies ? (absoluteUrl(site.site, `/${markdownCopyPath(p.route)}`) ?? `/${markdownCopyPath(p.route)}`) : (absoluteUrl(site.site, publicPath(p.route, site.trailingSlash)) ?? publicPath(p.route, site.trailingSlash)),
        description: p.frontmatter.description,
        body: markdown.get(p.route) ?? "",
      }));
      generate("llms.txt", () => llmsTxt(site.title!, site.description, pages));
      if (site.seo.llmsTxt.full) generate("llms-full.txt", () => llmsFullTxt(site.title!, site.description, pages));
    }
  }
}

/**
 * Everything in public/ is published. Refuses symlinks (they can point at files
 * outside the project) and files that look like secrets. Google browser API keys
 * are meant to be public when referrer-restricted, so they only warn.
 */
function checkPublicDir(root: string, warnings: string[]) {
  const publicDir = path.join(root, "public");
  if (!fs.existsSync(publicDir)) return;
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${e.name}`;
      if (e.isSymbolicLink()) {
        throw new VageError(`public/${rel} is a symlink. Copy the real file into public/ instead; links can expose files outside the project.`);
      }
      if (e.isDirectory()) walk(path.join(dir, e.name), `${rel}/`);
      else files.push(rel);
    }
  };
  walk(publicDir, "");
  const hits = findSecrets(publicDir, files);
  const blocking = hits.filter((h) => h.reason !== "looks like a Google API key");
  for (const h of hits.filter((h) => !blocking.includes(h))) {
    warnings.push(`public/${h.path} contains a Google API key and will be public. Fine for a referrer-restricted browser key; otherwise remove it.`);
  }
  if (blocking.length) {
    throw new VageError(
      `Refusing to publish possible secrets from public/:\n${blocking.map((h) => `  public/${h.path}: ${h.reason}`).join("\n")}\nEverything in public/ is served to the world. Move these files out (and rotate exposed credentials).`,
    );
  }
}

function buildRedirects(site: SiteConfig, routes: Set<string>): SiteRedirect[] {
  return Object.entries(site.redirects).map(([fromPath, to]) => {
    const from = normalizeRequestPath(fromPath);
    if (routes.has(from)) {
      throw new VageError(`Redirect source "${fromPath}" is also a page route. Remove the page or the redirect.`);
    }
    const target = absoluteUrl(site.site, to) ?? to;
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Redirecting…</title>
    <meta name="robots" content="noindex" />
    <link rel="canonical" href="${escapeHtml(target)}" />
    <meta http-equiv="refresh" content="0; url=${escapeHtml(to)}" />
  </head>
  <body>
    <p>This page has moved to <a href="${escapeHtml(to)}">${escapeHtml(to)}</a>.</p>
  </body>
</html>
`;
    return { from, to, outFile: outFileFor(from, site.trailingSlash), html };
  });
}
