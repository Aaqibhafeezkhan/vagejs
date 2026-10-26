import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreviewServer, ViteDevServer } from "vite";
import { build } from "../src/core/build.js";
import { check } from "../src/checks/check.js";
import { outFileFor, publicPath, routeKey } from "../src/core/routes.js";
import { startDevServer } from "../src/dev/server.js";
import { startPreviewServer } from "../src/dev/preview.js";
import { tagList, type PageSummary } from "../src/core/pages.js";
import { copyFixture, write } from "./helpers.js";

/** The basic fixture with trailingSlash "never", links written without the slash, and a layout that prints what it sees. */
function neverFixture(): string {
  const root = copyFixture();
  const config = fs.readFileSync(path.join(root, "vage.config.ts"), "utf8");
  write(root, "vage.config.ts", config.replace('lang: "en-GB",', 'lang: "en-GB",\n  trailingSlash: "never",').replace('redirects: { "/old": "/about/" }', 'redirects: { "/old": "/about" }'));
  write(root, "src/pages/about.md", "---\ntitle: About\ndescription: About the fixture.\ntags: [News]\n---\n# About\n\n[Post](/blog/post) [Relative](blog/post)\n");
  write(
    root,
    "src/layouts/probe.ts",
    `import { breadcrumbs, collection, tagList } from ${JSON.stringify(path.resolve("src/core/pages.ts"))};
export default ({ content, page, pages }) => \`<!doctype html><html><head><title>\${page.title}</title></head><body>
<p id="route">\${page.route}</p>
<p id="blog">\${collection(pages, { under: "/blog/" }).map((p) => p.route).join(",")}</p>
<p id="trail">\${breadcrumbs(pages, page.route).map((p) => p.route).join(",")}</p>
<p id="tags">\${tagList(pages).map((t) => t.route).join(",")}</p>
\${content}</body></html>\`;`,
  );
  write(root, "src/pages/blog/post.md", "---\ntitle: Post\ndescription: A post.\nlayout: probe\n---\n# Post\n");
  return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");

describe("route helpers", () => {
  it("convert route keys to public paths and output files", () => {
    expect(publicPath("/about/", "never")).toBe("/about");
    expect(publicPath("/", "never")).toBe("/");
    expect(publicPath("/about/", "always")).toBe("/about/");
    expect(routeKey("/about")).toBe("/about/");
    expect(routeKey("/")).toBe("/");
    expect(outFileFor("/blog/post/", "never")).toBe("blog/post.html");
    expect(outFileFor("/blog/post/", "always")).toBe("blog/post/index.html");
    expect(outFileFor("/", "never")).toBe("index.html");
  });
});

describe('trailingSlash: "never"', () => {
  it("writes about.html and uses addresses without the slash everywhere", async () => {
    const root = neverFixture();
    const result = await build(root);
    expect(result.pages.map((p) => p.output)).toEqual(["index.html", "about-copy.html", "about.html", "blog.html", "blog/post.html", "hidden.html", "tags/news.html"]);
    expect(read(root, "about.html")).toContain('<link rel="canonical" href="https://fixture.example/about" />');
    expect(read(root, "about.html")).toContain('content="https://fixture.example/about"');
    const sitemap = read(root, "sitemap.xml");
    expect(sitemap).toContain("<loc>https://fixture.example/about</loc>");
    expect(sitemap).toContain("<loc>https://fixture.example/</loc>");
    expect(sitemap).not.toMatch(/fixture\.example\/[a-z][^<]*\/<\/loc>/);
    expect(read(root, "llms.txt")).toContain("https://fixture.example/about)");
    expect(read(root, "old.html")).toContain('content="0; url=/about"');
    expect(fs.existsSync(path.join(root, "dist", "about"))).toBe(false);
  });

  it("gives layouts routes without the slash, and the list helpers still match them", async () => {
    const root = neverFixture();
    await build(root);
    const post = read(root, "blog/post.html");
    expect(post).toContain('<p id="route">/blog/post</p>');
    expect(post).toContain('<p id="blog">/blog/post</p>');
    expect(post).toContain('<p id="trail">/,/blog,/blog/post</p>');
    expect(post).toContain('<p id="tags">/tags/news</p>');
  });

  it("accepts links without the slash and flags the slashed form", async () => {
    const root = neverFixture();
    const clean = (await check(root)).findings.filter((f) => f.rule.startsWith("link-") && f.page === "/about/");
    expect(clean).toEqual([]);

    write(root, "src/pages/about.md", "---\ntitle: About\ndescription: About the fixture.\n---\n# About\n\n[Post](/blog/post/) [Gone](/nope)\n");
    const messages = (await check(root)).findings.filter((f) => f.page === "/about/").map((f) => `${f.rule}: ${f.message}`);
    expect(messages).toContain('link-trailing-slash: Link to "/blog/post/" redirects; use "/blog/post" (this site uses trailingSlash: "never").');
    expect(messages).toContain('link-broken: Link to "/nope" does not match any page or file.');
  });

  it("finds pages with a dot in their name", async () => {
    const root = neverFixture();
    write(root, "src/pages/v1.2.md", "---\ntitle: Version 1.2\ndescription: Notes.\n---\n# 1.2\n");
    write(root, "src/pages/about.md", "---\ntitle: About\ndescription: About the fixture.\n---\n# About\n\n[1.2](/v1.2)\n");
    const findings = (await check(root)).findings.filter((f) => f.severity === "error" && (f.page === "/about/" || f.page === "/v1.2/"));
    expect(findings).toEqual([]);
  });

  it("feeds link to the section without the slash, and tag addresses follow the setting", async () => {
    const root = neverFixture();
    const config = fs.readFileSync(path.join(root, "vage.config.ts"), "utf8");
    write(root, "vage.config.ts", config.replace("seo: {", 'seo: {\n    feeds: [{ under: "/blog/" }],'));
    await build(root);
    expect(read(root, "blog/feed.xml")).toContain("<link>https://fixture.example/blog</link>");
    const home = { route: "/", label: "Home", title: "Home", source: "src/pages/index.md", frontmatter: { title: "Home", tags: ["News"] } } as PageSummary;
    expect(tagList([home], "never").map((t) => t.route)).toEqual(["/tags/news"]);
    expect(tagList([home]).map((t) => t.route)).toEqual(["/tags/news/"]);
  });
});

describe('servers with trailingSlash: "never"', () => {
  let servers: (ViteDevServer | PreviewServer)[] = [];
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });
  const baseUrl = (s: ViteDevServer | PreviewServer) => s.resolvedUrls!.local[0]!.replace(/\/$/, "");
  const get = (url: string) => fetch(url, { redirect: "manual" });

  it("dev serves /about and redirects /about/ to it", async () => {
    const server = await startDevServer(neverFixture(), {});
    servers.push(server);
    const url = baseUrl(server);
    expect((await get(`${url}/about`)).status).toBe(200);
    const redirect = await get(`${url}/about/?x=1`);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("/about?x=1");
  });

  it("preview serves about.html at /about and redirects /about/", async () => {
    const root = neverFixture();
    await build(root);
    const server = await startPreviewServer(root, {});
    servers.push(server);
    const url = baseUrl(server);
    const page = await get(`${url}/blog/post`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<h1>Post</h1>");
    expect((await get(`${url}/blog/post/`)).headers.get("location")).toBe("/blog/post");
    expect((await get(`${url}/nope`)).status).toBe(404);
  });

  it("preview serves pages with a dot in their name", async () => {
    const root = neverFixture();
    write(root, "src/pages/v1.2.md", "---\ntitle: Version 1.2\ndescription: Notes.\n---\n# 1.2\n");
    await build(root);
    const server = await startPreviewServer(root, {});
    servers.push(server);
    expect((await get(`${baseUrl(server)}/v1.2`)).status).toBe(200);
  });
});

describe("vercel.json and trailingSlash: \"never\"", () => {
  it("requires cleanUrls, so Vercel serves about.html at /about", async () => {
    const root = neverFixture();
    write(root, "vercel.json", "{}\n");
    const findings = (await check(root)).findings.filter((f) => f.source === "vercel.json");
    expect(findings.map((f) => f.severity)).toEqual(["error"]);
    write(root, "vercel.json", '{ "cleanUrls": true }\n');
    expect((await check(root)).findings.filter((f) => f.source === "vercel.json")).toEqual([]);
  });
});
