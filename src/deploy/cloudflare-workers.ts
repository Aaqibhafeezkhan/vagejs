import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VageError } from "../core/errors.js";
import { redact } from "../integrations/http.js";
import { WRANGLER } from "./cloudflare-pages.js";
import type { DeployStatus, Runner } from "./github-pages.js";
import { runCommand } from "./github-pages.js";

export const WRANGLER_CONFIGS = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

/** Compatibility date for the generated config; Workers static assets need nothing newer. Checked 2026-10-23. */
export const COMPATIBILITY_DATE = "2026-10-01";

/** What vagejs needs to know from a project's own wrangler config. */
export interface WranglerConfig {
  file: string;
  name?: string;
  /** assets.directory, resolved against the project root. */
  assetsDir?: string;
  notFoundHandling?: string;
}

/** Reads name and assets settings from wrangler.jsonc/.json (comments allowed) or wrangler.toml. */
export function readWranglerConfig(root: string): WranglerConfig | undefined {
  const file = WRANGLER_CONFIGS.find((f) => fs.existsSync(path.join(root, f)));
  if (!file) return undefined;
  const text = fs.readFileSync(path.join(root, file), "utf8");
  let name: unknown, dir: unknown, nf: unknown;
  if (file.endsWith(".toml")) {
    name = /^\s*name\s*=\s*"([^"]*)"/m.exec(text)?.[1];
    const assets = /^\s*\[assets\]([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
    dir = /^\s*directory\s*=\s*"([^"]*)"/m.exec(assets)?.[1] ?? /^\s*assets\s*=\s*\{[^}]*directory\s*=\s*"([^"]*)"/m.exec(text)?.[1];
    nf = /not_found_handling\s*=\s*"([^"]*)"/.exec(text)?.[1];
  } else {
    let data: { name?: unknown; assets?: { directory?: unknown; not_found_handling?: unknown } };
    try {
      data = JSON.parse(stripJsonComments(text));
    } catch (err) {
      throw new VageError(`Could not read ${file}: ${(err as Error).message}`, path.join(root, file));
    }
    ({ name } = data);
    dir = data.assets?.directory;
    nf = data.assets?.not_found_handling;
  }
  return {
    file,
    name: typeof name === "string" ? name : undefined,
    assetsDir: typeof dir === "string" ? path.resolve(root, dir) : undefined,
    notFoundHandling: typeof nf === "string" ? nf : undefined,
  };
}

/** JSONC to JSON: drops // and /* *\/ comments and trailing commas, leaving strings alone. */
function stripJsonComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = i;
      const m = end.exec(text);
      const str = m ? m[0] : text.slice(i);
      out += str;
      i += str.length - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i === -1) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export interface WorkersPlan {
  /** The Worker that will actually be deployed. */
  worker: string;
  /** The project's wrangler config, if it has one. */
  config?: WranglerConfig;
  warnings: string[];
}

/**
 * Decides which Worker gets deployed, and refuses setups where the plan and what
 * wrangler would actually do differ (another Worker name, or a folder other than dist/).
 */
export function planWorkersDeploy(root: string, requested: string | undefined): WorkersPlan {
  const config = readWranglerConfig(root);
  const warnings: string[] = [];
  if (!config) {
    if (!requested) throw new VageError("No Worker name. Pass --project <name>, set deploy.cloudflareWorker, or add a wrangler.jsonc.");
    return { worker: requested, warnings };
  }
  if (!config.name) throw new VageError(`${config.file} has no "name". Add the Worker's name there.`, path.join(root, config.file));
  if (requested && requested !== config.name) {
    throw new VageError(
      `${config.file} deploys the Worker "${config.name}", but this deploy asks for "${requested}". ` +
        `Make them match (deploy.cloudflareWorker / --project, or "name" in ${config.file}); vagejs won't deploy a different Worker than it shows.`,
    );
  }
  const dist = path.join(root, "dist");
  if (config.assetsDir !== dist) {
    throw new VageError(
      `${config.file} must serve the built site: set assets.directory to "dist" (it is ${config.assetsDir ? `"${path.relative(root, config.assetsDir) || "."}"` : "not set"}).`,
      path.join(root, config.file),
    );
  }
  if (config.notFoundHandling !== "404-page" && fs.existsSync(path.join(root, "src", "pages", "404.md"))) {
    warnings.push(`${config.file}: add "not_found_handling": "404-page" under "assets", or unknown URLs get an empty 404 instead of your 404 page.`);
  }
  return { worker: config.name, config, warnings };
}

export interface WorkersDeployment extends DeployStatus {
  worker: string;
  /** How it was deployed: a new version switched to 100% (existing Worker), or a full first deploy. */
  mode?: "version" | "first-deploy";
  versionId?: string;
}

/**
 * Deploys dist/ as a Cloudflare Worker with static assets (what Cloudflare now creates
 * instead of Pages projects; `_headers` and `_redirects` still apply).
 *
 * - With a wrangler config in the project (needed for custom domains and routes), that
 *   file is used as-is; `planWorkersDeploy` has already checked its name and folder.
 *   Otherwise a temporary config pointing at dist/ is generated, so the project gains no files.
 * - Existing Workers get `wrangler versions upload` + `versions deploy <id>@100%`: the new
 *   version takes all traffic without re-applying routes or custom domains, so the site
 *   stays up. Only Cloudflare's "Worker doesn't exist" error leads to a first `wrangler deploy`.
 * - Success needs wrangler to succeed AND the live site to answer 200: `siteUrl` when set,
 *   else the Worker's workers.dev URL (never a version preview URL).
 */
export async function deployCloudflareWorkers(
  root: string,
  options: {
    plan: WorkersPlan;
    tag?: string;
    siteUrl?: string;
    run?: Runner;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    env?: Record<string, string | undefined>;
  },
): Promise<WorkersDeployment> {
  const run = options.run ?? runCommand;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const secrets = [(options.env ?? process.env).CLOUDFLARE_API_TOKEN];
  const { worker } = options.plan;

  let tempDir: string | undefined;
  const configArgs: string[] = [];
  if (!options.plan.config) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vage-wrangler-"));
    const config = {
      name: worker,
      compatibility_date: COMPATIBILITY_DATE,
      assets: { directory: path.join(root, "dist"), not_found_handling: "404-page" },
    };
    fs.writeFileSync(path.join(tempDir, "wrangler.json"), JSON.stringify(config, null, 2));
    configArgs.push("--config", path.join(tempDir, "wrangler.json"));
  }

  try {
    const wrangler = (...args: string[]) => run("npx", ["--yes", WRANGLER, ...args, ...configArgs], root);
    const out = (r: { stdout: string; stderr: string }) => redact(`${r.stdout}\n${r.stderr}`, secrets);
    const failReason = (code: number, text: string) => {
      const auth = /auth|login|token|unauthori[sz]ed|10000/i.test(text) ? " Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or run `npx wrangler login`." : "";
      return `wrangler failed (exit ${code}).${auth}\n${tail(text)}`;
    };

    let mode: WorkersDeployment["mode"] = "version";
    let versionId: string | undefined;
    let output: string;
    const tag = options.tag ?? `vage-${Date.now()}`;
    const upload = await wrangler("versions", "upload", "--tag", tag);
    output = out(upload);
    if (upload.code !== 0) {
      // Only a Worker that doesn't exist yet gets a full deploy (which also attaches routes).
      if (!/\b10007\b|worker[^\n]*(?:does not exist|not found)/i.test(output)) return { status: "failure", worker, reason: failReason(upload.code, output) };
      mode = "first-deploy";
      const first = await wrangler("deploy");
      output = out(first);
      if (first.code !== 0) return { status: "failure", worker, mode, reason: failReason(first.code, output) };
    } else {
      versionId = /Version ID:\s*([0-9a-f-]{36})/i.exec(output)?.[1];
      if (!versionId) return { status: "failure", worker, reason: `wrangler uploaded but printed no version ID.\n${tail(output)}` };
      const switched = await wrangler("versions", "deploy", `${versionId}@100%`, "--yes");
      if (switched.code !== 0) return { status: "failure", worker, versionId, reason: `Version ${versionId} uploaded but not deployed. ${failReason(switched.code, out(switched))}` };
      output += `\n${out(switched)}`;
    }

    // Version preview URLs (https://<8 hex>-<worker>.<sub>.workers.dev) show the new version even when the live site doesn't.
    const workersDev = output
      .split("\n")
      .filter((line) => !/preview/i.test(line))
      .join("\n")
      .match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/gi)
      ?.filter((u) => !/^https:\/\/[0-9a-f]{8}-/i.test(u))
      .at(-1);
    const pageUrl = options.siteUrl ?? workersDev;
    if (!pageUrl) return { status: "unconfirmed", worker, mode, versionId, reason: "Deployed, but there is no URL to check: set `site` in vage.config.ts." };
    for (let i = 0; i < 5; i++) {
      const page = await doFetch(pageUrl, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
      if (page?.ok) return { status: "success", worker, mode, versionId, pageUrl };
      await sleep(3000);
    }
    return { status: "unconfirmed", worker, mode, versionId, pageUrl, reason: `Deployed, but ${pageUrl} did not respond with 200 yet. Check it in a minute.` };
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-8).join("\n");
}
