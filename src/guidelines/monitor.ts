import { createHash } from "node:crypto";
import { parse, type HTMLElement } from "node-html-parser";
import type { RulePack, Source } from "./pack.js";

/**
 * Change detection for official sources. Snapshots keep only section headings
 * and hashes, not the documents' text, so nothing copyrighted is stored; the
 * live page is the evidence. Reports are inputs to human review, never
 * automatic rule changes.
 */
export interface SourceSnapshot {
  id: string;
  url: string;
  fetchedAt: string;
  status: number;
  /** Final URL after redirects. */
  finalUrl: string;
  lastModified?: string;
  contentHash: string;
  sections: { heading: string; hash: string }[];
}

export interface SourceChange {
  source: Source;
  kind: "changed" | "unreachable" | "unreadable" | "moved" | "new";
  added: string[];
  removed: string[];
  modified: string[];
  detail?: string;
}

const NOISE = "script, style, noscript, nav, header, footer, aside, form, button, svg, [aria-hidden=true], .devsite-article-meta, .devsite-feedback";

/** Splits the main content into sections by h1–h3 and hashes each section's normalized text. */
export function sectionize(html: string): { heading: string; text: string }[] {
  const doc = parse(html);
  const main = doc.querySelector("main article") ?? doc.querySelector("article") ?? doc.querySelector("main") ?? doc.querySelector("[role=main]") ?? doc.querySelector("body") ?? doc;
  for (const el of main.querySelectorAll(NOISE)) el.remove();

  const sections: { heading: string; text: string[] }[] = [{ heading: "(intro)", text: [] }];
  const walk = (node: HTMLElement) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        sections.at(-1)!.text.push(child.rawText);
        continue;
      }
      const el = child as HTMLElement;
      if (/^h[1-3]$/i.test(el.tagName ?? "")) sections.push({ heading: normalize(el.text), text: [] });
      else if (el.tagName) walk(el);
    }
  };
  walk(main as HTMLElement);
  return sections
    .map((s) => ({ heading: s.heading, text: normalize(decode(s.text.join(" "))) }))
    .filter((s) => s.text || s.heading !== "(intro)");
}

/** Fetches a source. `texts` (heading -> current text) is for classification only and is never persisted. */
export async function fetchSource(source: Source, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<{ snapshot: SourceSnapshot; texts: Map<string, string> }> {
  const res = await fetchImpl(source.url, {
    redirect: "follow",
    // English, so localized variants don't show up as changes.
    headers: { "user-agent": "vagejs-guidelines-monitor/0.1", accept: "text/html", "accept-language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(60_000),
  });
  const html = res.ok ? await res.text() : "";
  const parts = sectionize(html);
  const sections = parts.map((s) => ({ heading: s.heading, hash: hash(`${s.heading}\n${s.text}`) }));
  const snapshot: SourceSnapshot = {
    id: source.id,
    url: source.url,
    fetchedAt: now.toISOString(),
    status: res.status,
    finalUrl: res.url || source.url,
    lastModified: res.headers.get("last-modified") ?? undefined,
    contentHash: hash(sections.map((s) => s.hash).join("")),
    sections,
  };
  return { snapshot, texts: new Map(parts.map((p) => [p.heading, p.text])) };
}

export function compareSnapshots(source: Source, before: SourceSnapshot | undefined, after: SourceSnapshot): SourceChange | undefined {
  const base = { source, added: [], removed: [], modified: [] };
  if (after.status < 200 || after.status >= 300) return { ...base, kind: "unreachable", detail: `HTTP ${after.status}` };
  if (!after.sections.length) {
    return { ...base, kind: "unreadable", detail: "no readable text (probably rendered client-side); check manually or mark the source monitor: manual" };
  }
  if (!before) return { ...base, kind: "new", added: after.sections.map((s) => s.heading) };
  if (new URL(after.finalUrl).pathname !== new URL(before.finalUrl).pathname) {
    return { ...base, kind: "moved", detail: `${before.finalUrl} → ${after.finalUrl}` };
  }
  if (before.contentHash === after.contentHash) return undefined;

  const old = new Map(before.sections.map((s) => [s.heading, s.hash]));
  const now = new Map(after.sections.map((s) => [s.heading, s.hash]));
  return {
    ...base,
    kind: "changed",
    added: [...now.keys()].filter((h) => !old.has(h)),
    removed: [...old.keys()].filter((h) => !now.has(h)),
    modified: [...now.keys()].filter((h) => old.has(h) && old.get(h) !== now.get(h)),
  };
}

export interface Classification {
  sourceId: string;
  section: string;
  classification: "informative" | "recommended" | "required" | "deprecated" | "unclear";
  rationale: string;
  suggestedAction: string;
}

/** Markdown change report: what changed, which rules depend on it, and what needs human review. */
export function changeReport(pack: RulePack, changes: SourceChange[], date: string, classifications: Classification[] = []): string {
  const lines = [`# Guideline source changes — ${date}`, "", `Rule pack in use: ${pack.version}. Snapshots store headings and hashes only; open each link to read the current text.`, ""];
  const manual = pack.sources.filter((s) => s.monitor === "manual");
  if (manual.length) lines.push(`Not monitored automatically (check by hand): ${manual.map((s) => `[${s.title}](${s.url})`).join(", ")}.`, "");
  if (!changes.length) return `${lines.join("\n")}No changes detected.\n`;

  const review = changes.some((c) => affectedRules(pack, c.source.id).some((r) => r.behaviorChanging));
  lines.push(
    review
      ? "**Human review required:** at least one change affects a rule that changes crawler access, indexing, privacy, security or build output."
      : "No behavior-changing rules are affected; review is still recommended.",
    "",
  );
  for (const c of changes) {
    lines.push(`## ${c.source.title} (${c.source.provider})`, "", `- Source: ${c.source.url}`, `- Change: ${c.kind}${c.detail ? ` (${c.detail})` : ""}`);
    for (const [label, list] of [["Added sections", c.added], ["Removed sections", c.removed], ["Modified sections", c.modified]] as const) {
      if (list.length) lines.push(`- ${label}: ${list.map((h) => untrusted(h, 120)).join(", ")}`);
    }
    const rules = affectedRules(pack, c.source.id);
    lines.push(`- Affected rules: ${rules.length ? rules.map((r) => `\`${r.id}\`${r.behaviorChanging ? " (changes output)" : ""}`).join(", ") : "none (tracked only)"}`);
    const drafts = classifications.filter((x) => x.sourceId === c.source.id);
    if (drafts.length) {
      lines.push("- Draft classification (LLM, not authoritative):");
      for (const d of drafts) lines.push(`  - ${untrusted(d.section, 120)}: **${d.classification}**: ${untrusted(d.rationale)} Suggested: ${untrusted(d.suggestedAction)}`);
    }
    lines.push("");
  }
  lines.push("## Next steps", "", "1. Read each changed source.", "2. If a rule must change, edit `src/guidelines/rule-pack.json`, bump `version`, add a changelog entry (`reviewedBy`, new `contentHash`).", "3. Run `npm test` (golden outputs show the effect) and release.", "4. Then run the monitor with `--update` to accept the new snapshots.", "");
  return lines.join("\n");
}

/**
 * Fetched headings and LLM output are untrusted: shown as inline code so they
 * can't become links, images, HTML or @-mentions in the issue.
 */
export function untrusted(text: string, max = 300): string {
  const one = text.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return `\`${one.length > max ? `${one.slice(0, max)}…` : one}\``;
}

export function affectedRules(pack: RulePack, sourceId: string) {
  return pack.rules.filter((r) => r.sources.includes(sourceId));
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function decode(text: string): string {
  return text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
