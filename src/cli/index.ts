#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { cac } from "cac";
import { check, type Finding } from "../checks/check.js";
import { build } from "../core/build.js";
import { VageError } from "../core/errors.js";
import { startDevServer } from "../dev/server.js";
import { startPreviewServer } from "../dev/preview.js";
import { createInterface } from "node:readline/promises";
import { createProject } from "./create.js";
import { frameworkInfo } from "./info.js";

const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
const cli = cac("vage");

interface CommonOptions {
  root: string;
  json?: boolean;
}
interface ServeFlags extends CommonOptions {
  port?: number;
  host?: string | boolean;
}

cli
  .command("create <dir>", "Scaffold a new VAGE JS website")
  .option("--vage-spec <spec>", "Dependency spec for vagejs in the new package.json", { default: `^${version}` })
  .option("--json", "Print machine-readable JSON")
  .action((dir: string, opts: { vageSpec: string; json?: boolean }) =>
    run(opts, () => {
      const result = createProject(dir, opts.vageSpec);
      if (opts.json) return print({ ok: true, ...result });
      const rel = path.relative(process.cwd(), result.dir) || ".";
      console.log(`Created ${result.dir}\n\nNext steps:\n  cd ${rel}\n  npm install\n  npm run dev`);
    }),
  );

cli
  .command("dev", "Start the dev server with live reload")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--port <port>", "Port (fails if taken; default picks a free port from 5173)")
  .option("--host [host]", "Expose on the network")
  .action((opts: ServeFlags) =>
    run(opts, async () => {
      const server = await startDevServer(opts.root, { port: parsePort(opts.port), host: opts.host });
      console.log(`VAGE JS dev server running at ${server.resolvedUrls?.local[0]}`);
      server.resolvedUrls?.network.forEach((url) => console.log(`  network: ${url}`));
    }),
  );

cli
  .command("build", "Build the static site into dist/")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--json", "Print machine-readable JSON")
  .action((opts: CommonOptions) =>
    run(opts, async () => {
      const result = await build(opts.root);
      if (opts.json) return print({ ok: true, ...result });
      for (const page of result.pages) console.log(`  ${page.route.padEnd(30)} -> ${page.output}`);
      for (const r of result.redirects) console.log(`  ${r.from.padEnd(30)} -> ${r.output} (redirect to ${r.to})`);
      for (const file of result.files) console.log(`  ${"".padEnd(30)} -> ${file}`);
      for (const draft of result.skippedDrafts) console.log(`  (draft, skipped) ${draft}`);
      for (const warning of result.warnings) console.log(`\nWarning: ${warning}`);
      console.log(`\nBuilt ${result.pages.length} page(s) into ${result.outDir} in ${result.durationMs}ms`);
    }),
  );

cli
  .command("check", "Check SEO, links, structured data and basic accessibility (writes nothing)")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--strict", "Fail on warnings too")
  .option("--json", "Print machine-readable JSON")
  .action((opts: CommonOptions & { strict?: boolean }) =>
    run(opts, async () => {
      const result = await check(opts.root, { strict: opts.strict });
      if (opts.json) print(result);
      else {
        printFindings(result.findings);
        console.log(`\nChecked ${result.pagesChecked} page(s): ${result.errors} error(s), ${result.warnings} warning(s).`);
        console.log("Passing checks do not guarantee indexing, rankings, rich results or AI citations.");
      }
      if (!result.ok) process.exit(1);
    }),
  );

cli
  .command("audit", "Performance budgets and accessibility (local build), or PageSpeed/CrUX for a deployed --url")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--url <url>", "Audit a deployed URL with PageSpeed Insights (+ CrUX field data with CRUX_API_KEY)")
  .option("--lighthouse", "Also run Lighthouse locally (needs the lighthouse package and Chrome)")
  .option("--strategy <strategy>", "mobile, desktop or both", { default: "both" })
  .option("--strict", "Fail on warnings too (budgets, lab scores, API failures)")
  .option("--json", "Print machine-readable JSON")
  .action((opts: CommonOptions & { url?: string; lighthouse?: boolean; strategy: string; strict?: boolean }) =>
    run(opts, async () => {
      if (!["mobile", "desktop", "both"].includes(opts.strategy)) {
        throw new VageError(`Invalid --strategy "${opts.strategy}". Use mobile, desktop or both.`);
      }
      const strategies = opts.strategy === "both" ? (["mobile", "desktop"] as const) : ([opts.strategy] as ["mobile"] | ["desktop"]);
      // Loaded lazily: jsdom and axe are only needed for audits.
      const { audit } = await import("../audit/audit.js");
      const { kbText } = await import("../audit/budgets.js");
      const result = await audit(opts.root, { url: opts.url, lighthouse: opts.lighthouse, strict: opts.strict, strategies: [...strategies] });
      if (opts.json) print(result);
      else {
        for (const p of result.pages) {
          const b = p.bytes;
          console.log(`  ${p.route.padEnd(28)} total ${kbText(p.total).padStart(9)}  js ${kbText(b.javascript)}  css ${kbText(b.css)}  img ${kbText(b.image)}  font ${kbText(b.font)}  ${p.requests} req`);
        }
        for (const r of result.lab) {
          const s = r.scores;
          console.log(`  [lab ${r.source}, ${r.strategy}] ${r.url}: perf ${s.performance} a11y ${s.accessibility} seo ${s.seo} bp ${s["best-practices"]} (${r.toolVersion}, ${r.fetchTime})`);
          for (const o of r.opportunities) console.log(`      - ${o.title}${o.displayValue ? `: ${o.displayValue}` : ""}`);
        }
        for (const f of result.field) {
          const m = Object.entries(f.metrics).map(([k, v]) => `${k.toUpperCase()} p75 ${v.p75} (${v.rating})`).join(", ");
          console.log(`  [field CrUX, ${f.formFactor}, ${f.scope}] ${m || "no metrics"}${f.collectionPeriod ? ` — ${f.collectionPeriod}` : ""}`);
        }
        if (result.findings.length) console.log("");
        printFindings(result.findings);
        for (const note of result.notes) console.log(`\nNote: ${note}`);
        console.log(`\nAudit of ${result.target}: ${result.errors} error(s), ${result.warnings} warning(s).`);
      }
      if (!result.ok) process.exit(1);
    }),
  );

cli
  .command("preview", "Serve the production build from dist/")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--port <port>", "Port (fails if taken; default picks a free port from 4173)")
  .option("--host [host]", "Expose on the network")
  .action((opts: ServeFlags) =>
    run(opts, async () => {
      const server = await startPreviewServer(opts.root, { port: parsePort(opts.port), host: opts.host });
      console.log(`VAGE JS preview running at ${server.resolvedUrls?.local[0]}`);
      server.resolvedUrls?.network.forEach((url) => console.log(`  network: ${url}`));
    }),
  );

cli
  .command("info", "Describe commands, config and frontmatter (use --json for agents)")
  .option("--json", "Print machine-readable JSON")
  .action((opts: { json?: boolean }) =>
    run(opts, () => {
      const info = frameworkInfo(cli, version);
      if (opts.json) return print(info);
      console.log(`VAGE JS ${info.version}\n`);
      for (const c of info.commands) console.log(`  ${c.usage.padEnd(28)} ${c.description}`);
      console.log(`\nConfig: ${info.config.files.join(" | ")}. Pages: ${info.routing.pagesDir}/**/*.md`);
      console.log("Run `vage info --json` for full config and frontmatter JSON Schemas.");
    }),
  );

interface PublishFlags extends CommonOptions {
  remote?: string;
  branch?: string;
  message?: string;
  yes?: boolean;
  dryRun?: boolean;
}

cli
  .command("deploy:github", "Check, build, then safely commit and push the project to GitHub (asks first)")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--remote <url>", "Git URL to add as origin if there is none")
  .option("--branch <name>", "Branch for a new repository (default: main); must match the current branch otherwise")
  .option("-m, --message <msg>", "Commit message")
  .option("--dry-run", "Run check + build and show the plan; no git changes")
  .option("--yes", "Skip the confirmation prompt")
  .option("--json", "Print machine-readable JSON")
  .action((opts: PublishFlags) =>
    run(opts, async () => {
      const { publish } = await import("../deploy/publish.js");
      const result = await publish(opts.root, { ...opts, confirm: (plan) => confirmPlan(plan, opts) });
      if (opts.dryRun) return opts.json ? print({ ok: true, dryRun: true, plan: result.plan }) : console.log("Dry run: nothing changed.");
      if (opts.json) return print({ ok: result.status !== "aborted", ...result });
      reportPublish(result);
    }),
  );

cli
  .command("deploy", "Deploy to GitHub Pages: adds the deploy workflow, publishes, and waits for GitHub to confirm")
  .option("--root <dir>", "Project root", { default: "." })
  .option("--remote <url>", "Git URL to add as origin if there is none")
  .option("--branch <name>", "Branch for a new repository (default: main)")
  .option("-m, --message <msg>", "Commit message")
  .option("--no-wait", "Don't wait for the GitHub Actions deploy run")
  .option("--dry-run", "Run check + build and show the plan; no git changes")
  .option("--yes", "Skip the confirmation prompt")
  .option("--json", "Print machine-readable JSON")
  .action((opts: PublishFlags & { wait: boolean }) =>
    run(opts, async () => {
      const { publish } = await import("../deploy/publish.js");
      const pages = await import("../deploy/github-pages.js");
      const result = await publish(opts.root, {
        ...opts,
        extraFiles: (branch) => ({ [pages.PAGES_WORKFLOW]: pages.pagesWorkflow(branch) }),
        confirm: (plan) => confirmPlan(plan, opts, "Then enable GitHub Pages (source: GitHub Actions) via gh if needed, and wait for the deploy run."),
      });
      if (opts.dryRun) return opts.json ? print({ ok: true, dryRun: true, plan: result.plan }) : console.log("Dry run: nothing changed.");
      if (result.status !== "published") {
        if (opts.json) return print({ ok: result.status !== "aborted", ...result, deployment: { status: "unconfirmed", reason: `Nothing was pushed (${result.status}).` } });
        reportPublish(result);
        if (result.status === "committed") console.log("Not deployed: there is no remote. Pass --remote <git-url>.");
        return;
      }
      if (!opts.json) reportPublish(result);
      const enabled = await pages.ensurePagesEnabled(result.plan.root);
      const deployment =
        typeof enabled === "object"
          ? { status: "unconfirmed" as const, reason: enabled.manual }
          : opts.wait
            ? await pages.confirmPagesDeployment(result.plan.root, result.commit!)
            : { status: "unconfirmed" as const, reason: "Not waiting (--no-wait); the deploy runs in GitHub Actions." };
      if (opts.json) return print({ ok: deployment.status !== "failure", ...result, deployment });
      if (deployment.status === "success") console.log(`\nDeployed: ${deployment.pageUrl ?? "(Pages URL unavailable)"}\nRun: ${deployment.runUrl}`);
      else console.log(`\nDeployment ${deployment.status === "failure" ? "FAILED" : "not confirmed"}: ${deployment.reason}${deployment.runUrl ? `\nRun: ${deployment.runUrl}` : ""}`);
      if (deployment.status === "failure") process.exit(1);
    }),
  );

cli.help();
cli.version(version);

try {
  cli.parse(process.argv, { run: false });
  if (!cli.matchedCommand && cli.args.length === 0 && !cli.options.help && !cli.options.version) {
    cli.outputHelp();
  } else if (!cli.matchedCommand && cli.args.length > 0) {
    throw new VageError(`Unknown command "${cli.args[0]}". Run "vage --help" for the list of commands.`);
  } else {
    await cli.runMatchedCommand();
  }
} catch (err) {
  fail(err, Boolean(cli.options.json));
}

async function run(opts: { json?: boolean }, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    fail(err, Boolean(opts.json));
  }
}

function fail(err: unknown, json: boolean): never {
  const message = err instanceof Error ? err.message : String(err);
  if (json) print({ ok: false, error: message });
  else if (err instanceof VageError) console.error(`Error: ${message}`);
  else console.error(err);
  process.exit(1);
}

function printFindings(findings: Finding[]) {
  for (const f of findings) {
    const where = f.page ? `${f.page}${f.source ? ` (${f.source})` : ""}` : (f.source ?? "site");
    console.log(`${f.severity === "error" ? "error  " : "warning"} ${f.rule.padEnd(22)} ${where}\n        ${f.message}${f.docs ? `\n        see ${f.docs}` : ""}`);
  }
}

type Plan = import("../deploy/publish.js").PublishPlan;

async function confirmPlan(plan: Plan, opts: PublishFlags, extra?: string): Promise<boolean> {
  if (!opts.json || opts.dryRun) {
    const out = opts.json ? console.error : console.log;
    out(`Publish plan for ${plan.root}`);
    if (plan.initRepo) out(`  • git init (branch ${plan.branch})`);
    if (plan.addRemote) out(`  • add origin ${plan.remote}`);
    out(`  • commit ${plan.files.length} file(s) on ${plan.branch}: "${plan.message}"`);
    for (const f of plan.files) out(`      ${f.status} ${f.path}`);
    out(plan.remote ? `  • push to ${plan.remote} (${plan.branch}); never forced` : "  • no push (no remote)");
    if (extra) out(`  • ${extra}`);
    for (const w of plan.warnings) out(`  ! ${w}`);
  }
  if (opts.dryRun) return false;
  if (opts.yes) return true;
  if (!process.stdin.isTTY) throw new VageError("Confirmation required. Review the plan with --dry-run, then re-run with --yes.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question("Proceed? [y/N] ")).trim());
  } finally {
    rl.close();
  }
}

function reportPublish(result: import("../deploy/publish.js").PublishResult) {
  if (result.status === "aborted") return console.log("Nothing changed.");
  if (result.status === "up-to-date") return console.log("Nothing to publish: no changes and the remote is up to date.");
  if (result.status === "committed") return console.log(`Committed ${result.commit!.slice(0, 7)} locally (no remote).`);
  const r = result.confirmedRemote!;
  console.log(`Pushed ${r.sha.slice(0, 7)} to ${r.url} (${r.branch}); confirmed on the remote.`);
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new VageError(`Invalid port "${value}". Use a whole number between 1 and 65535.`);
  }
  return port;
}
