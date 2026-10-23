import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { parseConfig } from "../src/core/config.js";
import { headersFile } from "../src/deploy/headers.js";
import { copyFixture, write } from "./helpers.js";

const sha = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const cf = (extra = "") => {
  const root = copyFixture();
  write(root, "vage.config.ts", `export default { site: "https://fixture.example", title: "F", deploy: { target: "cloudflare-pages", cloudflareProject: "f" }${extra} };`);
  write(root, "src/layouts/plain.ts", 'export default ({ content }: { content: string }) => `<html lang="en"><head><title>t</title><style>main{color:red}</style><script>window.x=1</script><script src="https://cdn.example/lib.js"></script><link rel="stylesheet" href="https://fonts.example/css"></head><body><main>${content}</main><iframe src="https://video.example/embed/1" title="v"></iframe></body></html>`;');
  return root;
};
const csp = (headers: string) => headers.split("\n").find((l) => l.includes("Content-Security-Policy"))!;

describe("security headers (_headers)", () => {
  it("writes baseline headers and a CSP built from the actual pages", async () => {
    const root = cf();
    await build(root);
    const headers = fs.readFileSync(path.join(root, "dist", "_headers"), "utf8");
    expect(headers).toContain("/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: SAMEORIGIN");
    const policy = csp(headers);
    expect(policy).toContain(`script-src 'self' ${sha("window.x=1")} https://cdn.example`);
    expect(policy).toContain(`style-src 'self' ${sha("main{color:red}")} https://fonts.example`);
    expect(policy).toContain("frame-src https://video.example");
    expect(policy).toMatch(/object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'/);
    // JSON-LD is data: never hashed into script-src.
    const ld = fs.readFileSync(path.join(root, "dist", "index.html"), "utf8").match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!;
    expect(policy).not.toContain(sha(ld));
  });

  it("adds documented analytics domains and the Plausible snippet origin", () => {
    const site = parseConfig({
      integrations: {
        ga4: { measurementId: "G-TEST123" },
        clarity: { snippet: "<script>/*c*/</script>" },
        plausible: { snippet: '<script defer src="https://stats.example/js/pa-1.js"></script>' },
      },
      security: { cspSources: { "connect-src": ["https://api.example"] } },
    });
    const policy = csp(headersFile(["<html><head></head></html>"], site));
    expect(policy).toMatch(/script-src 'self' https:\/\/www\.googletagmanager\.com https:\/\/\*\.clarity\.ms https:\/\/c\.bing\.com https:\/\/stats\.example/);
    expect(policy).toMatch(/connect-src 'self' https:\/\/www\.googletagmanager\.com https:\/\/\*\.google-analytics\.com https:\/\/\*\.google\.com .*https:\/\/stats\.example https:\/\/api\.example/);
  });

  it("supports report-only and off, and only writes _headers for Cloudflare Pages", async () => {
    expect(headersFile([], parseConfig({ security: { csp: "report-only" } }))).toContain("Content-Security-Policy-Report-Only: default-src 'self'");
    expect(headersFile([], parseConfig({ security: { csp: "off" } }))).not.toContain("Content-Security-Policy");

    const off = cf(", security: { headers: false }");
    expect((await build(off)).files).not.toContain("_headers");
    const gh = copyFixture();
    expect((await build(gh)).files).not.toContain("_headers");
  });

  it("rejects unsafe extra sources and over-long policies", () => {
    expect(() => parseConfig({ security: { cspSources: { "script-src": ["https://x.example; script-src *"] } } })).toThrow(/must be a source/);
    const many = Array.from({ length: 60 }, (_, i) => `<script>var a${i}=${i}</script>`).join("");
    expect(() => headersFile([`<html><head>${many}</head></html>`], parseConfig({}))).toThrow(/limited to 2000/);
  });

  it("warns about inline event handlers that the CSP will block", async () => {
    const root = cf();
    write(root, "src/layouts/default.ts", 'export default ({ content }: { content: string }) => `<html lang="en"><head><title>t</title></head><body onload="init()"><main>${content}</main></body></html>`;');
    expect((await check(root)).findings).toContainEqual(expect.objectContaining({ rule: "csp-inline-handler", severity: "warning" }));
  });
});
