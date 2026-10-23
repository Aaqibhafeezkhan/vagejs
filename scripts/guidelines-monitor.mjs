#!/usr/bin/env node
// Checks the official sources in the rule pack for changes and writes a change report.
// Maintainer tooling (not shipped). Never edits the rule pack.
//
//   npm run build && node scripts/guidelines-monitor.mjs [--all] [--classify] [--update] [--only id1,id2]
//
//   --all       check every source (default: daily sources, plus weekly ones on Mondays UTC)
//   --classify  add draft LLM classifications (needs Anthropic credentials)
//   --update    accept the fetched state as the new baseline (after review)
// Exit codes: 0 no changes (or --update), 2 changes found, 1 error.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rulePack } from "../dist/guidelines/pack.js";
import { affectedRules, changeReport, compareSnapshots, fetchSource } from "../dist/guidelines/monitor.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOTS = path.join(ROOT, "guidelines", "snapshots.json");
const REPORTS = path.join(ROOT, "guidelines", "reports");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : undefined;

const now = new Date();
const date = now.toISOString().slice(0, 10);
const due = (s) => (only ? only.includes(s.id) : flag("all") || s.cadence === "daily" || now.getUTCDay() === 1);
const sources = rulePack.sources.filter((s) => s.monitor !== "manual" && due(s));

const stored = fs.existsSync(SNAPSHOTS) ? JSON.parse(fs.readFileSync(SNAPSHOTS, "utf8")) : { sources: {} };
const changes = [];
const texts = new Map();
const next = { ...stored.sources };

for (const source of sources) {
  try {
    const { snapshot, texts: sectionTexts } = await fetchSource(source, fetch, now);
    const change = compareSnapshots(source, stored.sources[source.id], snapshot);
    if (change) changes.push(change);
    if (snapshot.status >= 200 && snapshot.status < 300) next[source.id] = snapshot;
    texts.set(source.id, sectionTexts);
    console.log(`${change ? change.kind.padEnd(11) : "unchanged  "} ${source.id}`);
  } catch (err) {
    changes.push({ source, kind: "unreachable", added: [], removed: [], modified: [], detail: err.message });
    console.log(`unreachable ${source.id}: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 500)); // be polite to the docs servers
}

const classifications = [];
if (flag("classify")) {
  const { classifyChange } = await import("./guidelines-classify.mjs");
  for (const c of changes.filter((c) => c.kind === "changed")) {
    const rules = affectedRules(rulePack, c.source.id);
    if (!rules.length) continue;
    for (const section of [...c.added, ...c.modified]) {
      const text = texts.get(c.source.id)?.get(section) ?? "";
      const result = await classifyChange({ source: c.source, section, text, rules });
      classifications.push({ sourceId: c.source.id, section, ...result });
    }
  }
}

const report = changeReport(rulePack, changes.filter((c) => c.kind !== "new"), date, classifications);
const real = changes.filter((c) => c.kind !== "new");
if (real.length) {
  fs.mkdirSync(REPORTS, { recursive: true });
  const file = path.join(REPORTS, `${date}.md`);
  fs.writeFileSync(file, report);
  console.log(`\nReport: ${path.relative(ROOT, file)}`);
}
if (flag("update")) {
  fs.mkdirSync(path.dirname(SNAPSHOTS), { recursive: true });
  fs.writeFileSync(SNAPSHOTS, `${JSON.stringify({ packVersion: rulePack.version, sources: next }, null, 2)}\n`);
  console.log(`Baseline updated: ${path.relative(ROOT, SNAPSHOTS)}`);
  process.exit(0);
}
const added = changes.filter((c) => c.kind === "new").length;
if (added) console.log(`\n${added} source(s) have no baseline yet; run with --update to record them.`);
process.exit(real.length ? 2 : 0);
