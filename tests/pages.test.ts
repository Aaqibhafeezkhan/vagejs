import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { collection, type PageSummary } from "../src/core/pages.js";
import { copyFixture, write } from "./helpers.js";

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");

const page = (route: string, title: string, datePublished?: string): PageSummary => ({
  route,
  title,
  source: `src/pages${route}index.md`,
  frontmatter: { title, draft: false, noindex: false, type: "website", ...(datePublished ? { datePublished } : {}) },
});

describe("collection()", () => {
  const pages = [
    page("/", "Home"),
    page("/blog/", "Blog"),
    page("/blog/b/", "Bravo", "2026-02-01"),
    page("/blog/a/", "Alpha", "2026-03-01"),
    page("/blog/c/", "Charlie"),
    page("/blog/archive/old/", "Old", "2025-01-01"),
    page("/blogroll/", "Blogroll"),
  ];

  it("picks a section without its index page, and never matches a sibling prefix", () => {
    expect(collection(pages, { under: "/blog/" }).map((p) => p.route)).toEqual(["/blog/a/", "/blog/archive/old/", "/blog/b/", "/blog/c/"]);
    expect(collection(pages, { under: "/blog", includeIndex: true }).map((p) => p.route)).toContain("/blog/");
  });

  it("sorts newest first by date, undated last", () => {
    expect(collection(pages, { under: "/blog/", sort: "date" }).map((p) => p.title)).toEqual(["Alpha", "Bravo", "Old", "Charlie"]);
  });

  it("sorts by title, by a custom function, and limits", () => {
    expect(collection(pages, { under: "/blog/", sort: "title", limit: 2 }).map((p) => p.title)).toEqual(["Alpha", "Bravo"]);
    expect(collection(pages, { sort: (a, b) => b.route.localeCompare(a.route), limit: 1 })[0]!.route).toBe("/blogroll/");
  });

  it("rejects options that would silently return the wrong pages (review finding)", () => {
    expect(() => collection(pages, { under: "blog" })).toThrow(/starting with "\/"/);
    expect(() => collection(pages, { sort: "datePublished" as "date" })).toThrow(/"sort" must be/);
    expect(() => collection(pages, { limit: -1 })).toThrow(/limit/);
    expect(() => collection(pages, { includeIndex: "yes" as unknown as boolean })).toThrow(/includeIndex/);
    expect(() => collection(undefined as unknown as [], {})).toThrow(/pages/);
  });

  it("does not modify the list it is given", () => {
    const before = pages.map((p) => p.route);
    collection(pages, { sort: "title" });
    expect(pages.map((p) => p.route)).toEqual(before);
  });
});

describe("props.pages", () => {
  it("gives layouts every published page (drafts excluded) so they can build lists", async () => {
    const root = copyFixture();
    write(
      root,
      "src/layouts/list.ts",
      // Temp projects can't resolve the "vagejs" package, so import the sources directly.
      `import { collection } from ${JSON.stringify(path.resolve("src/core/pages.ts"))};
import { escapeHtml } from ${JSON.stringify(path.resolve("src/core/html.ts"))};
export default ({ content, page, pages }) => \`<!doctype html><html lang="en"><head><title>\${escapeHtml(page.title)}</title></head><body>\${content}<ul id="all">\${pages.map((p) => \`<li>\${escapeHtml(p.route)}</li>\`).join("")}</ul><ul id="blog">\${collection(pages, { under: "/blog/" }).map((p) => \`<li>\${escapeHtml(p.title)}</li>\`).join("")}</ul></body></html>\`;`,
    );
    const index = path.join(root, "src/pages/blog/index.md");
    fs.writeFileSync(index, fs.readFileSync(index, "utf8").replace("layout: plain", "layout: list"));
    await build(root);
    const html = read(root, "blog/index.html");
    const all = /<ul id="all">(.*?)<\/ul>/.exec(html)![1]!;
    expect(all).toContain("<li>/blog/post/</li>");
    expect(all).not.toContain("wip"); // draft
    expect(all).not.toContain("404");
    expect(/<ul id="blog">(.*?)<\/ul>/.exec(html)![1]).not.toContain("<li>Blog</li>"); // the index itself
  });
});
