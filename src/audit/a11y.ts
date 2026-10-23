import { createRequire } from "node:module";
import fs from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import type { Finding } from "../checks/check.js";

const axeSource = fs.readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

export interface A11yPageResult {
  route: string;
  findings: Finding[];
  /** Rules axe could not decide without a real browser (e.g. color contrast). */
  needsReview: string[];
}

/**
 * Runs axe-core against static HTML in jsdom. No page scripts run and nothing
 * is fetched, so layout-dependent rules (color contrast, target size) come back
 * as "needs review"; use Lighthouse (`vage audit --lighthouse`) for those.
 */
export async function auditAccessibility(route: string, html: string): Promise<A11yPageResult> {
  // A detached console keeps jsdom's "not implemented" notices (e.g. canvas, probed by axe) out of the output.
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  try {
    const window = dom.window as unknown as Window & { eval(src: string): void; axe: AxeLike };
    window.eval(axeSource);
    const results = await window.axe.run(window.document, { resultTypes: ["violations", "incomplete"] });
    const findings: Finding[] = results.violations.map((v) => ({
      rule: `a11y:${v.id}`,
      // critical/serious block users; moderate/minor still matter but are warnings.
      severity: v.impact === "critical" || v.impact === "serious" ? "error" : "warning",
      page: route,
      message: `${v.help} (${v.nodes.length} element${v.nodes.length === 1 ? "" : "s"}: ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(", ")})`,
      docs: v.helpUrl,
    }));
    return { route, findings, needsReview: results.incomplete.map((r) => r.id) };
  } finally {
    dom.window.close();
  }
}

interface AxeLike {
  run(
    context: Document,
    options: { resultTypes: string[] },
  ): Promise<{
    violations: { id: string; impact?: string | null; help: string; helpUrl: string; nodes: { target: string[] }[] }[];
    incomplete: { id: string }[];
  }>;
}
