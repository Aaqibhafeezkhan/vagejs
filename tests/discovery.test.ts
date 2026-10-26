import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/core/config.js";
import { build } from "../src/core/build.js";
import { llmsTxt } from "../src/discovery/llms.js";
import { robotsTxt } from "../src/discovery/robots.js";
import { sitemapXml } from "../src/discovery/sitemap.js";
import { copyFixture, write } from "./helpers.js";

const config = async (value: unknown) => parseConfig(value);
const robotsFor = async (value: Record<string, unknown>) => {
  const site = await config(value);
  return robotsTxt(site, site.seo.robots as Exclude<typeof site.seo.robots, false>);
};

describe("robots.txt", () => {
  it("defaults to allowing everything and links the sitemap", async () => {
    expect(await robotsFor({ site: "https://a.example" })).toBe("User-agent: *\nDisallow:\n\nSitemap: https://a.example/sitemap.xml\n");
  });

  it("omits the sitemap line without a site or with sitemap disabled", async () => {
    expect(await robotsFor({})).not.toContain("Sitemap:");
    expect(await robotsFor({ site: "https://a.example", seo: { sitemap: false } })).not.toContain("Sitemap:");
  });

  it("adds no AI-specific groups unless the owner opts in", async () => {
    const txt = await robotsFor({});
    for (const token of ["GPTBot", "ClaudeBot", "Google-Extended", "OAI-SearchBot"]) expect(txt).not.toContain(token);
  });

  it("keeps training and search crawler policies separate", async () => {
    const txt = await robotsFor({ seo: { robots: { aiTraining: "disallow", aiSearch: "allow" } } });
    expect(txt).toContain("User-agent: GPTBot\nDisallow: /");
    expect(txt).toContain("User-agent: ClaudeBot\nDisallow: /");
    expect(txt).toContain("User-agent: Google-Extended\nDisallow: /");
    expect(txt).toContain("User-agent: OAI-SearchBot\nAllow: /");
    expect(txt).toContain("User-agent: Claude-SearchBot\nAllow: /");
  });

  it("writes explicit rules in order and does not add a second * group", async () => {
    const txt = await robotsFor({
      seo: { robots: { rules: [{ userAgent: ["*", "Bingbot"], allow: ["/public/"], disallow: ["/admin/"] }] } },
    });
    expect(txt).toBe("User-agent: *\nUser-agent: Bingbot\nAllow: /public/\nDisallow: /admin/\n");
  });

  it("errors when a token is configured twice", async () => {
    await expect(robotsFor({ seo: { robots: { aiTraining: "allow", rules: [{ userAgent: "gptbot", disallow: ["/"] }] } } })).rejects.toThrow(
      /"GPTBot" is set both/,
    );
  });
});

describe("sitemap.xml and llms.txt formats", () => {
  it("escapes URLs and only writes lastmod when known", () => {
    const xml = sitemapXml([{ url: "https://a.example/?a=1&b=2" }, { url: "https://a.example/x/", lastmod: "2026-01-01" }]);
    expect(xml).toContain("<loc>https://a.example/?a=1&amp;b=2</loc>\n  </url>");
    expect(xml).toContain("<lastmod>2026-01-01</lastmod>");
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
  });

  it("follows the llms.txt layout", () => {
    expect(llmsTxt("Site", "Desc", [{ title: "A", url: "https://a.example/", description: "About A", body: "" }])).toBe(
      "# Site\n\n> Desc\n\n## Pages\n\n- [A](https://a.example/): About A\n",
    );
  });
});

describe("discovery files in the build", () => {
  async function built() {
    const root = copyFixture();
    const result = await build(root);
    const read = (f: string) => fs.readFileSync(path.join(root, "dist", f), "utf8");
    return { root, result, read };
  }

  it("lists only published, indexable, self-canonical pages", async () => {
    const { result, read } = await built();
    expect(result.files).toEqual(["robots.txt", "sitemap.xml", "llms.txt", "llms-full.txt"]);
    const locs = [...read("sitemap.xml").matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      "https://fixture.example/",
      "https://fixture.example/about/",
      "https://fixture.example/blog/",
      "https://fixture.example/blog/post/",
    ]);
    // Excluded: draft (wip), noindex (hidden), canonicalized elsewhere (about-copy), redirect (old), 404.
    for (const file of ["sitemap.xml", "llms.txt", "llms-full.txt"]) {
      for (const excluded of ["/blog/wip/", "/hidden/", "/about-copy/", "/old/", "404"]) expect(read(file)).not.toContain(excluded);
    }
    expect(read("sitemap.xml")).toContain("<lastmod>2026-02-01</lastmod>");
    expect(read("llms.txt")).toContain("- [About](https://fixture.example/about/): About the fixture.");
    expect(read("llms-full.txt")).toContain("Source: https://fixture.example/blog/post/\n\n# Post");
  });

  it("writes robots.txt from config", async () => {
    const { read } = await built();
    expect(read("robots.txt")).toContain("User-agent: *\nDisallow: /private/");
    expect(read("robots.txt")).toContain("User-agent: ClaudeBot\nDisallow: /");
    expect(read("robots.txt")).toContain("Sitemap: https://fixture.example/sitemap.xml");
  });

  it("writes redirects as noindex pages pointing at the target", async () => {
    const { result, read } = await built();
    expect(result.redirects).toEqual([{ from: "/old/", to: "/about/", output: "old/index.html" }]);
    const html = read("old/index.html");
    expect(html).toContain('<meta http-equiv="refresh" content="0; url=/about/" />');
    expect(html).toContain('<link rel="canonical" href="https://fixture.example/about/" />');
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it("skips files that are turned off and warns about a missing site", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { title: "T", seo: { robots: false, llmsTxt: false } };');
    const result = await build(root);
    expect(result.files).toEqual([]);
    expect(result.warnings[0]).toMatch(/"site" is not set/);
  });

  it("refuses to overwrite a hand-written public file", async () => {
    const root = copyFixture();
    write(root, "public/robots.txt", "User-agent: *\nDisallow: /\n");
    await expect(build(root)).rejects.toThrow(/public\/robots\.txt conflicts with the generated robots\.txt/);
  });

  it("rejects a redirect that shadows a page", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { redirects: { "/about": "/" } };');
    await expect(build(root)).rejects.toThrow(/Redirect source "\/about" is also a page route/);
  });
});

describe("config validation", () => {
  it("normalizes site, keeping a subfolder path without the final slash", async () => {
    expect((await config({ site: "https://a.example/" })).site).toBe("https://a.example");
    expect((await config({ site: "https://a.example/docs/" })).site).toBe("https://a.example/docs");
    await expect(config({ site: "https://a.example/a b/" })).rejects.toThrow(/subfolder path/);
  });

  it("accepts true/false/object for toggles", async () => {
    expect((await config({ seo: { llmsTxt: true } })).seo.llmsTxt).toEqual({ full: false });
    expect((await config({ seo: { llmsTxt: false } })).seo.llmsTxt).toBe(false);
    await expect(config({ seo: { llmsTxt: { fulll: true } } })).rejects.toThrow(/fulll/);
  });
});
