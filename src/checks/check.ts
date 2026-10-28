import fs from "node:fs";
import path from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { createBuildLoader } from "../core/loader.js";
import { parseFrontmatter } from "../content/markdown.js";
import { scheduledFor } from "../core/dates.js";
import { normalizeRequestPath, outFileFor, publicPath, routeForPage, routeKey } from "../core/routes.js";
import { menuEntries, sitePath } from "../core/menus.js";
import { pageLang, translationKey } from "../core/i18n.js";
import { islandKeys, ISLANDS_DIR } from "../core/islands.js";
import { basePath, siteOrigin } from "../core/base.js";
import { gitRaw } from "../deploy/git.js";
import { listedPages, renderSite, type SiteModel, type SitePage } from "../core/site.js";
import { externalHost, hiddenReason, isEmptyLink, LINK_LOCK, linkTarget, outboundHosts, readLinkLock, spamHits } from "./integrity.js";

export type Severity = "error" | "warning";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** Route of the page the finding is about, if any. */
  page?: string;
  /** Source file relative to the project root, if any. */
  source?: string;
  /** Official documentation backing the rule, where one exists. */
  docs?: string;
}

export interface CheckResult {
  ok: boolean;
  errors: number;
  warnings: number;
  pagesChecked: number;
  findings: Finding[];
}

const DOCS = {
  title: "https://developers.google.com/search/docs/appearance/title-link",
  description: "https://developers.google.com/search/docs/appearance/snippet",
  canonical: "https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls",
  structuredData: "https://developers.google.com/search/docs/appearance/structured-data/sd-policies",
  article: "https://developers.google.com/search/docs/appearance/structured-data/article",
  imgAlt: "https://www.w3.org/WAI/tutorials/images/",
  lang: "https://www.w3.org/WAI/WCAG22/Understanding/language-of-page.html",
  linkPurpose: "https://www.w3.org/WAI/WCAG22/Understanding/link-purpose-in-context.html",
  robots: "https://developers.google.com/search/docs/crawling-indexing/robots/intro",
  yamlFlow: "https://yaml.org/spec/1.2.2/#74-flow-collection-styles",
};

/** Paths of frontmatter values that came out empty (null), e.g. "faq.items[3].Claude and other AI search?". */
export function emptyValues(value: unknown, at = ""): string[] {
  if (value === null) return [at || "(frontmatter)"];
  if (Array.isArray(value)) return value.flatMap((v, i) => emptyValues(v, `${at}[${i}]`));
  if (typeof value === "object" && value !== undefined) {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => emptyValues(v, at ? `${at}.${k}` : k));
  }
  return [];
}

/**
 * Static checks on the rendered site (nothing is written to disk).
 * Passing checks mean the output is technically sound; they do not guarantee
 * indexing, rankings, rich results or AI citations.
 */
export async function check(root: string, options: { strict?: boolean } = {}): Promise<CheckResult> {
  root = path.resolve(root);
  const loader = await createBuildLoader(root);
  try {
    const model = await renderSite(root, loader.load, { collectErrors: true });
    const findings = [...checkSite(root, model), ...(await checkRemovedPages(root, model))];
    const errors = findings.filter((f) => f.severity === "error").length;
    const warnings = findings.length - errors;
    return {
      ok: errors === 0 && (!options.strict || warnings === 0),
      errors,
      warnings,
      pagesChecked: model.pages.length + (model.notFound ? 1 : 0) + model.pageErrors.length,
      findings,
    };
  } finally {
    await loader.close();
  }
}

export function checkSite(root: string, model: SiteModel): Finding[] {
  const findings: Finding[] = model.warnings.map((message) => ({ rule: "config", severity: "warning", message }));
  for (const e of model.pageErrors) findings.push({ rule: "page-error", severity: "error", message: e.message, source: e.source });
  const outputs = outputPaths(root, model);
  // Pages that failed to render are already reported; links to them aren't broken links on top of that.
  for (const e of model.pageErrors) if (e.route) outputs.add(`/${outFileFor(e.route, model.site.trailingSlash)}`);
  const drafts = new Set(model.draftRoutes);
  const scheduled = new Map(model.skippedScheduled.map((s) => [s.route, s.date]));
  const pages = model.notFound ? [...model.pages, model.notFound] : model.pages;

  const docs = pages.map((page) => ({ page, doc: parse(page.html) }));
  // Link targets on each output file: element ids and <a name>, for #fragment links.
  const anchors = new Map(
    docs.map(({ page, doc }) => [
      `/${page.outFile}`,
      new Set([...doc.querySelectorAll("[id]").map((el) => el.getAttribute("id")!), ...doc.querySelectorAll("a[name]").map((el) => el.getAttribute("name")!)]),
    ]),
  );
  for (const { page, doc } of docs) {
    const add = (f: Omit<Finding, "page" | "source">) => findings.push({ ...f, page: page.route, source: page.source });
    checkPage(page, doc, model, outputs, drafts, scheduled, anchors, add);
  }
  findings.push(...checkDuplicates(listedPages(model)));
  findings.push(...checkTranslations(model));
  findings.push(...checkRobots(model));
  findings.push(...checkContact(model, outputs));
  findings.push(...checkRedirectTargets(model, outputs));
  findings.push(...checkMenus(model, outputs));
  findings.push(...checkOutboundLinks(root, model));
  findings.push(...checkVercelCleanUrls(root, model));
  return findings;
}

function checkPage(
  page: SitePage,
  doc: HTMLElement,
  model: SiteModel,
  outputs: Set<string>,
  drafts: Set<string>,
  scheduled: Map<string, string>,
  anchors: Map<string, Set<string>>,
  add: (f: Omit<Finding, "page" | "source">) => void,
) {
  const indexable = !page.meta.noindex;
  // Relative links resolve against the address the browser shows ("/about" with trailingSlash "never").
  const base = publicPath(page.route, model.site.trailingSlash);

  if (model.site.security.spamPatterns) {
    const text = `${doc.querySelector("body")?.text ?? ""} ${doc.querySelectorAll("a[href]").map((a) => a.getAttribute("href")).join(" ")}`;
    const hits = spamHits(text);
    if (hits.length) {
      add({
        rule: "spam-pattern",
        severity: "warning",
        message: `Page contains words common in injected spam (${hits.join(", ")}). If you didn't write them, check this page's history. Turn off with security.spamPatterns: false.`,
      });
    }
  }

  for (const key of emptyValues(page.frontmatter)) {
    add({
      rule: "frontmatter-empty",
      severity: "warning",
      message: `Frontmatter "${key}" has no value. If you meant to write text there, check for a missing value; inside { } a comma or colon splits the text, so wrap it in quotes.`,
      docs: DOCS.yamlFlow,
    });
  }

  const htmlLang = doc.querySelector("html")?.getAttribute("lang");
  if (!htmlLang) {
    add({ rule: "html-lang", severity: "error", message: "<html> has no lang attribute.", docs: DOCS.lang });
  } else if (model.site.i18n && htmlLang !== pageLang(model.site, page.route)) {
    add({
      rule: "html-lang",
      severity: "error",
      message: `<html lang="${htmlLang}"> doesn't match the page's language "${pageLang(model.site, page.route)}" (from its folder). Use page.lang in the layout: <html lang="\${page.lang}">.`,
      docs: DOCS.lang,
    });
  }
  const idCounts = new Map<string, number>();
  for (const el of doc.querySelectorAll("[id]")) idCounts.set(el.getAttribute("id")!, (idCounts.get(el.getAttribute("id")!) ?? 0) + 1);
  const duplicateIds = [...idCounts].filter(([, n]) => n > 1).map(([id]) => `"${id}"`);
  if (duplicateIds.length) {
    add({
      rule: "id-duplicate",
      severity: "warning",
      message: `More than one element has the id ${duplicateIds.join(", ")}. Links to that #section and labels that point to it reach only the first. Rename the heading (or set its id), or change the id in the layout.`,
    });
  }
  const titles = doc.querySelectorAll("title");
  if (titles.length !== 1 || !titles[0]!.text.trim()) {
    add({ rule: "title", severity: "error", message: `Expected exactly one non-empty <title>, found ${titles.length}.`, docs: DOCS.title });
  }
  // Only pages shown in search results can be shortened there.
  const renderedTitle = titles[0]?.text.trim() ?? "";
  if (indexable && renderedTitle.length > 60) {
    add({
      rule: "title-length",
      severity: "warning",
      message: `Rendered <title> in "${page.source}" is ${renderedTitle.length} characters; it may be shortened in search results.`,
      docs: DOCS.title,
    });
  }
  const description = doc.querySelector('meta[name="description"]')?.getAttribute("content")?.trim() ?? "";
  if (indexable && description.length > 160) {
    add({
      rule: "meta-description-length",
      severity: "warning",
      message: `Meta description in "${page.source}" is ${description.length} characters; it may be shortened in search results.`,
      docs: DOCS.description,
    });
  }
  if (indexable && !doc.querySelector('meta[name="description"]')?.getAttribute("content")) {
    add({
      rule: "meta-description",
      severity: "warning",
      message: "No meta description. Add `description` to the frontmatter or site config.",
      docs: DOCS.description,
    });
  }
  if (!doc.querySelector("h1")) {
    add({ rule: "h1", severity: "warning", message: "Page has no <h1> heading." });
  }

  for (const img of doc.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (img.getAttribute("alt") === undefined) {
      add({ rule: "img-alt", severity: "error", message: `<img src="${src}"> has no alt attribute (use alt="" for decorative images).`, docs: DOCS.imgAlt });
    }
    if (!img.getAttribute("width") || !img.getAttribute("height")) {
      add({ rule: "img-dimensions", severity: "warning", message: `<img src="${src}"> has no width/height; this can cause layout shift.` });
    }
  }

  for (const el of doc.querySelectorAll("[href], [src], [action], [formaction]")) {
    for (const attr of ["href", "src", "action", "formaction"]) {
      const value = el.getAttribute(attr);
      if (value && /^\s*(javascript|vbscript|data:text\/html)/i.test(value.replace(/[\u0000-\u0020]/g, ""))) {
        add({ rule: "unsafe-url", severity: "error", message: `<${el.tagName.toLowerCase()} ${attr}="${value.slice(0, 60)}"> uses a script URL; this runs code on your site.` });
      }
    }
  }

  const site = model.site;
  if (["cloudflare-pages", "cloudflare-workers", "netlify"].includes(site.deploy.target) && site.security.headers && site.security.csp === "enforce") {
    for (const el of doc.querySelectorAll("*")) {
      const handler = Object.keys(el.attributes).find((a) => /^on[a-z]+$/i.test(a));
      if (handler) {
        add({
          rule: "csp-inline-handler",
          severity: "warning",
          message: `<${el.tagName.toLowerCase()} ${handler}="…"> is an inline event handler; the Content Security Policy blocks it. Use addEventListener in a script file.`,
        });
      }
    }
  }

  for (const a of doc.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")!;
    checkHiddenLink(a, href, model, add);
    if (!a.text.trim() && !a.getAttribute("aria-label") && !a.querySelector("img[alt]:not([alt=''])")) {
      add({ rule: "link-text", severity: "warning", message: `Link to "${href}" has no accessible text.`, docs: DOCS.linkPurpose });
    }
    if (/^#./.test(href.trim())) {
      checkFragment(href, `/${page.outFile}`, anchors, add);
      continue;
    }
    const target = internalPath(href, base, model.site.site);
    if (target === undefined) continue;
    if (target === MALFORMED) {
      add({ rule: "link-broken", severity: "error", message: `Link to "${href}" is a malformed URL.` });
      continue;
    }
    const resolved = resolveOutput(target, outputs);
    if (resolved === "ok") checkFragment(href, outputFile(target, outputs), anchors, add);
    if (resolved === "missing") {
      const route = target.endsWith("/") ? target : `${target}/`;
      const date = scheduled.get(route);
      add({
        rule: "link-broken",
        severity: "error",
        message: drafts.has(route)
          ? `Link to "${href}" points to a draft page, which is not published.`
          : date
            ? `Link to "${href}" points to a page scheduled for ${date}, which is not published yet.`
            : `Link to "${href}" does not match any page or file.`,
      });
    } else if (resolved === "needs-slash") {
      add({ rule: "link-trailing-slash", severity: "warning", message: `Link to "${href}" redirects; use "${target}/".` });
    } else if (resolved === "no-slash") {
      add({ rule: "link-trailing-slash", severity: "warning", message: `Link to "${href}" redirects; use "${target.slice(0, -1)}" (this site uses trailingSlash: "never").` });
    }
  }

  // SVG links (a xlink:href) aren't in the loop above; they get the hidden-link check too.
  for (const a of doc.querySelectorAll("a")) {
    if (!a.hasAttribute("href") && a.getAttribute("xlink:href")) checkHiddenLink(a, linkTarget(a)!, model, add);
  }

  for (const [selector, attr] of [
    ["img[src]", "src"],
    ["script[src]", "src"],
    ["link[href]:not([rel=canonical]):not([rel=alternate])", "href"],
  ] as const) {
    for (const el of doc.querySelectorAll(selector)) {
      const value = el.getAttribute(attr)!;
      const target = internalPath(value, base, model.site.site);
      if (target !== undefined && (target === MALFORMED || resolveOutput(target, outputs) === "missing")) {
        add({ rule: "asset-missing", severity: "error", message: `<${el.tagName.toLowerCase()} ${attr}="${value}"> does not exist in the build output.` });
      }
    }
  }

  const canonicals = doc.querySelectorAll('link[rel="canonical"]');
  if (canonicals.length > 1) {
    add({ rule: "canonical", severity: "error", message: `Found ${canonicals.length} canonical links; use one.`, docs: DOCS.canonical });
  }
  for (const link of canonicals) {
    const href = link.getAttribute("href") ?? "";
    if (!/^https?:\/\//.test(href)) {
      add({ rule: "canonical", severity: "error", message: `Canonical "${href}" is not an absolute URL.`, docs: DOCS.canonical });
      continue;
    }
    const target = internalPath(href, base, model.site.site);
    if (target === undefined) {
      add({ rule: "canonical", severity: "warning", message: `Canonical "${href}" points to another site; search engines may credit that site instead of yours.`, docs: DOCS.canonical });
    } else if (target === MALFORMED || resolveOutput(target, outputs) !== "ok") {
      add({ rule: "canonical", severity: "error", message: `Canonical "${href}" does not point to a published page.`, docs: DOCS.canonical });
    }
  }

  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    checkJsonLd(script.rawText, add);
  }
  checkAnalytics(page.html, doc, model, add);
}

function checkAnalytics(html: string, doc: HTMLElement, model: SiteModel, add: (f: Omit<Finding, "page" | "source">) => void) {
  const loaders = html.match(/googletagmanager\.com\/(gtag\/js|gtm\.js)/g) ?? [];
  if (loaders.length > 1) {
    add({
      rule: "analytics-duplicate",
      severity: "error",
      message: `Page loads Google tags ${loaders.length} times (${loaders.join(", ")}); this double-counts. Remove the layout's tag or the integrations config.`,
    });
  }
  const { ga4, gtm, plausible } = model.site.integrations;
  // Each provider that receives events must declare them.
  const receivers = [
    ga4?.measurementId && { name: "ga4", events: ga4.events },
    gtm?.containerId && { name: "gtm", events: gtm.events },
    plausible && { name: "plausible", events: plausible.events },
  ].filter((r): r is { name: string; events: Record<string, { params: string[] }> } => Boolean(r));
  for (const el of doc.querySelectorAll("[data-vage-event]")) {
    const name = el.getAttribute("data-vage-event")!;
    if (!receivers.length) {
      add({ rule: "analytics-event", severity: "warning", message: `data-vage-event="${name}" is used but no analytics integration is configured.` });
      continue;
    }
    const missing = receivers.filter((r) => !r.events[name]);
    if (missing.length) {
      add({
        rule: "analytics-event",
        severity: "error",
        message: `Event "${name}" is not declared. Add it to ${missing.map((r) => `integrations.${r.name}.events`).join(" and ")} in vage.config.ts.`,
      });
      continue;
    }
    const params = Object.keys(el.attributes)
      .filter((a) => a.startsWith("data-vage-param-"))
      .map((a) => a.slice("data-vage-param-".length).replace(/-/g, "_"));
    for (const param of params.filter((p) => receivers.some((r) => !r.events[name]!.params.includes(p)))) {
      add({ rule: "analytics-event", severity: "error", message: `Event "${name}" has undeclared parameter "${param}". Declare it in its params list.` });
    }
  }
}

function checkJsonLd(raw: string, add: (f: Omit<Finding, "page" | "source">) => void) {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    add({ rule: "jsonld", severity: "error", message: `JSON-LD is not valid JSON: ${(err as Error).message}`, docs: DOCS.structuredData });
    return;
  }
  const root = data as Record<string, unknown>;
  if (typeof root["@context"] !== "string" || !/^https?:\/\/schema\.org\/?$/.test(root["@context"])) {
    add({ rule: "jsonld", severity: "error", message: 'JSON-LD needs "@context": "https://schema.org".', docs: DOCS.structuredData });
  }
  const items = (Array.isArray(root["@graph"]) ? root["@graph"] : [root]) as Record<string, unknown>[];
  for (const item of items) {
    if (typeof item["@type"] !== "string") {
      add({ rule: "jsonld", severity: "error", message: 'A JSON-LD item has no "@type".', docs: DOCS.structuredData });
    } else if (item["@type"] === "Article") {
      const missing = ["author", "datePublished", "image"].filter((k) => item[k] === undefined);
      if (missing.length) {
        add({
          rule: "jsonld-article",
          severity: "warning",
          message: `Article JSON-LD lacks properties Google recommends: ${missing.join(", ")}. Add them to the frontmatter (image: or seo.defaultImage) only if they are true.`,
          docs: DOCS.article,
        });
      }
    }
  }
}

/** The contact form needs the Workers target, its result pages, and a page whose form posts to it. */
function checkContact(model: SiteModel, outputs: Set<string>): Finding[] {
  const contact = model.site.contact;
  if (!contact) return [];
  const findings: Finding[] = [];
  if (model.site.deploy.target !== "cloudflare-workers") {
    findings.push({ rule: "contact", severity: "error", message: `contact needs deploy.target "cloudflare-workers" (it emails through Cloudflare Email Routing); the target is "${model.site.deploy.target}".` });
  }
  for (const [key, route] of [["sent", contact.sent], ["failed", contact.failed]] as const) {
    if (resolveOutput(route, outputs) === "missing") findings.push({ rule: "contact", severity: "error", message: `contact.${key} is ${route}, but there's no published page there. Create it (e.g. src/pages${route.replace(/\/$/, "")}.md).` });
  }
  const action = (a: string | undefined) => a !== undefined && normalizeRequestPath(new URL(a, "http://x").pathname) === contact.path;
  if (!model.pages.some((p) => parse(p.html).querySelectorAll("form").some((f) => action(f.getAttribute("action"))))) {
    findings.push({ rule: "contact", severity: "warning", message: `No page has a form that posts to ${contact.path}. Add contactForm(site) from "vagejs" to the layout of that page.` });
  }
  return findings;
}

/**
 * Pages deleted or moved since the last commit whose old address would now be a 404:
 * suggests the redirect (with the new address when git saw a rename). Quietly skipped
 * outside a git repository or before the first commit. Pages that were drafts don't count.
 */
async function checkRemovedPages(root: string, model: SiteModel): Promise<Finding[]> {
  let diff: string;
  try {
    // -z: paths as written (git otherwise quotes names like café.md).
    const res = await gitRaw(root, ["diff", "--name-status", "-z", "-M", "--relative", "HEAD", "--", "src/pages"]);
    if (res.code !== 0) return [];
    diff = res.stdout;
  } catch {
    return []; // git isn't installed
  }
  const live = new Set([...model.pages.map((p) => p.route), ...model.draftRoutes, ...model.skippedScheduled.map((s) => s.route)]);
  const redirected = new Set(Object.keys(model.site.redirects).map(normalizeRequestPath));
  const findings: Finding[] = [];
  const fields = diff.split("\0");
  for (let i = 0; i < fields.length - 1; ) {
    const status = fields[i++]!;
    const from = fields[i++];
    const to = /^[RC]/.test(status) ? fields[i++] : undefined;
    if (!from || !(status === "D" || status.startsWith("R"))) continue;
    const route = routeForPage(from.replace(/^src\/pages\//, ""));
    if (!route || live.has(route) || redirected.has(route)) continue;
    // Pages that weren't public at the last commit (drafts, scheduled) had no visitors to lose.
    const before = await gitRaw(root, ["show", `HEAD:./${from}`]);
    if (before.code === 0 && wasUnpublished(before.stdout, from)) continue;
    const target = to ? routeForPage(to.replace(/^src\/pages\//, "")) : undefined;
    findings.push({
      rule: "redirect-missing",
      severity: "warning",
      source: from,
      message: `${from} was ${target ? `moved to ${to}` : "deleted"} since the last commit, so ${route} will stop working for anyone with an old link. Add to vage.config.ts: redirects: { "${route}": "${target ?? "/new-address/"}" }`,
    });
  }
  return findings;
}

function wasUnpublished(source: string, file: string): boolean {
  try {
    const { frontmatter } = parseFrontmatter(source, file);
    return frontmatter.draft || scheduledFor(frontmatter.datePublished) !== undefined;
  } catch {
    return false;
  }
}

function checkDuplicates(pages: SitePage[]): Finding[] {
  const findings: Finding[] = [];
  for (const [rule, get] of [
    ["title-duplicate", (p: SitePage) => p.frontmatter.title],
    ["description-duplicate", (p: SitePage) => p.frontmatter.description],
  ] as const) {
    const seen = new Map<string, string[]>();
    for (const p of pages) {
      const value = get(p);
      if (value) seen.set(value, [...(seen.get(value) ?? []), p.route]);
    }
    for (const [value, routes] of seen) {
      if (routes.length > 1) {
        findings.push({ rule, severity: "warning", message: `"${value}" is used by ${routes.join(", ")}. Make each page's ${rule.split("-")[0]} unique.` });
      }
    }
  }
  return findings;
}

/** i18n: translationOf points at a real main-language page, one page per language per translation, and translations that are missing. */
function checkTranslations(model: SiteModel): Finding[] {
  const site = model.site;
  if (!site.i18n) return [];
  const findings: Finding[] = [];
  // Generated tag pages aren't translated.
  const pages = model.pages.filter((p) => !p.source.startsWith("("));
  const mainRoutes = new Set(pages.filter((p) => pageLang(site, p.route) === site.lang).map((p) => p.route));
  const seen = new Map<string, SitePage>();
  for (const p of pages) {
    const lang = pageLang(site, p.route);
    const at = { page: p.route, source: p.source };
    const target = p.frontmatter.translationOf;
    if (typeof target === "string") {
      if (lang === site.lang) {
        findings.push({ ...at, rule: "translation", severity: "error", message: `translationOf is only for pages in a language folder (${site.i18n.locales.map((l) => `src/pages/${l}/`).join(", ")}); this page is in the main language. Remove it.` });
      } else if (!mainRoutes.has(routeKey(target))) {
        findings.push({ ...at, rule: "translation", severity: "error", message: `translationOf: ${target} is not a published page in the main language (${site.lang}). Use the address of the page this one translates.` });
      }
    }
    const key = `${lang} ${translationKey(site, p.route, p.frontmatter)}`;
    const other = seen.get(key);
    if (other) {
      findings.push({ ...at, rule: "translation", severity: "error", message: `${p.source} and ${other.source} are both the "${lang}" version of ${translationKey(site, p.route, p.frontmatter)}. Keep one, or point translationOf at a different page.` });
    } else seen.set(key, p);
  }
  // i18n.pages: only these addresses ("/docs/*" covers that section, its index included) need every language.
  const wanted = site.i18n.pages && [...new Set(site.i18n.pages.map((w) => (w.endsWith("/*") ? w.slice(0, -1) : routeKey(w))))];
  const matches = (w: string, route: string) => (site.i18n!.pages!.includes(`${w}*`) ? route.startsWith(w) : route === w);
  const translate = (route: string) => !wanted || wanted.some((w) => matches(w, route));
  // Like menus: pages that failed to render count as present (they're reported already).
  const known = [...mainRoutes, ...model.pageErrors.flatMap((e) => (e.route && pageLang(site, e.route) === site.lang ? [e.route] : []))];
  for (const w of wanted ?? []) {
    if (!known.some((r) => matches(w, r))) {
      const shown = site.i18n.pages!.includes(`${w}*`) ? `${w}*` : publicPath(w, site.trailingSlash);
      findings.push({ rule: "translation", severity: "warning", source: "vage.config.ts", message: `i18n.pages lists ${shown}, which matches no published page in the main language (${site.lang}): moved, deleted, a draft or scheduled? Fix the address or remove it.` });
    }
  }
  for (const p of pages) {
    if (p.meta.noindex || pageLang(site, p.route) !== site.lang || !translate(p.route)) continue;
    const have = new Set((p.meta.translations ?? []).map((t) => t.lang));
    const missing = site.i18n.locales.filter((l) => !have.has(l));
    if (missing.length) {
      findings.push({
        page: p.route,
        source: p.source,
        rule: "translation-missing",
        severity: "warning",
        // p.source uses the system's separator ("src\pages\..." on Windows).
        message: `No ${missing.join(", ")} version of this page. Add ${missing.map((l) => `src/pages/${l}/${p.source.split(path.sep).join("/").replace(/^src\/pages\//, "")}`).join(", ")} (or a page with translationOf: ${publicPath(p.route, site.trailingSlash)}).`,
      });
    }
  }
  return findings;
}

/** Links visitors can't see but search engines can: the signature of injected spam. */
function checkHiddenLink(a: HTMLElement, href: string, model: SiteModel, add: (f: Omit<Finding, "page" | "source">) => void) {
  const external = externalHost(href, model.site.site) !== undefined;
  const hidden = hiddenReason(a) ?? (external && isEmptyLink(a) ? { reason: "empty (no text or image)", strength: "strong" as const } : undefined);
  // A link to this site's own pages inside a closed <details> (an FAQ accordion, "show more")
  // is ordinary page design, not injected spam: spam links point to other sites.
  if (!hidden || (!external && hidden.reason === "inside a closed <details>")) return;
  add({
    rule: "link-hidden",
    severity: external && hidden.strength === "strong" ? "error" : "warning",
    message: `Link to "${href}" is ${hidden.reason}: visitors can't see it, but search engines can. Hidden links are a common sign of injected spam. Remove it, or show it.`,
  });
}

/**
 * Outbound link guard: with security.outboundLinks "lock", every external domain must be
 * listed in links.lock.json. A domain nobody approved is how injected spam usually shows up.
 */
function checkOutboundLinks(root: string, model: SiteModel): Finding[] {
  if (model.site.security.outboundLinks === "off") return [];
  const hosts = outboundHosts(model);
  const lock = readLinkLock(root);
  if (!lock && model.site.security.outboundLinks === "require") {
    return [{ rule: "links-lock-missing", severity: "error", message: `${LINK_LOCK} is missing, but security.outboundLinks is "require". Restore it from git, or have the site owner recreate it with "npx vage links approve --all" after reviewing "npx vage links".` }];
  }
  if (!lock) {
    return hosts.size
      ? [{ rule: "links-lock-missing", severity: "warning", message: `The site links to ${hosts.size} external domain(s) and has no ${LINK_LOCK}. The site owner should review them with "npx vage links" and approve them with "npx vage links approve --all"; after that, links to any new domain fail the check.` }]
      : [];
  }
  const approved = new Set(lock.domains);
  const findings: Finding[] = [];
  for (const [host, pages] of hosts) {
    if (approved.has(host)) continue;
    const where = pages.map((p) => p.route);
    findings.push({
      rule: "link-unapproved",
      severity: "error",
      message: `Links to ${host} (on ${where.slice(0, 3).join(", ")}${where.length > 3 ? ` and ${where.length - 3} more` : ""}) aren't approved in ${LINK_LOCK}. If the site owner added them on purpose, they approve with "npx vage links approve ${host}". Otherwise remove them: unapproved links are how injected spam usually shows up.`,
      page: pages[0]!.route,
      source: pages[0]!.source,
    });
  }
  return findings;
}

/** Redirects to a page on this site must land on something that exists. */
function checkRedirectTargets(model: SiteModel, outputs: Set<string>): Finding[] {
  const findings: Finding[] = [];
  for (const r of model.redirects) {
    const target = internalPath(r.to, "/", model.site.site);
    if (target === undefined) continue;
    if (target === MALFORMED || resolveOutput(target, outputs) === "missing") {
      findings.push({ rule: "redirect-target", severity: "error", message: `Redirect from "${r.from}" points to "${r.to}", which isn't a page or file on this site.`, source: "vage.config.ts" });
    }
  }
  return findings;
}

/**
 * Menu entries must lead somewhere, even in menus no layout shows (a theme may show them
 * later): `page` entries to a published page, `href` site paths to a page or file.
 */
function checkMenus(model: SiteModel, outputs: Set<string>): Finding[] {
  // Pages from src/pages, plus pages that failed to render (reported already); not generated tag pages.
  const published = new Set([...model.pages.filter((p) => !p.source.startsWith("(")).map((p) => p.route), ...model.pageErrors.flatMap((e) => (e.route ? [e.route] : []))].map(routeKey));
  const findings: Finding[] = [];
  for (const e of menuEntries(model.site)) {
    let problem: string | undefined;
    if (e.page && !published.has(routeKey(e.page))) problem = `page "${e.page}" isn't a published page in src/pages (moved, deleted, a draft or scheduled?)`;
    if (e.href) {
      // The address layouts get: with trailingSlash "never", a final slash is dropped.
      const href = e.href.startsWith("/") ? sitePath(e.href, model.site) : e.href;
      const target = internalPath(href, "/", model.site.site);
      const found = target === undefined ? "ok" : target === MALFORMED ? "missing" : resolveOutput(target, outputs);
      if (found === "missing") problem = `"${e.href}" isn't a page or file on this site`;
      else if (found === "needs-slash") problem = `"${e.href}" redirects; write it with a slash at the end`;
    }
    if (problem) findings.push({ rule: "menu-link", severity: "error", message: `${e.at}: ${problem}.`, source: "vage.config.ts" });
  }
  return findings;
}

/**
 * Vercel serves about.html at /about only with "cleanUrls": true; without it, every
 * page of a trailingSlash "never" build answers 404 at its own address.
 */
function checkVercelCleanUrls(root: string, model: SiteModel): Finding[] {
  const file = path.join(root, "vercel.json");
  if (model.site.trailingSlash !== "never" || !fs.existsSync(file)) return [];
  let cleanUrls: unknown;
  try {
    cleanUrls = (JSON.parse(fs.readFileSync(file, "utf8")) as { cleanUrls?: unknown }).cleanUrls;
  } catch {
    return [{ rule: "config", severity: "warning", message: "vercel.json is not valid JSON.", source: "vercel.json" }];
  }
  if (cleanUrls === true) return [];
  return [{ rule: "config", severity: "error", message: 'trailingSlash is "never", so pages are written as about.html: add "cleanUrls": true to vercel.json, or Vercel answers 404 at /about.', source: "vercel.json" }];
}

function checkRobots(model: SiteModel): Finding[] {
  const robots = model.files.get("robots.txt");
  if (!robots) return [];
  // Find the "*" group and look for a blanket Disallow.
  const groups = robots.split(/\n\s*\n/);
  const star = groups.find((g) => /^User-agent:\s*\*\s*$/im.test(g));
  if (star && /^Disallow:\s*\/\s*$/im.test(star) && model.pages.some((p) => !p.meta.noindex)) {
    return [
      {
        rule: "robots-blocks-all",
        severity: "warning",
        message: "robots.txt disallows all crawlers (User-agent: * / Disallow: /) while pages are indexable.",
        source: "robots.txt",
        docs: DOCS.robots,
      },
    ];
  }
  return [];
}

/** Every path the build would write, as "/path" strings. */
function outputPaths(root: string, model: SiteModel): Set<string> {
  const out = new Set<string>();
  for (const p of model.pages) out.add(`/${p.outFile}`);
  if (model.notFound) out.add("/404.html");
  for (const r of model.redirects) out.add(`/${r.outFile}`);
  for (const name of model.files.keys()) out.add(`/${name}`);
  // The island loader is written by the build when a page has islands (client:load etc.).
  if ([...model.pages, ...(model.notFound ? [model.notFound] : [])].some((p) => islandKeys(p.html).length)) out.add(`/${ISLANDS_DIR}/runtime.js`);
  const walk = (dir: string, prefix: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), `${prefix}/${e.name}`);
      else out.add(`${prefix}/${e.name}`);
    }
  };
  const publicDir = path.join(root, "public");
  if (fs.existsSync(publicDir)) walk(publicDir, "");
  return out;
}

const MALFORMED = "\u0000malformed";

/** Returns the site-relative path for internal URLs, undefined for external ones, MALFORMED when undecodable. */
function internalPath(href: string, base: string, site: string | undefined): string | undefined {
  if (/^(mailto:|tel:|javascript:|vbscript:|data:|#)/i.test(href.trim()) || href === "") return undefined;
  let url: URL;
  try {
    url = new URL(href, `http://internal.invalid${base}`);
  } catch {
    return MALFORMED;
  }
  // Absolute links to the site count as internal; for a site in a subfolder, only those inside it.
  const sub = basePath(site);
  const own = site !== undefined && url.origin === siteOrigin(site) && (!sub || url.pathname === sub || url.pathname.startsWith(`${sub}/`));
  if (url.host !== "internal.invalid" && !own) return undefined;
  const pathname = own && sub ? url.pathname.slice(sub.length) || "/" : url.pathname;
  try {
    return decodeURIComponent(pathname);
  } catch {
    return MALFORMED;
  }
}

/**
 * A #fragment must match an id (or <a name>) on the page it points to; otherwise the
 * page opens at the top instead of the section. "#top" and text fragments (#:~:text=)
 * work without one. Files that aren't rendered pages (PDFs, redirects) aren't checked.
 */
function checkFragment(href: string, outFile: string, anchors: Map<string, Set<string>>, add: (f: Omit<Finding, "page" | "source">) => void) {
  const ids = anchors.get(outFile);
  const hash = href.indexOf("#");
  if (!ids || hash === -1) return;
  let fragment: string;
  try {
    fragment = decodeURIComponent(href.slice(hash + 1));
  } catch {
    fragment = href.slice(hash + 1);
  }
  if (!fragment || fragment.toLowerCase() === "top" || fragment.startsWith(":~:") || ids.has(fragment)) return;
  add({ rule: "link-fragment", severity: "warning", message: `Link to "${href}": no element with id "${fragment}" on that page, so it opens at the top.` });
}

/**
 * How a site path resolves against the build output, the way static hosts serve it:
 * "/about/" -> about/index.html, "/about" -> about.html (trailingSlash "never") or a file.
 * "needs-slash" and "no-slash" exist but redirect to the other form first.
 */
function resolveOutput(target: string, outputs: Set<string>): "ok" | "needs-slash" | "no-slash" | "missing" {
  if (target.endsWith("/")) {
    if (outputs.has(`${target}index.html`)) return "ok";
    return target !== "/" && outputs.has(`${target.slice(0, -1)}.html`) ? "no-slash" : "missing";
  }
  // Pages may have dots in their names ("/v1.2" -> v1.2.html), so extensions don't rule out pages.
  if (outputs.has(target) || outputs.has(`${target}.html`)) return "ok";
  return outputs.has(`${target}/index.html`) ? "needs-slash" : "missing";
}

/** The output file an "ok" site path is served from (for #fragment checks). */
function outputFile(target: string, outputs: Set<string>): string {
  if (target.endsWith("/")) return `${target}index.html`;
  return !outputs.has(target) && outputs.has(`${target}.html`) ? `${target}.html` : target;
}

