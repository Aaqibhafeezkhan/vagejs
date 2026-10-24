import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { auditAccessibility } from "../src/audit/a11y.js";
import { audit } from "../src/audit/audit.js";
import { budgetFindings, measurePages } from "../src/audit/budgets.js";
import { runLighthouse } from "../src/audit/lighthouse.js";
import { cruxField, pageSpeed, redact } from "../src/audit/remote.js";
import { rate } from "../src/audit/vitals.js";
import { parseConfig } from "../src/core/config.js";
import { removeApiKey, resolveApiKey, saveApiKey } from "../src/integrations/api-keys.js";
import { copyFixture, write, WINDOWS } from "./helpers.js";

const KEY = "AIzaTEST-secret-key-0123456789";
const tmpConfig = () => fs.mkdtempSync(path.join(os.tmpdir(), "vage-keys-"));
const budgets = parseConfig({}).performance.budgets;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noSleep = async () => {};

const lhr = (scores: Record<string, number>) => ({
  lighthouseResult: {
    lighthouseVersion: "13.5.0",
    fetchTime: "2026-10-23T00:00:00.000Z",
    categories: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { score: v }])),
    audits: {
      "largest-contentful-paint": { title: "LCP", score: 0.5, numericValue: 3100, displayValue: "3.1 s" },
      "cumulative-layout-shift": { title: "CLS", score: 1, numericValue: 0.02, displayValue: "0.02" },
      "render-blocking-resources": { title: "Eliminate render-blocking resources", score: 0.3, displayValue: "Potential savings of 400 ms" },
    },
  },
});
const crux = (metrics: Record<string, string | number>) => ({
  record: {
    metrics: Object.fromEntries(Object.entries(metrics).map(([k, p75]) => [k, { percentiles: { p75 } }])),
    collectionPeriod: { firstDate: { year: 2026, month: 9, day: 1 }, lastDate: { year: 2026, month: 9, day: 28 } },
  },
});

const CSS = "@font-face{src:url('/f.woff2')} body{background:url(i.png)}";

describe("page weight budgets", () => {
  function site() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vage-weight-"));
    write(dir, "index.html", `<html><head><link rel="stylesheet" href="/a.css"><script src="/app.js"></script><script type="application/ld+json">{"@type":"Thing"}</script><script src="https://cdn.example/x.js"></script></head><body><img src="/i.png"><img src="/i.png"><img src="data:image/png;base64,AA"></body></html>`);
    write(dir, "a.css", CSS);
    write(dir, "app.js", "x".repeat(2048));
    write(dir, "f.woff2", "f".repeat(1000));
    write(dir, "i.png", "p".repeat(500));
    return dir;
  }

  it("counts local resources by kind, CSS-referenced fonts, and external requests", () => {
    const [w] = measurePages(site(), [{ route: "/", outFile: "index.html" }]);
    expect(w!.bytes).toMatchObject({ javascript: 2048, font: 1000, image: 500, css: Buffer.byteLength(CSS) });
    expect(w!.external).toEqual(["https://cdn.example/x.js"]);
    expect(w!.requests).toBe(6); // html, css, app.js, cdn js, i.png (deduped), font
    expect(w!.hasJavaScript).toBe(true);
  });

  it("reports pages over budget as warnings naming the config key", () => {
    const [w] = measurePages(site(), [{ route: "/", outFile: "index.html" }]);
    const findings = budgetFindings([w!], { ...budgets, javascriptKb: 1, requests: 5 });
    expect(findings.map((f) => f.message)).toEqual([
      "javascript is 2.0 KB, over the 1 KB budget (performance.budgets.javascriptKb).",
      "6 requests, over the budget of 5 (performance.budgets.requests).",
    ]);
    expect(findings.every((f) => f.severity === "warning")).toBe(true);
  });

  it("keeps default budgets for keys the config does not override", () => {
    expect(parseConfig({ performance: { budgets: { javascriptKb: 20 } } }).performance.budgets).toMatchObject({ javascriptKb: 20, cssKb: 50, performance: 90 });
  });

  it("does not treat JSON-LD as JavaScript", () => {
    const dir = site();
    write(dir, "index.html", '<html><head><script type="application/ld+json">{}</script></head></html>');
    expect(measurePages(dir, [{ route: "/", outFile: "index.html" }])[0]!.hasJavaScript).toBe(false);
  });
});

describe("accessibility (axe in jsdom)", () => {
  it("maps serious violations to errors with docs links", async () => {
    const result = await auditAccessibility("/", '<!doctype html><html><head><title>t</title></head><body><main><h1>x</h1><img src="a.png"></main></body></html>');
    expect(result.findings).toEqual([
      expect.objectContaining({ rule: "a11y:html-has-lang", severity: "error", docs: expect.stringContaining("dequeuniversity.com") }),
      expect.objectContaining({ rule: "a11y:image-alt", severity: "error" }),
    ]);
  });

  it("reports layout-dependent rules as needing review instead of passing them", async () => {
    const result = await auditAccessibility("/", '<html lang="en"><head><title>t</title></head><body><main><h1>x</h1><p style="color:#eee">low</p></main></body></html>');
    expect(result.findings).toEqual([]);
    expect(result.needsReview).toContain("color-contrast");
  });
});

describe("Core Web Vitals ratings", () => {
  it.each([
    ["lcp", 2500, "good"],
    ["lcp", 2501, "needs-improvement"],
    ["lcp", 4001, "poor"],
    ["inp", 200, "good"],
    ["inp", 201, "needs-improvement"],
    ["cls", 0.1, "good"],
    ["cls", 0.26, "poor"],
  ] as const)("%s %d -> %s", (metric, value, expected) => {
    expect(rate(metric, value)).toBe(expected);
  });
});

describe("PageSpeed Insights client", () => {
  it("sends the key as a header, never in the URL, and normalizes the result", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, lhr({ performance: 0.87, accessibility: 1, seo: 0.92, "best-practices": 1 })));
    const report = await pageSpeed("https://site.example/", "mobile", KEY, { fetch: fetch as typeof globalThis.fetch });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).not.toContain(KEY);
    expect(String(url)).toContain("strategy=MOBILE");
    expect(String(url)).toContain("category=BEST_PRACTICES");
    expect((init!.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(report).toMatchObject({
      source: "pagespeed-insights",
      toolVersion: "lighthouse 13.5.0",
      scores: { performance: 87, accessibility: 100, seo: 92, "best-practices": 100 },
      metrics: { lcpMs: 3100, cls: 0.02 },
      opportunities: [{ id: "render-blocking-resources" }, { id: "largest-contentful-paint" }],
    });
  });

  it("retries rate limits and server errors with backoff", async () => {
    const responses = [json(429, {}), json(503, {}), json(200, lhr({ performance: 1 }))];
    const sleep = vi.fn(noSleep);
    const report = await pageSpeed("https://site.example/", "desktop", undefined, { fetch: async () => responses.shift()!, sleep });
    expect(report.scores.performance).toBe(100);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it("gives up with an actionable message that never contains the key", async () => {
    const fetch = async () => json(403, { error: { message: `API key ${KEY} not valid.` } });
    const err = await pageSpeed("https://site.example/", "mobile", KEY, { fetch, sleep: noSleep }).catch((e) => e);
    expect(err.message).toBe("PageSpeed Insights returned HTTP 403: API key [redacted] not valid. Check the URL is public and the API key has this API enabled.");
  });

  it("redacts the key from network errors", async () => {
    const fetch = async () => {
      throw new Error(`connect failed for ${KEY}`);
    };
    const err = await pageSpeed("https://site.example/", "mobile", KEY, { fetch, sleep: noSleep }).catch((e) => e);
    expect(err.message).toMatch(/failed after 3 attempts: connect failed for \[redacted\]/);
    expect(redact(`a ${KEY} b ${KEY}`, [KEY])).toBe("a [redacted] b [redacted]");
  });

  it("rejects malformed responses", async () => {
    await expect(pageSpeed("https://site.example/", "mobile", undefined, { fetch: async () => json(200, { nope: true }) })).rejects.toThrow(/unexpected response/);
    await expect(
      pageSpeed("https://site.example/", "mobile", undefined, { fetch: async () => new Response("<html>", { status: 200 }) }),
    ).rejects.toThrow(/unexpected response/);
  });
});

describe("CrUX client", () => {
  it("falls back from URL to origin, parses string CLS and rates metrics", async () => {
    const bodies: unknown[] = [];
    const fetch = async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)));
      return bodies.length === 1 ? json(404, {}) : json(200, crux({ largest_contentful_paint: 2100, interaction_to_next_paint: 350, cumulative_layout_shift: "0.31" }));
    };
    const report = await cruxField("https://site.example/a/", "mobile", KEY, { fetch, sleep: noSleep });
    expect(bodies).toEqual([
      expect.objectContaining({ url: "https://site.example/a/", formFactor: "PHONE" }),
      expect.objectContaining({ origin: "https://site.example", formFactor: "PHONE" }),
    ]);
    expect(report).toEqual({
      source: "crux",
      scope: "origin",
      formFactor: "PHONE",
      collectionPeriod: "2026-09-01 to 2026-09-28",
      metrics: { lcp: { p75: 2100, rating: "good" }, inp: { p75: 350, rating: "needs-improvement" }, cls: { p75: 0.31, rating: "poor" } },
    });
  });

  it("returns undefined when neither the page nor the origin has data", async () => {
    expect(await cruxField("https://site.example/", "desktop", KEY, { fetch: async () => json(404, {}) })).toBeUndefined();
  });
});

describe("vage audit", () => {
  it("audits the local build: budgets, axe findings and review notes", async () => {
    const root = copyFixture();
    const result = await audit(root);
    expect(result.pages.map((p) => p.route)).toContain("/blog/post/");
    expect(result.findings).toContainEqual(expect.objectContaining({ rule: "a11y:html-has-lang", page: "/blog/", severity: "error", source: path.join("src", "pages", "blog", "index.md") }));
    expect(result.ok).toBe(false);
    expect(result.lab).toEqual([]);
    expect(result.notes.join("\n")).toMatch(/could not decide: color-contrast/);
    expect(fs.existsSync(path.join(root, "dist", "index.html"))).toBe(true);
  });

  it("audits a URL with lab and field data and compares scores to budgets", async () => {
    const fetch = async (url: string | URL | Request) =>
      String(url).includes("pagespeedonline")
        ? json(200, lhr({ performance: 0.8, accessibility: 1, seo: 1, "best-practices": 1 }))
        : json(200, crux({ largest_contentful_paint: 4500 }));
    const result = await audit(copyFixture(), {
      url: "https://site.example/",
      strategies: ["mobile"],
      env: { PAGESPEED_API_KEY: KEY, VAGE_CONFIG_DIR: tmpConfig() },
      remote: { fetch, sleep: noSleep },
    });
    expect(result.findings.map((f) => f.message)).toEqual([
      "performance 80 < budget 90 (mobile, pagespeed-insights, lab).",
      "LCP p75 is 4500ms (poor; good is ≤ 2500ms) for PHONE (url-level, real users).",
    ]);
    expect(result).toMatchObject({ ok: true, errors: 0, warnings: 2 });
    expect(result.notes.join(" ")).toMatch(/Field data \(CrUX\) reflects real Chrome users/);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("treats API outages as warnings unless --strict", async () => {
    const fetch = async (u: string | URL | Request) => json(String(u).includes("pagespeedonline") ? 503 : 404, {});
    const options = { url: "https://site.example/", strategies: ["mobile" as const], env: { PAGESPEED_API_KEY: KEY, VAGE_CONFIG_DIR: tmpConfig() }, remote: { fetch, sleep: noSleep } };
    const relaxed = await audit(copyFixture(), options);
    expect(relaxed).toMatchObject({ ok: true, errors: 0, warnings: 1 });
    expect(await audit(copyFixture(), { ...options, strict: true })).toMatchObject({ ok: false, errors: 1 });
  });

  it("uses only the user's own key: no keyless calls, asks when interactive", async () => {
    const fetch = vi.fn(async () => json(200, lhr({ performance: 1 })));
    const base = { url: "https://site.example/", strategies: ["mobile" as const], remote: { fetch, sleep: noSleep } };

    const none = await audit(copyFixture(), { ...base, env: { VAGE_CONFIG_DIR: tmpConfig() } });
    expect(none.findings[0]).toMatchObject({ rule: "pagespeed", severity: "error", message: expect.stringMatching(/needs your own API key. Set PAGESPEED_API_KEY, or save one with "vage connect pagespeed"/) });
    expect(none.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect(none.notes.join(" ")).toMatch(/No field data. Chrome UX Report \(CrUX\) API needs your own API key/);

    const askForKey = vi.fn(async (name: string) => (name === "pagespeed" ? KEY : undefined));
    const asked = await audit(copyFixture(), { ...base, env: { VAGE_CONFIG_DIR: tmpConfig() }, askForKey });
    expect(askForKey).toHaveBeenCalledWith("pagespeed");
    expect(asked.lab).toHaveLength(1);
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ "x-goog-api-key": KEY });
  });
});

describe("user API keys", () => {
  it("prefers the environment, then the saved key; stores privately outside the project", () => {
    const env = { VAGE_CONFIG_DIR: tmpConfig() };
    expect(resolveApiKey("pagespeed", env)).toBeUndefined();
    const file = saveApiKey("pagespeed", ` ${KEY} `, env);
    if (!WINDOWS) expect(fs.statSync(file).mode & 0o777).toBe(0o600); // Windows: private through the user profile's permissions
    expect(resolveApiKey("pagespeed", env)).toBe(KEY);
    expect(resolveApiKey("pagespeed", { ...env, PAGESPEED_API_KEY: "AIzaFROM-ENVIRONMENT-123456" })).toBe("AIzaFROM-ENVIRONMENT-123456");
    expect(resolveApiKey("crux", env)).toBeUndefined();
    expect(removeApiKey("pagespeed", env)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects values that are not API keys", () => {
    expect(() => saveApiKey("crux", "not a key", { VAGE_CONFIG_DIR: tmpConfig() })).toThrow(/doesn't look like a Google API key/);
  });

  it("explains how to install Lighthouse when it is missing", async () => {
    await expect(runLighthouse(copyFixture(), ["http://localhost/"], ["mobile"])).rejects.toThrow(/npm install --save-dev lighthouse/);
  });

  it.runIf(process.env.VAGE_TEST_LIGHTHOUSE === "1")(
    "runs a real Lighthouse audit (needs Chrome; VAGE_TEST_LIGHTHOUSE=1)",
    async () => {
      const root = copyFixture();
      fs.symlinkSync(path.join(import.meta.dirname, "..", "node_modules"), path.join(root, "node_modules"));
      const result = await audit(root, { lighthouse: true, strategies: ["mobile"] });
      expect(result.lab).toHaveLength(1);
      expect(result.lab[0]!.scores.performance).toBeGreaterThan(0);
      expect(result.lab[0]!.toolVersion).toMatch(/^lighthouse 13\./);
    },
    120_000,
  );
});
