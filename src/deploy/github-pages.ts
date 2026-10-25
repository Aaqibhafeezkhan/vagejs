import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const PAGES_WORKFLOW = ".github/workflows/deploy.yml";

/**
 * GitHub Actions workflow: check and build on every push to `branch` and once a day
 * (so pages with a future datePublished go live on their day), then
 * deploy dist/ to GitHub Pages. Action majors checked 2026-10-23 against
 * https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
 * and each action's latest release. Least privilege: only the deploy job can write to Pages.
 */
export function pagesWorkflow(branch: string): string {
  return `name: Deploy to GitHub Pages

on:
  push:
    branches: [${JSON.stringify(branch)}]
  schedule:
    - cron: "15 0 * * *" # daily, so scheduled pages go live on their day
  workflow_dispatch:

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0 # full history, so seo.lastmod: "git" can date pages
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx vage check
      - run: npx vage build
      - uses: actions/configure-pages@v6
      - uses: actions/upload-pages-artifact@v5
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
`;
}

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * npm's npx script, for Windows: there `npx` is npx.cmd, which Node only runs through a
 * shell (and a shell would re-parse the arguments). Running npx-cli.js with node avoids both.
 */
export function npxCli(env: Record<string, string | undefined> = process.env, execPath = process.execPath): string | undefined {
  const candidates = [
    env.npm_execpath && path.join(path.dirname(env.npm_execpath), "npx-cli.js"),
    path.join(path.dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  return candidates.find((f): f is string => Boolean(f) && fs.existsSync(f as string));
}

export const runCommand: Runner = (cmd, args, cwd) =>
  new Promise((resolve) => {
    const cli = cmd === "npx" && process.platform === "win32" ? npxCli() : undefined;
    if (cli) [cmd, args] = [process.execPath, [cli, ...args]];
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      resolve({ code: !err ? 0 : code === "ENOENT" ? 127 : typeof code === "number" ? code : 1, stdout, stderr });
    });
  });

export interface DeployStatus {
  status: "success" | "failure" | "unconfirmed";
  runUrl?: string;
  pageUrl?: string;
  reason?: string;
}

/** Turns on Pages with "GitHub Actions" as the source if it is not enabled yet. Uses the gh CLI. */
export async function ensurePagesEnabled(cwd: string, run: Runner = runCommand): Promise<"enabled" | "already-enabled" | { manual: string }> {
  const manual = 'Enable it in the repository: Settings → Pages → Build and deployment → Source: "GitHub Actions".';
  if ((await run("gh", ["auth", "status"], cwd)).code !== 0) return { manual: `GitHub CLI (gh) is not available or not logged in. ${manual}` };
  if ((await run("gh", ["api", "repos/{owner}/{repo}/pages"], cwd)).code === 0) return "already-enabled";
  const created = await run("gh", ["api", "-X", "POST", "repos/{owner}/{repo}/pages", "-f", "build_type=workflow"], cwd);
  return created.code === 0 ? "enabled" : { manual: `Could not enable Pages automatically (${created.stderr.trim()}). ${manual}` };
}

/**
 * Waits for the Pages workflow run for `sha` and reports what GitHub says.
 * Without gh, or if the run never appears, the result is "unconfirmed", never success.
 */
export async function confirmPagesDeployment(
  cwd: string,
  sha: string,
  options: { run?: Runner; sleep?: (ms: number) => Promise<void>; findRunAttempts?: number } = {},
): Promise<DeployStatus> {
  const run = options.run ?? runCommand;
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if ((await run("gh", ["auth", "status"], cwd)).code !== 0) {
    return { status: "unconfirmed", reason: "GitHub CLI (gh) is not available or not logged in; check the Actions tab for the deploy run." };
  }

  let runId: number | undefined;
  let runUrl: string | undefined;
  for (let i = 0; i < (options.findRunAttempts ?? 20) && runId === undefined; i++) {
    const list = await run("gh", ["run", "list", "--workflow", "deploy.yml", "--commit", sha, "--json", "databaseId,url", "--limit", "1"], cwd);
    const [found] = list.code === 0 ? (JSON.parse(list.stdout || "[]") as { databaseId: number; url: string }[]) : [];
    if (found) ({ databaseId: runId, url: runUrl } = found);
    else await sleep(3000);
  }
  if (runId === undefined) return { status: "unconfirmed", reason: `No deploy.yml run found for ${sha.slice(0, 7)}. Is the workflow on the pushed branch?` };

  await run("gh", ["run", "watch", String(runId), "--exit-status", "--interval", "5"], cwd);
  const view = await run("gh", ["run", "view", String(runId), "--json", "conclusion,url"], cwd);
  const conclusion = view.code === 0 ? (JSON.parse(view.stdout) as { conclusion: string }).conclusion : "unknown";
  if (conclusion !== "success") return { status: "failure", runUrl, reason: `Deploy run finished with "${conclusion}". See the run for logs.` };

  const pages = await run("gh", ["api", "repos/{owner}/{repo}/pages", "--jq", ".html_url"], cwd);
  return { status: "success", runUrl, pageUrl: pages.code === 0 ? pages.stdout.trim() || undefined : undefined };
}

/**
 * GitHub Pages serves a repository named anything but <owner>.github.io from a subfolder
 * (https://owner.github.io/repo/). vagejs sites need the root of a domain (links like
 * /about/ would point outside the site), so that only works with a custom domain.
 * Returns the problem to show before anything is pushed, or undefined when it's fine.
 */
export function pagesSubfolderProblem(site: string | undefined, remote: string | undefined): string | undefined {
  const m = remote && /(?:^|[@/])github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  if (!m || !site) return undefined;
  const [, owner, repo] = m as unknown as [string, string, string];
  if (repo.toLowerCase() === `${owner}.github.io`.toLowerCase()) return undefined;
  if (!/\.github\.io$/i.test(new URL(site).hostname)) return undefined; // a custom domain serves the root
  return (
    `GitHub Pages would serve this repository at https://${owner.toLowerCase()}.github.io/${repo}/, a subfolder, ` +
    `but a vagejs site must be served from the root of a domain: links like /about/ would point outside the site. Either:\n` +
    `  - use your own domain: set site to it in vage.config.ts and add it in the repository under Settings → Pages → Custom domain, or\n` +
    `  - publish from a repository named ${owner}.github.io (set site to https://${owner.toLowerCase()}.github.io).`
  );
}
