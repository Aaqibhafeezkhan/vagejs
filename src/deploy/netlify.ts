import { redact } from "../integrations/http.js";
import type { DeployStatus, Runner } from "./github-pages.js";
import { runCommand } from "./github-pages.js";

/** Pinned so deploys are reproducible; checked 2026-10-25. */
export const NETLIFY_CLI = "netlify-cli@27.12.1";

export interface NetlifyDeployment extends DeployStatus {
  site: string;
  deployId?: string;
}

/**
 * Uploads dist/ to a Netlify site's production deploy with netlify-cli (no Netlify build:
 * vagejs already built it). Auth comes from NETLIFY_AUTH_TOKEN or a prior `netlify login`,
 * never a command-line flag. The build wrote Netlify's _headers and _redirects (forced
 * 301s, so they win over the HTML forwarding pages). Success needs netlify-cli to
 * succeed AND the live site to answer 200: `siteUrl` when set, else the site's Netlify URL.
 */
export async function deployNetlify(
  root: string,
  options: { site: string; siteUrl?: string; run?: Runner; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; env?: Record<string, string | undefined> },
): Promise<NetlifyDeployment> {
  const run = options.run ?? runCommand;
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const secrets = [(options.env ?? process.env).NETLIFY_AUTH_TOKEN];
  const { site } = options;

  const res = await run("npx", ["--yes", NETLIFY_CLI, "deploy", "--dir", "dist", "--prod", "--no-build", "--site", site, "--json"], root);
  const output = redact(`${res.stdout}\n${res.stderr}`, secrets);
  if (res.code !== 0) {
    const auth = /auth|log ?in|token|unauthori[sz]ed|401/i.test(output) ? " Set NETLIFY_AUTH_TOKEN, or run `npx netlify-cli login`." : "";
    const missing = /not found|404|no (?:project|site)/i.test(output) ? ` Check that the Netlify site "${site}" exists (deploy.netlifySite is its name or ID).` : "";
    return { status: "failure", site, reason: `netlify-cli failed (exit ${res.code}).${auth}${missing}\n${tail(output)}` };
  }
  let data: { deploy_id?: unknown; url?: unknown; deploy_url?: unknown } = {};
  try {
    data = JSON.parse(res.stdout.slice(res.stdout.indexOf("{")));
  } catch {
    // Older or newer netlify-cli output; the live check below still decides.
  }
  const deployId = typeof data.deploy_id === "string" ? data.deploy_id : undefined;
  const netlifyUrl = typeof data.url === "string" && /^https:\/\//.test(data.url) ? data.url : undefined;
  const pageUrl = options.siteUrl ?? netlifyUrl;
  if (!pageUrl) return { status: "unconfirmed", site, deployId, reason: `Uploaded, but there is no URL to check: set \`site\` in vage.config.ts.\n${tail(output)}` };
  for (let i = 0; i < 5; i++) {
    const page = await doFetch(pageUrl, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    if (page?.ok) return { status: "success", site, deployId, pageUrl };
    await sleep(3000);
  }
  const own = netlifyUrl && netlifyUrl !== pageUrl ? ` The site itself is at ${netlifyUrl}. If ${pageUrl} is your own domain, add it in Netlify under Domain management.` : "";
  return { status: "unconfirmed", site, deployId, pageUrl, reason: `Deployed, but ${pageUrl} did not respond with 200 yet. Check it in a minute.${own}` };
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-8).join("\n");
}
