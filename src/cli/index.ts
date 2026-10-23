#!/usr/bin/env node
import { createRequire } from "node:module";
import path from "node:path";
import { cac } from "cac";
import { check, type Finding } from "../checks/check.js";
import { build } from "../core/build.js";
import { VageError } from "../core/errors.js";
import { startDevServer } from "../dev/server.js";
import { startPreviewServer } from "../dev/preview.js";
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
      else printFindings(result.findings, result.pagesChecked, result.errors, result.warnings);
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

function printFindings(findings: Finding[], pages: number, errors: number, warnings: number) {
  for (const f of findings) {
    const where = f.page ? `${f.page}${f.source ? ` (${f.source})` : ""}` : (f.source ?? "site");
    console.log(`${f.severity === "error" ? "error  " : "warning"} ${f.rule.padEnd(22)} ${where}\n        ${f.message}${f.docs ? `\n        see ${f.docs}` : ""}`);
  }
  console.log(`\nChecked ${pages} page(s): ${errors} error(s), ${warnings} warning(s).`);
  console.log("Passing checks do not guarantee indexing, rankings, rich results or AI citations.");
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
