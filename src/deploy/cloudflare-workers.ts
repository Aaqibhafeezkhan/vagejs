import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "../integrations/http.js";
import { WRANGLER } from "./cloudflare-pages.js";
import type { DeployStatus, Runner } from "./github-pages.js";
import { runCommand } from "./github-pages.js";

export const WRANGLER_CONFIGS = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

/** Compatibility date for the generated config; Workers static assets need nothing newer. Checked 2026-10-23. */
export const COMPATIBILITY_DATE = "2026-10-01";

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
 * - With a wrangler.json(c)/.toml in the project (needed for custom domains and routes),
 *   that file is used as-is, including its Worker name. Otherwise a temporary config pointing at dist/ is generated,
 *   so the project gains no files.
 * - Existing Workers get `wrangler versions upload` + `versions deploy <id>@100%`: the new
 *   version takes all traffic without re-applying routes or custom domains, so the site
 *   stays up. A Worker that doesn't exist yet gets a first `wrangler deploy`.
 * - Success needs wrangler to succeed AND the site to answer 200 (the workers.dev URL
 *   wrangler prints, or `siteUrl`).
 */
export async function deployCloudflareWorkers(
  root: string,
  options: {
    worker: string;
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
  const worker = options.worker;

  const own = WRANGLER_CONFIGS.find((f) => fs.existsSync(path.join(root, f)));
  let tempDir: string | undefined;
  const configArgs: string[] = [];
  if (!own) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vage-wrangler-"));
    const config = { name: worker, compatibility_date: COMPATIBILITY_DATE, assets: { directory: path.join(root, "dist") } };
    fs.writeFileSync(path.join(tempDir, "wrangler.json"), JSON.stringify(config, null, 2));
    configArgs.push("--config", path.join(tempDir, "wrangler.json"));
  }

  try {
    const wrangler = (...args: string[]) => run("npx", ["--yes", WRANGLER, ...args, ...configArgs], root);
    const out = (r: { stdout: string; stderr: string }) => redact(`${r.stdout}\n${r.stderr}`, secrets);
    const fail = (code: number, text: string): WorkersDeployment => {
      const auth = /auth|login|token|unauthori[sz]ed|10000/i.test(text) ? " Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or run `npx wrangler login`." : "";
      return { status: "failure", worker, reason: `wrangler failed (exit ${code}).${auth}\n${tail(text)}` };
    };

    let mode: WorkersDeployment["mode"] = "version";
    let versionId: string | undefined;
    let output: string;
    const tag = options.tag ?? `vage-${Date.now()}`;
    const upload = await wrangler("versions", "upload", "--tag", tag);
    output = out(upload);
    if (upload.code !== 0) {
      // A Worker that doesn't exist yet can't take a version; deploy it once.
      if (!/does not exist|not found|10007/i.test(output)) return fail(upload.code, output);
      mode = "first-deploy";
      const first = await wrangler("deploy");
      output = out(first);
      if (first.code !== 0) return fail(first.code, output);
    } else {
      versionId = /Version ID:\s*([0-9a-f-]{36})/i.exec(output)?.[1];
      if (!versionId) return { status: "failure", worker, reason: `wrangler uploaded but printed no version ID.\n${tail(output)}` };
      const switched = await wrangler("versions", "deploy", `${versionId}@100%`, "--yes");
      const switchOut = out(switched);
      if (switched.code !== 0) return { ...fail(switched.code, switchOut), versionId, reason: `Version ${versionId} uploaded but not deployed. ${fail(switched.code, switchOut).reason}` };
      output += `\n${switchOut}`;
    }

    const pageUrl = output.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/gi)?.at(-1) ?? options.siteUrl;
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
