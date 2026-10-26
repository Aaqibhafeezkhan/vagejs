import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewServer } from "vite";
import { build } from "../src/core/build.js";
import { check } from "../src/checks/check.js";
import { basePath, cssWithBase, withBase } from "../src/core/base.js";
import { parseConfig } from "../src/core/config.js";
import { startPreviewServer } from "../src/dev/preview.js";
import { absoluteUrl } from "../src/seo/urls.js";
import { copyFixture, write } from "./helpers.js";

/** The basic fixture as a GitHub Pages project site at https://fixture.github.io/repo. */
function subfolderFixture(): string {
  const root = copyFixture();
  const config = fs.readFileSync(path.join(root, "vage.config.ts"), "utf8");
  write(root, "vage.config.ts", config.replace('site: "https://fixture.example",', 'site: "https://fixture.github.io/repo/",'));
  write(root, "public/styles.css", '@font-face { src: url("/fonts/a.woff2"); } body { background: url(/images/logo.png); }\n');
  write(root, "src/pages/about.md", "---\ntitle: About\ndescription: About the fixture.\n---\n# About\n\n[Post](/blog/post/) [Own](https://fixture.github.io/repo/blog/post/) ![Logo](/images/logo.png)\n\n```html\n<a href=\"/code/\">\n```\n");
  return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");

describe("site in a subfolder", () => {
  it("keeps the path in site and builds absolute URLs inside it", () => {
    expect(parseConfig({ site: "https://owner.github.io/repo/" }).site).toBe("https://owner.github.io/repo");
    expect(parseConfig({ site: "https://example.com/" }).site).toBe("https://example.com");
    expect(basePath("https://owner.github.io/repo")).toBe("/repo");
    expect(basePath("https://example.com")).toBe("");
    expect(absoluteUrl("https://owner.github.io/repo", "/about/")).toBe("https://owner.github.io/repo/about/");
    expect(absoluteUrl("https://example.com", "/about/")).toBe("https://example.com/about/");
    expect(() => parseConfig({ site: "https://owner.github.io/repo?x=1" })).toThrow(/query/);
    expect(() => parseConfig({ site: "https://owner.github.io/repo", deploy: { target: "cloudflare-workers" } })).toThrow(/github-pages target/);
    expect(() => parseConfig({ site: "https://owner.github.io/repo", contact: { to: "a@b.example", from: "c@d.example" } })).toThrow(/root of a domain/);
  });

  it("adds the subfolder to root-relative URLs in tags only", () => {
    const html = '<a href="/a/">A</a><img alt="x > y" src="/i.png" srcset="/i-1.webp 480w, /i-2.webp 960w"><a href="//cdn.example/x">c</a><a href="https://x.example/">x</a><a href="rel/">r</a><a href=/bare/>b</a><pre><code>&lt;a href="/code/"&gt;</code></pre><script>fetch("/api")</script><script src="/s.js"></script><!-- <a href="/c"> --><meta http-equiv="refresh" content="0; url=/new/"><style>a{background:url(/bg.png)}</style>';
    expect(withBase(html, "/repo")).toBe(
      '<a href="/repo/a/">A</a><img alt="x > y" src="/repo/i.png" srcset="/repo/i-1.webp 480w, /repo/i-2.webp 960w"><a href="//cdn.example/x">c</a><a href="https://x.example/">x</a><a href="rel/">r</a><a href=/repo/bare/>b</a><pre><code>&lt;a href="/code/"&gt;</code></pre><script>fetch("/api")</script><script src="/repo/s.js"></script><!-- <a href="/c"> --><meta http-equiv="refresh" content="0; url=/repo/new/"><style>a{background:url(/repo/bg.png)}</style>',
    );
    expect(withBase(html, "")).toBe(html);
    expect(cssWithBase("a{src:url('/f.woff2')} b{x:url(//cdn/c)}", "/repo")).toBe("a{src:url('/repo/f.woff2')} b{x:url(//cdn/c)}");
    expect(cssWithBase(`@import "/i.css"; a{b:url("/a b.png")} c{d:url( /x.png )} e{f:url(data:x)}`, "/repo")).toBe(`@import "/repo/i.css"; a{b:url("/repo/a b.png")} c{d:url( /repo/x.png )} e{f:url(data:x)}`);
    expect(withBase(`<textarea><a href="/t"></textarea><meta http-equiv="refresh" content="0;URL='/x/'"><div style="background:url(&quot;/bg.png&quot;)"></div><a HREF = "/up/">u</a>`, "/repo")).toBe(
      `<textarea><a href="/t"></textarea><meta http-equiv="refresh" content="0;URL='/repo/x/'"><div style="background:url(&quot;/repo/bg.png&quot;)"></div><a HREF = "/repo/up/">u</a>`,
    );
  });

  it("builds pages, files and stylesheets with the subfolder", async () => {
    const root = subfolderFixture();
    await build(root);
    const about = read(root, "about/index.html");
    expect(about).toContain('href="/repo/blog/post/"');
    expect(about).toContain('src="/repo/images/logo.png"');
    expect(about).toContain('href="https://fixture.github.io/repo/blog/post/"');
    expect(about).toContain(`&lt;a href="/code/"&gt;`);
    expect(about).toContain('<link rel="canonical" href="https://fixture.github.io/repo/about/" />');
    expect(read(root, "sitemap.xml")).toContain("<loc>https://fixture.github.io/repo/about/</loc>");
    expect(read(root, "robots.txt")).toContain("Sitemap: https://fixture.github.io/repo/sitemap.xml");
    expect(read(root, "old/index.html")).toContain('content="0; url=/repo/about/"');
    expect(read(root, "old/index.html")).toContain('<link rel="canonical" href="https://fixture.github.io/repo/about/" />');
    expect(read(root, "styles.css")).toBe('@font-face { src: url("/repo/fonts/a.woff2"); } body { background: url(/repo/images/logo.png); }\n');
  });

  it("checks links as the site sees them, including absolute links into the subfolder", async () => {
    const root = subfolderFixture();
    const findings = (await check(root)).findings.filter((f) => f.page === "/about/");
    expect(findings.filter((f) => f.rule.startsWith("link-"))).toEqual([]);
  });
});

describe("preview of a site in a subfolder", () => {
  let servers: PreviewServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });

  it("serves the site under the subfolder", async () => {
    const root = subfolderFixture();
    await build(root);
    const server = await startPreviewServer(root, {});
    servers.push(server);
    const url = server.resolvedUrls!.local[0]!.replace(/\/$/, "");
    const get = (p: string) => fetch(`${url}${p}`, { redirect: "manual" });
    expect((await get("/")).headers.get("location")).toBe("/repo/");
    expect((await get("/repo?x=1")).headers.get("location")).toBe("/repo/?x=1");
    expect((await get("/repo/about/")).status).toBe(200);
    expect((await get("/repo/styles.css")).status).toBe(200);
    expect((await get("/repo/about")).headers.get("location")).toBe("/repo/about/");
    expect((await get("/about/")).status).toBe(404);
  });
});
