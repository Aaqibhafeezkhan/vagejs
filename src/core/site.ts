import fs from "node:fs";
import path from "node:path";
import { llmsFullTxt, llmsTxt, type LlmsPage } from "../discovery/llms.js";
import { robotsTxt } from "../discovery/robots.js";
import { SITEMAP_URL_LIMIT, sitemapXml } from "../discovery/sitemap.js";
import { rulePack } from "../guidelines/pack.js";
import { absoluteUrl } from "../seo/urls.js";
import { loadConfig, type ModuleLoader, type SiteConfig } from "./config.js";
import { VageError } from "./errors.js";
import { escapeHtml } from "./html.js";
import { renderPage, type RenderedPage } from "./render.js";
import { discoverRoutes, findNotFoundPage, normalizeRequestPath } from "./routes.js";

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

export interface SiteModel {
  site: SiteConfig;
  /** Published pages (drafts excluded). */
  pages: SitePage[];
  skippedDrafts: string[];
  /** Routes of draft pages; links to them are broken in production. */
  draftRoutes: string[];
  notFound?: SitePage;
  redirects: SiteRedirect[];
  /** Generated discovery files: output path -> content. */
  files: Map<string, string>;
  warnings: string[];
}

/** Renders every page and derives discovery files from the same data, without writing anything. */
export async function renderSite(root: string, load: ModuleLoader): Promise<SiteModel> {
  const pagesDir = path.join(root, "src", "pages");
  if (!fs.existsSync(pagesDir)) {
    throw new VageError(`No src/pages directory found in ${root}. Is this a VAGE JS project?`);
  }
  const site = await loadConfig(root, load);
  const pinned = site.guidelines.rulePack;
  if (pinned && pinned !== rulePack.version) {
    throw new VageError(
      `This project pins rule pack ${pinned}, but the installed vagejs ships ${rulePack.version}. ` +
        `Review what changed with "vage guidelines", then update guidelines.rulePack in vage.config.ts.`,
    );
  }
  const model: SiteModel = { site, pages: [], skippedDrafts: [], draftRoutes: [], redirects: [], files: new Map(), warnings: [] };

  for (const entry of discoverRoutes(pagesDir)) {
    const page = await renderPage({ root, file: entry.file, route: entry.route, site, load, analytics: true });
    const source = path.relative(root, entry.file);
    if (page.frontmatter.draft) {
      model.skippedDrafts.push(source);
      model.draftRoutes.push(entry.route);
    }
    else model.pages.push({ ...page, route: entry.route, source, outFile: entry.outFile });
  }
  const notFound = findNotFoundPage(pagesDir);
  if (notFound) {
    const page = await renderPage({ root, file: notFound, route: "/404/", site, load, notFound: true, analytics: true });
    model.notFound = { ...page, route: "/404/", source: path.relative(root, notFound), outFile: "404.html" };
  }

  model.redirects = buildRedirects(site, new Set(model.pages.map((p) => p.route)));
  addDiscoveryFiles(root, model);
  return model;
}

/** Pages that should appear in sitemap.xml and llms.txt: indexable and canonical to themselves. */
export function listedPages(model: SiteModel): SitePage[] {
  return model.pages.filter((p) => !p.meta.noindex && p.meta.canonical === absoluteUrl(model.site.site, p.route));
}

function addDiscoveryFiles(root: string, model: SiteModel) {
  const { site, files, warnings } = model;
  const listed = listedPages(model);
  const generate = (name: string, content: () => string) => {
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
    generate("sitemap.xml", () =>
      sitemapXml(listed.map((p) => ({ url: p.meta.canonical!, lastmod: p.frontmatter.dateModified ?? p.frontmatter.datePublished }))),
    );
  }
  if (site.seo.llmsTxt) {
    if (!site.title) {
      warnings.push('"title" is not set in vage.config.ts: llms.txt needs a site title and was skipped.');
    } else {
      const pages: LlmsPage[] = listed.map((p) => ({
        title: p.frontmatter.title,
        url: absoluteUrl(site.site, p.route) ?? p.route,
        description: p.frontmatter.description,
        body: p.body,
      }));
      generate("llms.txt", () => llmsTxt(site.title!, site.description, pages));
      if (site.seo.llmsTxt.full) generate("llms-full.txt", () => llmsFullTxt(site.title!, site.description, pages));
    }
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
    return { from, to, outFile: path.posix.join(from.slice(1), "index.html"), html };
  });
}
