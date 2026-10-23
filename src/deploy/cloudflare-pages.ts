import { redact } from "../integrations/http.js";
import type { DeployStatus, Runner } from "./github-pages.js";
import { runCommand } from "./github-pages.js";

/** Pinned so deploys are reproducible; checked 2026-10-23. */
export const WRANGLER = "wrangler@4.152.0";

/**
 * Uploads dist/ with `wrangler pages deploy`. Auth comes from the environment
 * (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID) or a prior `wrangler login`.
 * Reports success only when wrangler succeeds AND the deployment URL serves the site.
 */
export async function deployCloudflarePages(
  root: string,
  options: { project: string; branch: string; commit?: string; run?: Runner; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; env?: Record<string, string | undefined> },
): Promise<DeployStatus & { deploymentUrl?: string; branch: string }> {
  const run = options.run ?? runCommand;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const secrets = [(options.env ?? process.env).CLOUDFLARE_API_TOKEN];
  const args = ["--yes", WRANGLER, "pages", "deploy", "dist", "--project-name", options.project, "--branch", options.branch];
  if (options.commit) args.push("--commit-hash", options.commit);

  const res = await run("npx", args, root);
  const output = redact(`${res.stdout}\n${res.stderr}`, secrets);
  if (res.code !== 0) {
    const auth = /auth|login|token|unauthori[sz]ed|10000/i.test(output)
      ? " Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or run `npx wrangler login`."
      : "";
    return { status: "failure", branch: options.branch, reason: `wrangler failed (exit ${res.code}).${auth}\n${tail(output)}` };
  }
  const deploymentUrl = output.match(/https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.pages\.dev/gi)?.at(-1);
  if (!deploymentUrl) return { status: "unconfirmed", branch: options.branch, reason: `wrangler succeeded but printed no deployment URL.\n${tail(output)}` };

  // Wrangler's success is the provider's confirmation; also check the deployment actually serves.
  for (let i = 0; i < 5; i++) {
    const page = await doFetch(deploymentUrl, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    if (page?.ok) return { status: "success", branch: options.branch, deploymentUrl, pageUrl: deploymentUrl };
    await sleep(3000);
  }
  return { status: "unconfirmed", branch: options.branch, deploymentUrl, reason: `Uploaded, but ${deploymentUrl} did not respond with 200 yet. Check it in a minute.` };
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-8).join("\n");
}
