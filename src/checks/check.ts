import fs from "node:fs";
import path from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { createBuildLoader } from "../core/loader.js";
import { listedPages, renderSite, type SiteModel, type SitePage } from "../core/site.js";

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
    const findings = checkSite(root, model);
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
  const drafts = new Set(model.draftRoutes);
  const pages = model.notFound ? [...model.pages, model.notFound] : model.pages;

  for (const page of pages) {
    const add = (f: Omit<Finding, "page" | "source">) => findings.push({ ...f, page: page.route, source: page.source });
    checkPage(page, parse(page.html), model, outputs, drafts, add);
  }
  findings.push(...checkDuplicates(listedPages(model)));
  findings.push(...checkRobots(model));
  findings.push(...checkRedirectTargets(model, outputs));
  return findings;
}

function checkPage(
  page: SitePage,
  doc: HTMLElement,
  model: SiteModel,
  outputs: Set<string>,
  drafts: Set<string>,
  add: (f: Omit<Finding, "page" | "source">) => void,
) {
  const indexable = !page.meta.noindex;

  for (const key of emptyValues(page.frontmatter)) {
    add({
      rule: "frontmatter-empty",
      severity: "warning",
      message: `Frontmatter "${key}" has no value. If you meant to write text there, check for a missing value; inside { } a comma or colon splits the text, so wrap it in quotes.`,
      docs: DOCS.yamlFlow,
    });
  }

  if (!doc.querySelector("html")?.getAttribute("lang")) {
    add({ rule: "html-lang", severity: "error", message: "<html> has no lang attribute.", docs: DOCS.lang });
  }
  const titles = doc.querySelectorAll("title");
  if (titles.length !== 1 || !titles[0]!.text.trim()) {
    add({ rule: "title", severity: "error", message: `Expected exactly one non-empty <title>, found ${titles.length}.`, docs: DOCS.title });
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
  if (site.deploy.target === "cloudflare-pages" && site.security.headers && site.security.csp === "enforce") {
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
    if (!a.text.trim() && !a.getAttribute("aria-label") && !a.querySelector("img[alt]:not([alt=''])")) {
      add({ rule: "link-text", severity: "warning", message: `Link to "${href}" has no accessible text.`, docs: DOCS.linkPurpose });
    }
    const target = internalPath(href, page.route, model.site.site);
    if (target === undefined) continue;
    if (target === MALFORMED) {
      add({ rule: "link-broken", severity: "error", message: `Link to "${href}" is a malformed URL.` });
      continue;
    }
    const resolved = resolveOutput(target, outputs);
    if (resolved === "missing") {
      const draft = drafts.has(target.endsWith("/") ? target : `${target}/`);
      add({
        rule: "link-broken",
        severity: "error",
        message: draft ? `Link to "${href}" points to a draft page, which is not published.` : `Link to "${href}" does not match any page or file.`,
      });
    } else if (resolved === "needs-slash") {
      add({ rule: "link-trailing-slash", severity: "warning", message: `Link to "${href}" redirects; use "${target}/".` });
    }
  }

  for (const [selector, attr] of [
    ["img[src]", "src"],
    ["script[src]", "src"],
    ["link[href]:not([rel=canonical]):not([rel=alternate])", "href"],
  ] as const) {
    for (const el of doc.querySelectorAll(selector)) {
      const value = el.getAttribute(attr)!;
      const target = internalPath(value, page.route, model.site.site);
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
    const target = internalPath(href, page.route, model.site.site);
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
          message: `Article JSON-LD lacks properties Google recommends: ${missing.join(", ")}. Add them to the frontmatter only if they are true.`,
          docs: DOCS.article,
        });
      }
    }
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
  const isInternal = url.host === "internal.invalid" || (site !== undefined && url.origin === site);
  if (!isInternal) return undefined;
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return MALFORMED;
  }
}

function resolveOutput(target: string, outputs: Set<string>): "ok" | "needs-slash" | "missing" {
  if (target.endsWith("/")) return outputs.has(`${target}index.html`) ? "ok" : "missing";
  if (outputs.has(target)) return "ok";
  if (!path.posix.extname(target) && outputs.has(`${target}/index.html`)) return "needs-slash";
  return "missing";
}

