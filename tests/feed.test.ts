import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { build } from "../src/core/build.js";
import { startDevServer } from "../src/dev/server.js";
import { copyFixture, write } from "./helpers.js";

const CONFIG = (extra = "") => `export default { site: "https://fixture.example", title: "Fixture Site", seo: { feeds: [{ under: "/blog/"${extra} }] } };`;
const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");

describe("RSS feeds", () => {
  it("writes /blog/feed.xml with the section's published posts, newest first", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG());
    write(root, "src/pages/blog/newer.md", "---\ntitle: Newer & better <post>\ndescription: The newest one.\ndatePublished: 2026-03-01\n---\n# Newer\n");
    write(root, "src/pages/blog/undated.md", "---\ntitle: Undated\ndescription: No date.\n---\n# Undated\n");
    await build(root);
    const xml = read(root, "blog/feed.xml");
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("<title>Newer &amp; better &lt;post&gt;</title>");
    expect(xml).toContain("<pubDate>Sun, 01 Mar 2026 00:00:00 GMT</pubDate>");
    expect(xml).toContain('<atom:link href="https://fixture.example/blog/feed.xml" rel="self"');
    const order = [...xml.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1]).slice(1);
    expect(order).toEqual(["https://fixture.example/blog/newer/", "https://fixture.example/blog/post/", "https://fixture.example/blog/undated/"]);
    expect(xml).not.toContain("/blog/wip/"); // draft
    expect(xml).not.toContain("<link>https://fixture.example/blog/</link>\n      <guid"); // the index itself isn't an item
  });

  it("links to the feed from pages in the section only", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG(', title: "Fixture blog"'));
    await build(root);
    expect(read(root, "blog/post/index.html")).toContain('<link rel="alternate" type="application/rss+xml" title="Fixture blog" href="https://fixture.example/blog/feed.xml" />');
    expect(read(root, "about/index.html")).not.toContain("application/rss+xml");
  });

  it("needs site, and validates the section path", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { title: "Fixture Site", seo: { feeds: [{ under: "/blog/" }] } };');
    const result = await build(root);
    expect(result.warnings.join()).toMatch(/feed for \/blog\/ needs "site"/);
    expect(fs.existsSync(path.join(root, "dist/blog/feed.xml"))).toBe(false);
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", seo: { feeds: [{ under: "blog" }] } };');
    await expect(build(root)).rejects.toThrow(/section path/);
  });
});

describe("feeds in the dev server", () => {
  let server: ViteDevServer | undefined;
  afterEach(async () => server?.close());
  it("serves the feed like the build", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG());
    server = await startDevServer(root, { port: 0 });
    const address = server.httpServer!.address() as { port: number };
    const res = await fetch(`http://localhost:${address.port}/blog/feed.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("rss");
    expect(await res.text()).toContain("/blog/post/");
  });
});
