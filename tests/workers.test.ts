import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { deployCloudflareWorkers, planWorkersDeploy, readWranglerConfig } from "../src/deploy/cloudflare-workers.js";
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

const plan = (worker: string) => ({ worker, warnings: [] });

describe("Workers deploy plan", () => {
  it("reads name, folder and 404 handling from wrangler.jsonc with comments and trailing commas", () => {
    const root = copyFixture();
    write(root, "wrangler.jsonc", '{\n  // site\n  "name": "site", /* main */\n  "assets": { "directory": "./dist", "not_found_handling": "404-page", },\n  "x": "a // not a comment",\n}');
    expect(readWranglerConfig(root)).toEqual({ file: "wrangler.jsonc", name: "site", assetsDir: path.join(root, "dist"), notFoundHandling: "404-page" });
  });

  it("reads wrangler.toml", () => {
    const root = copyFixture();
    write(root, "wrangler.toml", 'name = "site"\ncompatibility_date = "2026-10-01"\n\n[assets]\ndirectory = "dist"\nnot_found_handling = "404-page"\n');
    expect(readWranglerConfig(root)).toMatchObject({ name: "site", assetsDir: path.join(root, "dist"), notFoundHandling: "404-page" });
  });

  it("uses the config's Worker, and refuses a different requested name (review finding)", () => {
    const root = copyFixture();
    write(root, "wrangler.jsonc", '{ "name": "prod-site", "assets": { "directory": "dist", "not_found_handling": "404-page" } }');
    expect(planWorkersDeploy(root, undefined).worker).toBe("prod-site");
    expect(planWorkersDeploy(root, "prod-site").worker).toBe("prod-site");
    expect(() => planWorkersDeploy(root, "staging-site")).toThrow(/deploys the Worker "prod-site", but this deploy asks for "staging-site"/);
  });

  it("refuses a config that serves another folder (review finding)", () => {
    const root = copyFixture();
    write(root, "wrangler.jsonc", '{ "name": "site", "assets": { "directory": "./public" } }');
    expect(() => planWorkersDeploy(root, undefined)).toThrow(/assets.directory to "dist" \(it is "public"\)/);
  });

  it("warns when the project's config would hide the 404 page", () => {
    const root = copyFixture();
    write(root, "wrangler.jsonc", '{ "name": "site", "assets": { "directory": "dist" } }');
    expect(planWorkersDeploy(root, undefined).warnings.join()).toMatch(/not_found_handling/);
  });

  it("refuses setups where wrangler could pick another config or Worker (re-review)", () => {
    const two = copyFixture();
    write(two, "wrangler.json", '{ "name": "a", "assets": { "directory": "dist" } }');
    write(two, "wrangler.toml", 'name = "b"\n[assets]\ndirectory = "dist"\n');
    expect(() => planWorkersDeploy(two, undefined)).toThrow(/Keep one wrangler config/);

    const redirected = copyFixture();
    write(redirected, "wrangler.jsonc", '{ "name": "a", "assets": { "directory": "dist" } }');
    write(redirected, ".wrangler/deploy/config.json", '{ "configPath": "../other.json" }');
    expect(() => planWorkersDeploy(redirected, undefined)).toThrow(/redirects wrangler/);

    const envRoot = copyFixture();
    write(envRoot, "wrangler.jsonc", '{ "name": "a", "assets": { "directory": "dist" } }');
    expect(() => readWranglerConfig(envRoot, { CLOUDFLARE_ENV: "staging" })).toThrow(/CLOUDFLARE_ENV/);
  });

  it("reads only top-level name and the [assets] table from TOML, ignoring comments and other tables (re-review)", () => {
    const root = copyFixture();
    write(
      root,
      "wrangler.toml",
      [
        "# name = \"fake\"",
        "name = 'site'",
        "",
        "[assets]",
        "directory = \"dist\" # built output",
        "# not_found_handling = \"404-page\"",
        "",
        "[env.staging]",
        'name = "staging"',
      ].join("\n"),
    );
    expect(readWranglerConfig(root, {})).toMatchObject({ name: "site", assetsDir: path.join(root, "dist"), notFoundHandling: undefined });
  });

  it("handles a BOM and commas inside strings in JSONC (re-review)", () => {
    const root = copyFixture();
    write(root, "wrangler.jsonc", '\uFEFF{ "name": "site", "assets": { "directory": "dist", "not_found_handling": "404-page" }, "note": "a,}" , }');
    expect(readWranglerConfig(root, {})).toMatchObject({ name: "site", notFoundHandling: "404-page" });
  });

  it("needs a name when there is no config", () => {
    expect(() => planWorkersDeploy(copyFixture(), undefined)).toThrow(/No Worker name/);
  });
});

describe("Cloudflare Workers deploy", () => {
  it("uploads a version and switches all traffic to it, keeping the project's wrangler config", async () => {
    const root = copyFixture();
    write(root, "wrangler.jsonc", '{ "name": "site", "assets": { "directory": "dist" } }');
    const r = runner([{ code: 0, stdout: `Worker Version ID: ${VERSION}` }, { code: 0, stdout: "SUCCESS Deployed" }]);
    const result = await deployCloudflareWorkers(root, { plan: planWorkersDeploy(root, undefined), tag: "t1", siteUrl: "https://fixture.example", run: r.run, fetch: ok, ...quiet });
    expect(result).toEqual({ status: "success", worker: "site", mode: "version", versionId: VERSION, pageUrl: "https://fixture.example" });
    const config = path.join(root, "wrangler.jsonc");
    expect(r.calls).toEqual([
      ["npx", "--yes", "wrangler@4.152.0", "versions", "upload", "--tag", "t1", "--config", config],
      ["npx", "--yes", "wrangler@4.152.0", "versions", "deploy", `${VERSION}@100%`, "--yes", "--config", config],
    ]);
  });

  it("generates a temporary config with the 404 page, and removes it", async () => {
    const root = copyFixture();
    const r = runner([{ code: 0, stdout: `Worker Version ID: ${VERSION}` }, { code: 0, stdout: "Deployed https://site.acct.workers.dev" }]);
    const result = await deployCloudflareWorkers(root, { plan: plan("site"), run: r.run, fetch: ok, ...quiet });
    expect(result).toMatchObject({ status: "success", pageUrl: "https://site.acct.workers.dev" });
    expect(r.configs[0]).toEqual({ name: "site", compatibility_date: expect.any(String), assets: { directory: path.join(root, "dist"), not_found_handling: "404-page" } });
    const configPath = r.calls[0]![r.calls[0]!.indexOf("--config") + 1]!;
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(path.join(root, "wrangler.json"))).toBe(false);
  });

  it("verifies the live site, never a version preview URL (review finding)", async () => {
    const root = copyFixture();
    const fetched: string[] = [];
    const track = async (url: string | URL | Request) => (fetched.push(String(url)), new Response("ok"));
    const upload = `Worker Version ID: ${VERSION}\nVersion Preview URL: https://317282a4-site.acct.workers.dev`;
    // A Worker whose name starts like a hash is still its own live URL (re-review).
    const named = await deployCloudflareWorkers(root, { plan: plan("cafebabe-site"), run: runner([{ code: 1, stderr: "[code: 10007] Worker does not exist" }, { code: 0, stdout: "Deployed https://cafebabe-site.acct.workers.dev" }]).run, fetch: track as typeof fetch, ...quiet });
    expect(named.pageUrl).toBe("https://cafebabe-site.acct.workers.dev");
    fetched.length = 0;
    await deployCloudflareWorkers(root, { plan: plan("site"), siteUrl: "https://example.org", run: runner([{ code: 0, stdout: upload }, { code: 0 }]).run, fetch: track as typeof fetch, ...quiet });
    expect(fetched).toEqual(["https://example.org"]);
    fetched.length = 0;
    const noSite = await deployCloudflareWorkers(root, { plan: plan("site"), run: runner([{ code: 0, stdout: upload }, { code: 0 }]).run, fetch: track as typeof fetch, ...quiet });
    expect(noSite.status).toBe("unconfirmed");
    expect(fetched).toEqual([]);
  });

  it("does a first full deploy only when the Worker doesn't exist (review finding)", async () => {
    const root = copyFixture();
    const r = runner([{ code: 1, stderr: "This Worker does not exist on your account. [code: 10007]" }, { code: 0, stdout: "Deployed site https://site.acct.workers.dev" }]);
    const result = await deployCloudflareWorkers(root, { plan: plan("site"), run: r.run, fetch: ok, ...quiet });
    expect(result).toMatchObject({ status: "success", mode: "first-deploy" });
    expect(r.calls[1]!.slice(3, 4)).toEqual(["deploy"]);

    const other = runner([{ code: 1, stderr: "Error: assets directory not found: dist" }]);
    const failed = await deployCloudflareWorkers(root, { plan: plan("site"), run: other.run, ...quiet });
    expect(failed.status).toBe("failure");
    expect(other.calls).toHaveLength(1);
  });

  it("fails clearly, without leaking the token, and never reports unverified success", async () => {
    const token = "cf-secret-token-123456";
    const root = copyFixture();
    const auth = await deployCloudflareWorkers(root, { plan: plan("site"), run: runner([{ code: 1, stderr: `Authentication error [code: 10000] ${token}` }]).run, env: { CLOUDFLARE_API_TOKEN: token }, ...quiet });
    expect(auth.status).toBe("failure");
    expect(auth.reason).toMatch(/CLOUDFLARE_API_TOKEN/);
    expect(auth.reason).not.toContain(token);

    const noSwitch = await deployCloudflareWorkers(root, { plan: plan("site"), run: runner([{ code: 0, stdout: `Version ID: ${VERSION}` }, { code: 1, stderr: "boom" }]).run, ...quiet });
    expect(noSwitch).toMatchObject({ status: "failure", versionId: VERSION, reason: expect.stringMatching(/uploaded but not deployed/) });

    const down = await deployCloudflareWorkers(root, { plan: plan("site"), siteUrl: "https://fixture.example", run: runner([{ code: 0, stdout: `Version ID: ${VERSION}` }, { code: 0 }]).run, fetch: async () => new Response("", { status: 404 }), ...quiet });
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
