import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { check } from "../src/checks/check.js";
import { parseConfig } from "../src/core/config.js";
import { resolveMenus } from "../src/core/menus.js";
import type { PageSummary } from "../src/core/pages.js";
import { copyFixture, write } from "./helpers.js";

const menus = {
  main: [
    { label: "Home", href: "/" },
    { label: "Docs", href: "/docs/" },
    { label: "Install", href: "/docs/install/#npm" },
    { label: "GitHub", href: "https://github.com/example/site" },
  ],
  footer: [
    { label: "Learn", items: [{ label: "Guides", href: "/docs/guides/" }, { label: "Email", href: "mailto:hi@example.com" }] },
    { label: "Blog", href: "/blog/", items: [{ label: "Feed", href: "/blog/feed.xml" }] },
  ],
};

describe("menus", () => {
  it("marks the current page and its section", () => {
    const site = parseConfig({ menus });
    const docs = resolveMenus(site, "/docs/guides/", []);
    expect(docs.main!.map((i) => [i.label, i.current, i.active, i.external])).toEqual([
      ["Home", false, false, false],
      ["Docs", false, true, false],
      ["Install", false, false, false],
      ["GitHub", false, false, true],
    ]);
    const [learn, blog] = docs.footer!;
    expect(learn).toMatchObject({ label: "Learn", current: false, active: true });
    expect(learn!.href).toBeUndefined();
    expect(learn!.items.map((i) => [i.label, i.current, i.external])).toEqual([
      ["Guides", true, false],
      ["Email", false, true],
    ]);
    expect(blog).toMatchObject({ href: "/blog/", active: false, items: [{ label: "Feed", active: false }] });

    const home = resolveMenus(site, "/", []);
    expect(home.main!.map((i) => i.current)).toEqual([true, false, false, false]);
    expect(home.main!.map((i) => i.active)).toEqual([true, false, false, false]);
    expect(resolveMenus(site, "/docs/install/", []).main![2]).toMatchObject({ current: true, active: true });
  });

  it('follows trailingSlash: "never"', () => {
    const site = parseConfig({ trailingSlash: "never", menus });
    const main = resolveMenus(site, "/docs", []).main!;
    expect(main.map((i) => i.href)).toEqual(["/", "/docs", "/docs/install#npm", "https://github.com/example/site"]);
    expect(main[1]).toMatchObject({ current: true, active: true });
  });

  it("rejects bad entries", () => {
    expect(() => parseConfig({ menus: { main: [{ label: "X", href: "//evil.example" }] } })).toThrow(/single "\/"/);
    expect(() => parseConfig({ menus: { main: [{ label: "X", href: "javascript:alert(1)" }] } })).toThrow(/menus/);
    expect(() => parseConfig({ menus: { main: [{ label: "X" }] } })).toThrow(/needs an href, a page or items/);
    expect(() => parseConfig({ menus: { main: [{ label: "X", items: [{ label: "Y", items: [{ label: "Z", href: "/" }] }] }] } })).toThrow(/menus/);
    expect(() => parseConfig({ menus: { main: [{ href: "/" }] } })).toThrow(/needs a label/);
    expect(() => parseConfig({ menus: { main: [{ label: "X", href: "/", page: "/" }] } })).toThrow(/href or page, not both/);
    expect(() => parseConfig({ menus: { main: [{ page: "/docs/#install" }] } })).toThrow(/page address/);
    expect(() => parseConfig({ menus: { "main menu": [] } })).toThrow(/menu name "main menu" must start with a letter/);
    expect(parseConfig({}).menus).toEqual({});
  });

  it("reach layouts as props.menus", async () => {
    const root = copyFixture();
    const config = fs.readFileSync(path.join(root, "vage.config.ts"), "utf8");
    write(root, "vage.config.ts", config.replace('lang: "en-GB",', 'lang: "en-GB",\n  menus: { main: [{ label: "About", href: "/about/" }, { label: "Home", href: "/" }] },'));
    write(
      root,
      "src/layouts/plain.ts",
      `export default ({ content, page, menus }) => \`<!doctype html><html><head><title>\${page.title}</title></head><body>
<nav>\${menus.main.map((i) => \`<a href="\${i.href}"\${i.current ? ' aria-current="page"' : ""}>\${i.label}</a>\`).join("")}</nav>
\${content}</body></html>\`;`,
    );
    write(root, "src/pages/about.md", "---\ntitle: About\ndescription: About the fixture.\nlayout: plain\n---\n# About\n");
    await build(root);
    const html = fs.readFileSync(path.join(root, "dist/about/index.html"), "utf8");
    expect(html).toContain('<nav><a href="/about/" aria-current="page">About</a><a href="/">Home</a></nav>');
  });

  it("page entries take the page's address and label", () => {
    const pricing = { route: "/pricing", title: "Pricing and plans", label: "Pricing", source: "src/pages/pricing.md", frontmatter: { title: "Pricing and plans" } } as PageSummary;
    const site = parseConfig({ trailingSlash: "never", menus: { main: [{ page: "/pricing/" }, { page: "/pricing", label: "Plans" }, { page: "/gone/" }] } });
    const main = resolveMenus(site, "/pricing", [pricing]).main!;
    expect(main.map((i) => [i.label, i.href, i.current])).toEqual([
      ["Pricing", "/pricing", true],
      ["Plans", "/pricing", true],
      ["/gone/", "/gone", false],
    ]);
  });

  /** The fixture with the given menus in its config. */
  function withMenus(menus: string): string {
    const root = copyFixture();
    const config = fs.readFileSync(path.join(root, "vage.config.ts"), "utf8");
    write(root, "vage.config.ts", config.replace('lang: "en-GB",', `lang: "en-GB",\n  menus: ${menus},`));
    return root;
  }

  it("fail the build when a page entry isn't published", async () => {
    const root = withMenus('{ main: [{ page: "/about/" }], footer: [{ label: "More", items: [{ page: "/hidden/" }, { page: "/nope/" }] }] }');
    await expect(build(root)).rejects.toThrow(/menus\.footer\[0\]\.items\[1\]: page "\/nope\/" isn't a published page/);
  });

  it("are checked by vage check, even when no layout shows them", async () => {
    const root = withMenus('{ main: [{ page: "/about/" }, { label: "Old", href: "/old-page/#x" }, { label: "Feed", href: "/robots.txt" }, { label: "Ext", href: "https://example.org/" }], footer: [{ page: "/nope/" }] }');
    const result = await check(root);
    const menu = result.findings.filter((f) => f.rule === "menu-link").map((f) => f.message);
    expect(menu).toEqual([
      'menus.main[1]: "/old-page/#x" isn\'t a page or file on this site.',
      'menus.footer[0]: page "/nope/" isn\'t a published page in src/pages (moved, deleted, a draft or scheduled?).',
    ]);
  });
});
