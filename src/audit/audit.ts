import fs from "node:fs";
import path from "node:path";
import type { Finding } from "../checks/check.js";
import { buildSite } from "../core/build.js";
import type { SiteConfig } from "../core/config.js";
import { loadProjectConfig } from "../core/project-config.js";
import { missingKeyMessage, resolveApiKey, type ApiKeyName } from "../integrations/api-keys.js";
import { VageError } from "../core/errors.js";
import { publicPath, routeKey } from "../core/routes.js";
import { startPreviewServer } from "../dev/preview.js";
import { auditAccessibility } from "./a11y.js";
import { budgetFindings, measurePages, type PageWeight } from "./budgets.js";
import { runLighthouse } from "./lighthouse.js";
import { cruxField, pageSpeed, type FieldReport, type LabReport, type RemoteOptions, type Strategy } from "./remote.js";
import { LAB_VS_FIELD, VITALS } from "./vitals.js";

export interface AuditOptions {
  /** Fail on warnings too (budgets, lab scores, API failures). */
  strict?: boolean;
  /** Run Lighthouse locally (also enabled by performance.lighthouse.enabled). */
  lighthouse?: boolean;
  /** Audit a deployed URL with PageSpeed Insights + CrUX instead of the local build. */
  url?: string;
  strategies?: Strategy[];
  env?: Record<string, string | undefined>;
  remote?: RemoteOptions;
  /** Asks the user for their own key when none is configured (interactive CLI only). */
  askForKey?: (name: ApiKeyName) => Promise<string | undefined>;
}

export interface AuditResult {
  ok: boolean;
  errors: number;
  warnings: number;
  target: string;
  findings: Finding[];
  pages: PageWeight[];
  /** axe rules that need a real browser or manual review. */
  needsReview: string[];
  lab: LabReport[];
  field: FieldReport[];
  notes: string[];
}

export async function audit(root: string, options: AuditOptions = {}): Promise<AuditResult> {
  root = path.resolve(root);
  const strategies = options.strategies ?? ["mobile", "desktop"];
  const partial = options.url ? await auditUrl(root, options.url, strategies, options) : await auditLocal(root, strategies, options);
  const errors = partial.findings.filter((f) => f.severity === "error").length;
  const warnings = partial.findings.length - errors;
  if (partial.lab.length || partial.field.length) partial.notes.push(LAB_VS_FIELD);
  return { ...partial, ok: errors === 0 && (!options.strict || warnings === 0), errors, warnings };
}

type AuditParts = Omit<AuditResult, "ok" | "errors" | "warnings">;

async function auditLocal(root: string, strategies: Strategy[], options: AuditOptions): Promise<AuditParts> {
  const { result, model } = await buildSite(root);
  const site = model.site;
  const pages = model.notFound ? [...model.pages, model.notFound] : model.pages;
  const weights = measurePages(result.outDir, pages, site.site);
  const findings: Finding[] = budgetFindings(weights, site.performance.budgets, site.performance.pageBudgets);
  const notes: string[] = ["Sizes are uncompressed bytes of local files; transfer size depends on your host's compression."];

  const needsReview = new Map<string, number>();
  for (const page of pages) {
    const html = fs.readFileSync(path.join(result.outDir, page.outFile), "utf8");
    const a11y = await auditAccessibility(page.route, html);
    findings.push(...a11y.findings.map((f) => ({ ...f, source: page.source })));
    for (const rule of a11y.needsReview) needsReview.set(rule, (needsReview.get(rule) ?? 0) + 1);
  }
  if (needsReview.size) {
    const list = [...needsReview].map(([rule, n]) => `${rule} (${n} page${n === 1 ? "" : "s"})`).join(", ");
    notes.push(`Automated checks could not decide: ${list}. Review manually or run with --lighthouse (real browser).`);
  }
  for (const w of weights.filter((w) => w.hasJavaScript)) {
    notes.push(`${w.route} ships client-side JavaScript (${(w.bytes.javascript / 1024).toFixed(1)} KB local). Static pages usually need none.`);
  }

  const lab: LabReport[] = [];
  if (options.lighthouse || site.performance.lighthouse.enabled) {
    const routes = site.performance.lighthouse.pages;
    const known = new Set(model.pages.map((p) => p.route));
    const unknown = routes.filter((r) => !known.has(routeKey(r)));
    if (unknown.length) throw new VageError(`performance.lighthouse.pages lists routes that are not published: ${unknown.join(", ")}`);
    const server = await startPreviewServer(root, {});
    try {
      const base = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
      lab.push(...(await runLighthouse(root, routes.map((r) => base + publicPath(routeKey(r), site.trailingSlash)), strategies)));
    } finally {
      await server.close();
    }
    notes.push("Local Lighthouse runs on your machine; scores differ from PageSpeed Insights and from real users.");
    findings.push(...scoreFindings(lab, site));
  }

  return { target: result.outDir, findings, pages: weights, needsReview: [...needsReview.keys()], lab, field: [], notes };
}

async function auditUrl(root: string, url: string, strategies: Strategy[], options: AuditOptions): Promise<AuditParts> {
  if (!/^https?:\/\//.test(url)) throw new VageError(`--url must be an absolute http(s) URL, got "${url}".`);
  const env = options.env ?? process.env;
  const site = await loadProjectConfig(path.resolve(root));
  const findings: Finding[] = [];
  const notes: string[] = [];
  const lab: LabReport[] = [];
  const field: FieldReport[] = [];
  const failure = (rule: string, err: unknown) =>
    findings.push({ rule, severity: options.strict ? "error" : "warning", message: (err as Error).message });

  // Always the user's own keys: never a shared or built-in key, and no keyless fallback.
  const keyFor = async (name: ApiKeyName) => resolveApiKey(name, env) ?? (await options.askForKey?.(name));

  const psiKey = await keyFor("pagespeed");
  if (!psiKey) {
    findings.push({ rule: "pagespeed", severity: "error", message: missingKeyMessage("pagespeed") });
  } else {
    for (const strategy of strategies) {
      try {
        lab.push(await pageSpeed(url, strategy, psiKey, options.remote));
      } catch (err) {
        failure("pagespeed", err);
      }
    }
  }
  findings.push(...scoreFindings(lab, site));

  // One Google Cloud key can enable both APIs, so the PageSpeed key is tried for CrUX too.
  const cruxKey = resolveApiKey("crux", env) ?? psiKey ?? (await options.askForKey?.("crux"));
  if (!cruxKey) {
    notes.push(`No field data. ${missingKeyMessage("crux")}`);
  } else {
    for (const strategy of strategies) {
      try {
        const report = await cruxField(url, strategy, cruxKey, options.remote);
        if (!report) {
          notes.push(`No CrUX field data for ${url} or its origin (${strategy}); the site may not have enough Chrome traffic.`);
          continue;
        }
        field.push(report);
        for (const [name, m] of Object.entries(report.metrics)) {
          if (m.rating !== "good") {
            const t = VITALS[name as keyof typeof VITALS];
            findings.push({
              rule: "field-vitals",
              severity: "warning",
              message: `${t.label} p75 is ${m.p75}${t.unit} (${m.rating}; good is ≤ ${t.good}${t.unit}) for ${report.formFactor} (${report.scope}-level, real users).`,
              docs: "https://web.dev/articles/vitals",
            });
          }
        }
      } catch (err) {
        failure("crux", err);
      }
    }
  }
  return { target: url, findings, pages: [], needsReview: [], lab, field, notes };
}

function scoreFindings(lab: LabReport[], site: SiteConfig): Finding[] {
  const b = site.performance.budgets;
  const budgets = { performance: b.performance, accessibility: b.accessibility, seo: b.seo, "best-practices": b.bestPractices };
  const findings: Finding[] = [];
  for (const r of lab) {
    for (const [category, min] of Object.entries(budgets)) {
      const score = r.scores[category as keyof typeof budgets];
      if (score !== null && score < min) {
        findings.push({
          rule: "lab-score",
          severity: "warning",
          page: r.url,
          message: `${category} ${score} < budget ${min} (${r.strategy}, ${r.source}, lab).`,
        });
      }
    }
  }
  return findings;
}
