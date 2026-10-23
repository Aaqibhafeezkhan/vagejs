import fs from "node:fs";
import path from "node:path";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { parseConfig } from "../src/core/config.js";
import { parseMarkdown } from "../src/content/markdown.js";
import { headTags, injectHead, pageMeta } from "../src/seo/head.js";
import { jsonLdScript, breadcrumbList } from "../src/seo/jsonld.js";
import { copyFixture } from "./helpers.js";

const config = async (value: unknown) => parseConfig(value);
const fm = (yaml: string) => parseMarkdown(`---\n${yaml}\n---\n`, "x.md").frontmatter;
const LAYOUT = "<html><head>\n  <title>t</title>\n  </head><body></body></html>";

async function render(siteValue: unknown, yaml: string, route = "/page/", notFound = false, layout = LAYOUT) {
  const site = await config(siteValue);
  return injectHead(layout, headTags(site, pageMeta(site, route, fm(yaml), notFound)), "x.md");
}

describe("head tags", () => {
  it("adds canonical and Open Graph tags from real data only", async () => {
    const html = await render({ site: "https://a.example", title: "Site" }, "title: Page\ndescription: Desc");
    expect(html).toContain('<link rel="canonical" href="https://a.example/page/" />');
    expect(html).toContain('<meta property="og:url" content="https://a.example/page/" />');
    expect(html).toContain('<meta property="og:site_name" content="Site" />');
    expect(html).toContain('<meta name="description" content="Desc" />');
    expect(html).not.toContain("og:image");
    expect(html).not.toContain("ld+json"); // not the home page, not an article
  });

  it("omits canonical and og:url without a site", async () => {
    const html = await render({}, "title: Page");
    expect(html).not.toContain("canonical");
    expect(html).not.toContain("og:url");
    expect(html).not.toContain('name="description"');
  });

  it("marks noindex and 404 pages and gives them no canonical or JSON-LD", async () => {
    for (const html of [
      await render({ site: "https://a.example" }, "title: P\nnoindex: true\ntype: article"),
      await render({ site: "https://a.example" }, "title: P", "/404/", true),
    ]) {
      expect(html).toContain('<meta name="robots" content="noindex" />');
      expect(html).not.toContain("canonical");
      expect(html).not.toContain("ld+json");
    }
  });

  it("supports canonical overrides and absolute image URLs", async () => {
    const html = await render({ site: "https://a.example" }, "title: P\ncanonical: /other/\nimage: /og.png");
    expect(html).toContain('href="https://a.example/other/"');
    expect(html).toContain('<meta property="og:image" content="https://a.example/og.png" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it("does not duplicate tags the layout already writes", async () => {
    const layout = '<html><head><meta name="description" content="mine"><link rel="canonical" href="https://x.example/"></head></html>';
    const html = await render({ site: "https://a.example" }, "title: P\ndescription: Desc", "/page/", false, layout);
    expect(html.match(/name="description"/g)).toHaveLength(1);
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('content="mine"');
  });

  it("requires </head> in layout output", async () => {
    await expect(render({}, "title: P", "/", false, "<p>no head</p>")).rejects.toThrow(/no <\/head>/);
  });

  it("escapes attribute values", async () => {
    expect(await render({}, 'title: P\ndescription: \'"><script>\'')).toContain('content="&quot;&gt;&lt;script&gt;"');
  });
});

describe("JSON-LD", () => {
  it("escapes < so content cannot close the script tag", () => {
    const tag = jsonLdScript({ "@type": "Thing", name: "</script><script>alert(1)</script>" });
    expect(tag.match(/<\/script>/g)).toHaveLength(1);
    expect(JSON.parse(tag.replace(/^<script[^>]*>|<\/script>$/g, "")).name).toBe("</script><script>alert(1)</script>");
  });

  it("builds BreadcrumbList positions", () => {
    expect(breadcrumbList([{ name: "Home", url: "https://a.example/" }, { name: "Blog", url: "https://a.example/blog/" }])).toMatchObject({
      itemListElement: [{ position: 1, name: "Home" }, { position: 2, name: "Blog" }],
    });
  });

  it("emits WebSite + Organization on the home page and Article from frontmatter", async () => {
    const root = copyFixture();
    await build(root);
    const ld = (file: string) =>
      JSON.parse(parse(fs.readFileSync(path.join(root, "dist", file), "utf8")).querySelector('script[type="application/ld+json"]')!.rawText);

    expect(ld("index.html")).toEqual({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Fixture Site", url: "https://fixture.example/" },
        { "@type": "Organization", name: "Fixture Org", logo: "https://fixture.example/images/logo.png" },
      ],
    });
    expect(ld("blog/post/index.html")).toEqual({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "Post",
      description: "A fixture post.",
      image: "https://fixture.example/images/logo.png",
      datePublished: "2026-01-15",
      dateModified: "2026-02-01",
      mainEntityOfPage: "https://fixture.example/blog/post/",
      author: { "@type": "Person", name: "Test Author" },
    });
  });

  it("rejects malformed dates", () => {
    expect(() => fm("title: P\ndatePublished: last tuesday")).toThrow(/ISO date/);
  });
});
