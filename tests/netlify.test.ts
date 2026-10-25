import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import type { Runner } from "../src/deploy/github-pages.js";
import { deployNetlify, NETLIFY_CLI } from "../src/deploy/netlify.js";
import { copyFixture } from "./helpers.js";

type Reply = { code: number; stdout?: string; stderr?: string };
function runner(reply: Reply) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: reply.code, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  return { run, calls };
}
const quiet = { sleep: async () => {} };
const JSON_OUT = JSON.stringify({ site_id: "abc", site_name: "my-site", deploy_id: "d1", deploy_url: "https://d1--my-site.netlify.app", url: "https://my-site.netlify.app" });

describe("Netlify", () => {
  it("writes forced redirects and the security headers when the target is netlify", async () => {
    const root = copyFixture();
    const config = path.join(root, "vage.config.ts");
    fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace("redirects: {", 'deploy: { target: "netlify", netlifySite: "my-site" },\n  redirects: {'));
    const result = await build(root);
    expect(result.files).toEqual(expect.arrayContaining(["_redirects", "_headers"]));
    const redirects = fs.readFileSync(path.join(root, "dist", "_redirects"), "utf8");
    expect(redirects).toContain("/old/ /about/ 301!\n/old /about/ 301!");
    expect(fs.readFileSync(path.join(root, "dist", "_headers"), "utf8")).toContain("Content-Security-Policy");
  });

  it("deploys dist/ to production without a Netlify build, then checks the live site", async () => {
    const { run, calls } = runner({ code: 0, stdout: `Deploying...\n${JSON_OUT}` });
    const fetched: string[] = [];
    const result = await deployNetlify("/p", { site: "my-site", run, fetch: async (u) => (fetched.push(String(u)), new Response("ok")), ...quiet });
    expect(calls).toEqual([["npx", "--yes", NETLIFY_CLI, "deploy", "--dir", "dist", "--prod", "--no-build", "--site", "my-site", "--json"]]);
    expect(result).toEqual({ status: "success", site: "my-site", deployId: "d1", pageUrl: "https://my-site.netlify.app" });
    expect(fetched).toEqual(["https://my-site.netlify.app"]);
  });

  it("checks the configured site URL and points to the Netlify URL when it doesn't answer", async () => {
    const { run } = runner({ code: 0, stdout: JSON_OUT });
    const result = await deployNetlify("/p", { site: "my-site", siteUrl: "https://example.org", run, fetch: async () => new Response("no", { status: 404 }), ...quiet });
    expect(result.status).toBe("unconfirmed");
    expect(result.reason).toContain("The site itself is at https://my-site.netlify.app");
  });

  it("explains login problems and hides the token", async () => {
    const { run } = runner({ code: 1, stderr: "Error: Unauthorized, token secret-token-123 rejected" });
    const result = await deployNetlify("/p", { site: "my-site", run, env: { NETLIFY_AUTH_TOKEN: "secret-token-123" }, ...quiet });
    expect(result.status).toBe("failure");
    expect(result.reason).toContain("Set NETLIFY_AUTH_TOKEN, or run `npx netlify-cli login`.");
    expect(result.reason).not.toContain("secret-token-123");
  });
});
