import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { deployCloudflareWorkers } from "../src/deploy/cloudflare-workers.js";
import { deployCloudflarePages } from "../src/deploy/cloudflare-pages.js";
import type { Runner } from "../src/deploy/github-pages.js";
import { copyFixture, write } from "./helpers.js";

type Reply = { code: number; stdout?: string; stderr?: string };
function runner(replies: Reply[]) {
  const calls: string[][] = [];
  const configs: unknown[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const at = args.indexOf("--config");
    if (at > -1) configs.push(JSON.parse(fs.readFileSync(args[at + 1]!, "utf8")));
    const r = replies.shift() ?? { code: 0 };
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls, configs };
}
const ok = async () => new Response("ok");
const quiet = { sleep: async () => {} };
const VERSION = "317282a4-115f-451f-bf9f-c155d6ce13f9";

describe("Cloudflare Workers deploy", () => {
  it("uploads a version and switches all traffic to it, keeping the project's wrangler config", async () => {
    const root = copyFixture();
    write(root, "wrangler.jsonc", '{ "name": "site", "assets": { "directory": "dist" } }');
    const r = runner([{ code: 0, stdout: `Worker Version ID: ${VERSION}` }, { code: 0, stdout: "SUCCESS Deployed" }]);
    const result = await deployCloudflareWorkers(root, { worker: "site", tag: "t1", siteUrl: "https://fixture.example", run: r.run, fetch: ok, ...quiet });
    expect(result).toEqual({ status: "success", worker: "site", mode: "version", versionId: VERSION, pageUrl: "https://fixture.example" });
    expect(r.calls).toEqual([
      ["npx", "--yes", "wrangler@4.152.0", "versions", "upload", "--tag", "t1"],
      ["npx", "--yes", "wrangler@4.152.0", "versions", "deploy", `${VERSION}@100%`, "--yes"],
    ]);
  });

  it("generates a temporary config pointing at dist/ when the project has none, and removes it", async () => {
    const root = copyFixture();
    const r = runner([{ code: 0, stdout: `Worker Version ID: ${VERSION}` }, { code: 0, stdout: "Deployed https://site.acct.workers.dev" }]);
    const result = await deployCloudflareWorkers(root, { worker: "site", run: r.run, fetch: ok, ...quiet });
    expect(result).toMatchObject({ status: "success", pageUrl: "https://site.acct.workers.dev" });
    expect(r.configs[0]).toMatchObject({ name: "site", assets: { directory: path.join(root, "dist") } });
    const configPath = r.calls[0]![r.calls[0]!.indexOf("--config") + 1]!;
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(path.join(root, "wrangler.json"))).toBe(false);
  });

  it("does a first full deploy when the Worker doesn't exist yet", async () => {
    const root = copyFixture();
    const r = runner([{ code: 1, stderr: "This Worker does not exist on your account. [code: 10007]" }, { code: 0, stdout: "Deployed site https://site.acct.workers.dev" }]);
    const result = await deployCloudflareWorkers(root, { worker: "site", run: r.run, fetch: ok, ...quiet });
    expect(result).toMatchObject({ status: "success", mode: "first-deploy" });
    expect(r.calls[1]!.slice(3, 4)).toEqual(["deploy"]);
  });

  it("fails clearly, without leaking the token, and never reports unverified success", async () => {
    const token = "cf-secret-token-123456";
    const root = copyFixture();
    const auth = await deployCloudflareWorkers(root, { worker: "site", run: runner([{ code: 1, stderr: `Authentication error [code: 10000] ${token}` }]).run, env: { CLOUDFLARE_API_TOKEN: token }, ...quiet });
    expect(auth.status).toBe("failure");
    expect(auth.reason).toMatch(/CLOUDFLARE_API_TOKEN/);
    expect(auth.reason).not.toContain(token);

    const noSwitch = await deployCloudflareWorkers(root, { worker: "site", run: runner([{ code: 0, stdout: `Version ID: ${VERSION}` }, { code: 1, stderr: "boom" }]).run, ...quiet });
    expect(noSwitch).toMatchObject({ status: "failure", versionId: VERSION, reason: expect.stringMatching(/uploaded but not deployed/) });

    const down = await deployCloudflareWorkers(root, { worker: "site", siteUrl: "https://fixture.example", run: runner([{ code: 0, stdout: `Version ID: ${VERSION}` }, { code: 0 }]).run, fetch: async () => new Response("", { status: 404 }), ...quiet });
    expect(down.status).toBe("unconfirmed");
  });

  it("writes _headers and _redirects for the Workers target too", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", redirects: { "/old/": "/about/" }, deploy: { target: "cloudflare-workers", cloudflareWorker: "site" } };');
    await build(root);
    expect(fs.readFileSync(path.join(root, "dist/_headers"), "utf8")).toContain("Content-Security-Policy");
    expect(fs.readFileSync(path.join(root, "dist/_redirects"), "utf8")).toContain("/old/ /about/ 301");
  });
});

describe("Cloudflare Pages deploy", () => {
  it("points to the Workers target when Cloudflare turned the project into a Worker", async () => {
    const r = runner([{ code: 1, stderr: 'A configuration file was found that does not appear to be for a Pages project (missing "pages_build_output_dir").' }]);
    const result = await deployCloudflarePages("/x", { project: "fixture", branch: "main", run: r.run });
    expect(result.reason).toMatch(/deploy.target to "cloudflare-workers"/);
  });
});
