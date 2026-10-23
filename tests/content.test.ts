import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../src/content/markdown.js";
import { loadConfig } from "../src/core/config.js";
import { escapeHtml } from "../src/core/html.js";
import { defaultLayout } from "../src/core/render.js";
import { FIXTURE } from "./helpers.js";

describe("parseMarkdown", () => {
  it("parses frontmatter and renders the body", () => {
    const page = parseMarkdown("---\ntitle: Hi\nauthor: Me\n---\n# Heading\n\n*em*\n", "x.md");
    expect(page.frontmatter).toEqual({ title: "Hi", author: "Me", draft: false });
    expect(page.html).toContain("<h1>Heading</h1>");
    expect(page.html).toContain("<em>em</em>");
  });

  it("requires a title", () => {
    expect(() => parseMarkdown("# No frontmatter\n", "x.md")).toThrow(/Invalid frontmatter[\s\S]*title[\s\S]*at x\.md/);
  });

  it("reports invalid YAML with the file path", () => {
    expect(() => parseMarkdown("---\ntitle: [unclosed\n---\n", "bad.md")).toThrow(/Invalid YAML frontmatter[\s\S]*bad\.md/);
  });

  it("rejects layout names with path characters", () => {
    expect(() => parseMarkdown("---\ntitle: T\nlayout: ../evil\n---\n", "x.md")).toThrow(/layout/);
  });
});

describe("loadConfig", () => {
  const loaderFor = (value: unknown) => async () => ({ default: value });

  it("applies defaults when there is no config file", async () => {
    expect(await loadConfig("/nonexistent", loaderFor(undefined))).toEqual({ lang: "en" });
  });

  it("rejects unknown keys and non-http URLs", async () => {
    await expect(loadConfig(FIXTURE, loaderFor({ sitemap: true }))).rejects.toThrow(/Invalid config[\s\S]*sitemap/);
    await expect(loadConfig(FIXTURE, loaderFor({ site: "ftp://x.com" }))).rejects.toThrow(/Invalid config[\s\S]*site/);
  });
});

describe("html", () => {
  it("escapes HTML special characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("default layout escapes metadata and keeps content as HTML", async () => {
    const html = await defaultLayout({
      content: "<p>body</p>",
      page: { route: "/", title: "A <b>", description: 'say "hi"', frontmatter: { title: "A <b>", draft: false } },
      site: { title: "Site", lang: "fr" },
    });
    expect(html).toContain('<html lang="fr">');
    expect(html).toContain("<title>A &lt;b&gt; | Site</title>");
    expect(html).toContain('content="say &quot;hi&quot;"');
    expect(html).toContain("<p>body</p>");
  });
});
