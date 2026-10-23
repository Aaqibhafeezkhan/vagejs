import fs from "node:fs";
import path from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { parseConfig } from "../src/core/config.js";
import { routeForPage } from "../src/core/routes.js";
import { deployCloudflarePages } from "../src/deploy/cloudflare-pages.js";
import type { Runner } from "../src/deploy/github-pages.js";
import { submitIndexNow } from "../src/integrations/indexnow.js";
import { analyticsTags } from "../src/integrations/tags.js";
import { copyFixture, write } from "./helpers.js";

const PLAUSIBLE = '<script defer src="https://plausible.example/js/pa-abc.js"></script>';
const CLARITY = '<script>/* clarity tracking code */</script>';
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

function site(integrations: string, extra = "") {
  const root = copyFixture();
  write(root, "vage.config.ts", `export default { site: "https://fixture.example", title: "Fixture Site", integrations: ${integrations}${extra} };`);
  write(root, "src/layouts/plain.ts", 'export default ({ content }: { content: string }) => `<html lang="en"><head><title>t</title></head><body><main>${content}</main></body></html>`;');
  return root;
}

describe("Plausible and Clarity", () => {
  it("validates pasted snippets", () => {
    expect(() => parseConfig({ integrations: { plausible: { snippet: "plausible.io" } } })).toThrow(/<script> snippet/);
    expect(() => parseConfig({ integrations: { clarity: { snippet: '<script src="https://www.googletagmanager.com/gtag/js"></script>' } } })).toThrow(/integrations.ga4/);
  });

  it("injects the snippets verbatim, first in <head>", async () => {
    const root = site(`{ plausible: { snippet: ${JSON.stringify(PLAUSIBLE)} }, clarity: { snippet: ${JSON.stringify(CLARITY)} } }`);
    await build(root);
    const html = fs.readFileSync(path.join(root, "dist", "about", "index.html"), "utf8");
    expect(html.indexOf(PLAUSIBLE)).toBeGreaterThan(-1);
    expect(html.indexOf(CLARITY)).toBeGreaterThan(-1);
    expect(html.indexOf(PLAUSIBLE)).toBeLessThan(html.indexOf("<title>"));
    expect(html).not.toContain("googletagmanager");
  });

  it("forwards consent to Google and Clarity and sends events to every provider (runs the generated script)", () => {
    const tags = analyticsTags(
      parseConfig({
        integrations: { ga4: { measurementId: "G-TEST123", events: { signup: { params: ["plan"] } } }, plausible: { snippet: PLAUSIBLE, events: { signup: { params: ["plan"] } } } },
      }),
    )!;
    // Run only the inline scripts (no network) on a non-localhost origin, with provider stubs.
    const inline = [...tags.head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    const dom = new JSDOM('<button data-vage-event="signup" data-vage-param-plan="pro">Go</button>', {
      url: "https://fixture.example/",
      runScripts: "outside-only",
      virtualConsole: new VirtualConsole(),
    });
    const w = dom.window as unknown as Record<string, any> & { eval(s: string): void };
    w.plausible = vi.fn();
    w.clarity = vi.fn();
    for (const src of inline) w.eval(src);

    expect(w.dataLayer[0][0]).toBe("consent");
    expect(w.dataLayer[0][1]).toBe("default");
    w.vageConsent.update({ analytics_storage: "granted" });
    expect(w.clarity).toHaveBeenCalledWith("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
    expect([...w.dataLayer.at(-1)]).toEqual(["consent", "update", { analytics_storage: "granted" }]);

    w.document.querySelector("button").click();
    expect(w.plausible).toHaveBeenCalledWith("signup", { props: { plan: "pro" } });
    expect([...w.dataLayer.at(-1)]).toEqual(["event", "signup", { plan: "pro" }]);
  });

  it("requires events to be declared for every provider that receives them", async () => {
    const root = site(`{ ga4: { measurementId: "G-TEST123", events: { signup: {} } }, plausible: { snippet: ${JSON.stringify(PLAUSIBLE)} } }`);
    write(root, "src/pages/index.md", '---\ntitle: Home\ndescription: Home.\n---\n# Home\n\n<a href="/about/" data-vage-event="signup">Go</a>\n');
    const messages = (await check(root)).findings.filter((f) => f.rule === "analytics-event").map((f) => f.message);
    expect(messages).toEqual(['Event "signup" is not declared. Add it to integrations.plausible.events in vage.config.ts.']);
  });
});

describe("IndexNow", () => {
  const KEY = "a1b2c3d4-e5f6";

  it("validates the key and serves it as /<key>.txt", async () => {
    expect(() => parseConfig({ integrations: { indexNow: { key: "short" } } })).toThrow(/8-128 characters/);
    const root = site(`{ indexNow: { key: "${KEY}" } }`);
    const result = await build(root);
    expect(result.files).toContain(`${KEY}.txt`);
    expect(fs.readFileSync(path.join(root, "dist", `${KEY}.txt`), "utf8")).toBe(`${KEY}\n`);
  });

  it("checks the live key file, then posts host, key, keyLocation and urlList", async () => {
    let body: Record<string, unknown> = {};
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith(".txt")) return new Response(`${KEY}\n`);
      body = JSON.parse(String(init!.body));
      return json(202);
    };
    const result = await submitIndexNow({ site: "https://fixture.example", key: KEY, endpoint: "https://api.indexnow.org/indexnow", urls: ["https://fixture.example/a/", "https://fixture.example/a/"], http: { fetch: fetchMock } });
    expect(result).toEqual({ endpoint: "https://api.indexnow.org/indexnow", submitted: 1, status: 202 });
    expect(body).toEqual({ host: "fixture.example", key: KEY, keyLocation: `https://fixture.example/${KEY}.txt`, urlList: ["https://fixture.example/a/"] });
  });

  it("refuses before submitting when the key file is not live or URLs are foreign", async () => {
    const opts = { site: "https://fixture.example", key: KEY, endpoint: "https://api.indexnow.org/indexnow" };
    await expect(submitIndexNow({ ...opts, urls: ["https://fixture.example/"], http: { fetch: async () => new Response("nope", { status: 404 }) } })).rejects.toThrow(/is not live yet/);
    await expect(submitIndexNow({ ...opts, urls: ["https://other.example/"] })).rejects.toThrow(/only accepts URLs on fixture.example/);
  });

  it("does not retry 429 and explains it", async () => {
    let posts = 0;
    const fetchMock = async (url: string | URL | Request) => (String(url).endsWith(".txt") ? new Response(KEY) : (posts++, json(429)));
    await expect(
      submitIndexNow({ site: "https://fixture.example", key: KEY, endpoint: "https://api.indexnow.org/indexnow", urls: ["https://fixture.example/"], http: { fetch: fetchMock, sleep: async () => {} } }),
    ).rejects.toThrow(/HTTP 429.*treat this as spam/);
    expect(posts).toBe(1);
  });

  it("maps page files (including deleted ones) to routes", () => {
    expect(routeForPage("index.md")).toBe("/");
    expect(routeForPage("blog/post.md")).toBe("/blog/post/");
    expect(routeForPage("blog/index.md")).toBe("/blog/");
    expect(routeForPage("404.md")).toBeUndefined();
    expect(routeForPage("_drafts/x.md")).toBeUndefined();
  });
});

describe("Cloudflare Pages", () => {
  it("emits _redirects with real 301s only for the cloudflare-pages target", async () => {
    const root = site("{}", ', redirects: { "/old/": "/about/" }, deploy: { target: "cloudflare-pages", cloudflareProject: "fixture" }');
    await build(root);
    expect(fs.readFileSync(path.join(root, "dist", "_redirects"), "utf8")).toBe("# Generated by VAGE JS from redirects in vage.config.ts\n/old/ /about/ 301\n/old /about/ 301\n");
    expect(fs.existsSync(path.join(root, "dist", "old", "index.html"))).toBe(true); // fallback stays

    const gh = site("{}", ', redirects: { "/old/": "/about/" }');
    await build(gh);
    expect(fs.existsSync(path.join(gh, "dist", "_redirects"))).toBe(false);
  });

  const runner = (code: number, stdout: string, stderr = ""): { run: Runner; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, run: async (cmd, args) => (calls.push([cmd, ...args]), { code, stdout, stderr }) };
  };

  it("succeeds only when wrangler succeeds and the deployment URL serves", async () => {
    const r = runner(0, "✨ Deployment complete! Take a peek over at https://abc123.fixture.pages.dev");
    const result = await deployCloudflarePages("/x", { project: "fixture", branch: "feature", commit: "abc", run: r.run, fetch: async () => new Response("ok"), sleep: async () => {} });
    expect(result).toEqual({ status: "success", branch: "feature", deploymentUrl: "https://abc123.fixture.pages.dev", pageUrl: "https://abc123.fixture.pages.dev" });
    expect(r.calls[0]).toEqual(["npx", "--yes", "wrangler@4.152.0", "pages", "deploy", "dist", "--project-name", "fixture", "--branch", "feature", "--commit-hash", "abc"]);

    const down = await deployCloudflarePages("/x", { project: "fixture", branch: "main", run: r.run, fetch: async () => new Response("", { status: 404 }), sleep: async () => {} });
    expect(down).toMatchObject({ status: "unconfirmed", deploymentUrl: "https://abc123.fixture.pages.dev" });

    const noUrl = await deployCloudflarePages("/x", { project: "fixture", branch: "main", run: runner(0, "done").run, sleep: async () => {} });
    expect(noUrl).toMatchObject({ status: "unconfirmed", reason: expect.stringMatching(/no deployment URL/) });
  });

  it("explains auth failures without leaking the API token", async () => {
    const token = "cf-secret-token-123456";
    const r = runner(1, "", `Authentication error [code: 10000] token=${token}`);
    const result = await deployCloudflarePages("/x", { project: "fixture", branch: "main", run: r.run, env: { CLOUDFLARE_API_TOKEN: token } });
    expect(result.status).toBe("failure");
    expect(result.reason).toMatch(/CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/);
    expect(result.reason).not.toContain(token);
  });
});
