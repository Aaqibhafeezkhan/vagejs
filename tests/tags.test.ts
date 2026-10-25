import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { collection, tagList, type PageSummary } from "../src/core/pages.js";
import { copyFixture, write } from "./helpers.js";

const page = (route: string, title: string, tags?: string[], datePublished?: string): PageSummary => ({
  route,
  title,
  label: title,
  source: `src/pages${route}index.md`,
  frontmatter: { title, draft: false, noindex: false, type: "website", ...(tags ? { tags } : {}), ...(datePublished ? { datePublished } : {}) },
});

describe("tags", () => {
  const pages = [page("/a/", "Alpha", ["SEO", "AI"]), page("/b/", "Bravo", ["seo", "seo"]), page("/c/", "Charlie", ["Web Design"]), page("/d/", "Delta")];

  it("lists tags A to Z, merging spellings that make the same address", () => {
    expect(tagList(pages)).toEqual([
      { name: "AI", slug: "ai", route: "/tags/ai/", count: 1 },
      { name: "SEO", slug: "seo", route: "/tags/seo/", count: 2 },
      { name: "Web Design", slug: "web-design", route: "/tags/web-design/", count: 1 },
    ]);
  });

  it("rejects tags without a letter or digit", async () => {
    const root = copyFixture();
    write(root, "src/pages/about.md", '---\ntitle: About\ndescription: About us.\ntags: ["!!!"]\n---\n# About\n');
    await expect(build(root)).rejects.toThrow(/each tag needs a letter or digit/);
  });

  it("picks pages by tag in collection()", () => {
    expect(collection(pages, { tag: "Seo" }).map((p) => p.title)).toEqual(["Alpha", "Bravo"]);
    expect(collection(pages, { tag: "web design" }).map((p) => p.title)).toEqual(["Charlie"]);
    expect(() => collection(pages, { tag: "!!" })).toThrow(/tag/);
  });

  it("builds a page for each tag, newest first, with escaped names", async () => {
    const root = copyFixture();
    write(root, "src/pages/blog/one.md", '---\ntitle: One\ndescription: First.\ndatePublished: 2026-01-01\ntags: [SEO, "<b>Bold</b>"]\n---\n# One\n');
    write(root, "src/pages/blog/two.md", "---\ntitle: Two\ndescription: Second.\ndatePublished: 2026-02-01\ntags: [seo]\n---\n# Two\n");
    const result = await build(root);
    expect(result.pages.filter((p) => p.route.startsWith("/tags/"))).toEqual([
      { route: "/tags/b-bold-b/", source: '(tag "<b>Bold</b>")', output: "tags/b-bold-b/index.html" },
      { route: "/tags/seo/", source: '(tag "SEO")', output: "tags/seo/index.html" },
    ]);
    const html = fs.readFileSync(path.join(root, "dist", "tags", "seo", "index.html"), "utf8");
    expect(html).toContain("<title>Tagged: SEO | Fixture Site</title>");
    expect(html.indexOf('href="/blog/two/"')).toBeLessThan(html.indexOf('href="/blog/one/"'));
    expect(fs.readFileSync(path.join(root, "dist", "tags", "b-bold-b", "index.html"), "utf8")).toContain("Tagged: &lt;b&gt;Bold&lt;/b&gt;");
    expect(fs.readFileSync(path.join(root, "dist", "sitemap.xml"), "utf8")).toContain("https://fixture.example/tags/seo/");
    expect((await check(root)).findings.filter((f) => f.page?.startsWith("/tags/"))).toEqual([]);
  });

  it("can be turned off, and refuses to replace a page at the same address", async () => {
    const root = copyFixture();
    write(root, "src/pages/blog/one.md", "---\ntitle: One\ndescription: First.\ntags: [SEO]\n---\n# One\n");
    write(root, "src/pages/tags/seo.md", "---\ntitle: SEO\ndescription: Mine.\ndraft: true\n---\n# SEO\n");
    expect((await build(root)).pages.map((p) => p.route)).toContain("/tags/seo/"); // a draft there doesn't clash
    write(root, "src/pages/tags/seo.md", "---\ntitle: SEO\ndescription: Mine.\n---\n# SEO\n");
    await expect(build(root)).rejects.toThrow(/tags\/seo\.md and the tag "SEO" both make \/tags\/seo\//);
    const clash = (await check(root)).findings.find((f) => f.rule === "page-error");
    expect(clash?.message).toMatch(/both make \/tags\/seo\//);
    const config = path.join(root, "vage.config.ts");
    fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace('redirects: {', "tags: { pages: false },\n  redirects: {"));
    expect((await build(root)).pages.map((p) => p.route)).toContain("/tags/seo/");
  });
});
