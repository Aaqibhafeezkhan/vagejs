import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../src/checks/check.js";
import { build } from "../src/core/build.js";
import { parseConfig } from "../src/core/config.js";
import { collection, type PageSummary } from "../src/core/pages.js";
import { copyFixture, write } from "./helpers.js";

const CONFIG = `export default {
  site: "https://fixture.example",
  title: "Fixture Site",
  lang: "en",
  i18n: { locales: ["fr", "de"] },
  seo: { feeds: [{ under: "/fr/blog/" }] },
};
`;

/** The fixture in English, French (same addresses) and German (a translated address, with translationOf). */
function i18nSite(): string {
  const root = copyFixture();
  write(root, "vage.config.ts", CONFIG);
  fs.rmSync(path.join(root, "src/pages/about-copy.md"));
  write(root, "src/pages/fr/index.md", "---\ntitle: Accueil\ndescription: La page d'accueil.\n---\n# Accueil\n");
  write(root, "src/pages/fr/about.md", "---\ntitle: À propos\ndescription: Qui nous sommes.\n---\n# À propos\n");
  write(root, "src/pages/de/ueber-uns.md", "---\ntitle: Über uns\ndescription: Wer wir sind.\ntranslationOf: /about/\n---\n# Über uns\n");
  write(root, "src/pages/fr/blog/index.md", "---\ntitle: Blog FR\ndescription: Les articles.\n---\n# Blog\n");
  write(root, "src/pages/fr/blog/premier.md", "---\ntitle: Premier\ndescription: Le premier article.\ndatePublished: 2026-01-01\n---\n# Premier\n");
  return root;
}

const read = (root: string, rel: string) => fs.readFileSync(path.join(root, "dist", rel), "utf8");

describe("multi-language sites (i18n)", () => {
  it("validates the locales", () => {
    expect(() => parseConfig({ lang: "en", i18n: { locales: ["en", "fr"] } })).toThrow(/main language/);
    expect(() => parseConfig({ i18n: { locales: ["fr", "fr"] } })).toThrow(/repeat/);
    expect(() => parseConfig({ i18n: { locales: ["French"] } })).toThrow(/language code/);
    expect(parseConfig({ i18n: { locales: ["pt-BR"] } }).i18n?.locales).toEqual(["pt-BR"]);
  });

  it("sets <html lang> per page and links translations with hreflang", async () => {
    const root = i18nSite();
    await build(root);
    const about = read(root, "about/index.html");
    expect(about).toContain('<html lang="en">');
    expect(about).toContain('<link rel="alternate" hreflang="en" href="https://fixture.example/about/" />');
    expect(about).toContain('<link rel="alternate" hreflang="fr" href="https://fixture.example/fr/about/" />');
    expect(about).toContain('<link rel="alternate" hreflang="de" href="https://fixture.example/de/ueber-uns/" />');
    expect(about).toContain('<link rel="alternate" hreflang="x-default" href="https://fixture.example/about/" />');
    const fr = read(root, "fr/about/index.html");
    expect(fr).toContain('<html lang="fr">');
    expect(fr).toContain('hreflang="de" href="https://fixture.example/de/ueber-uns/"');
    expect(read(root, "de/ueber-uns/index.html")).toContain('hreflang="fr" href="https://fixture.example/fr/about/"');
    // A page with no translation gets no hreflang links.
    expect(read(root, "blog/post/index.html")).not.toContain("hreflang");
    expect(read(root, "fr/blog/feed.xml")).toContain("<language>fr</language>");
  });

  it("leaves sites without i18n unchanged", async () => {
    const root = copyFixture();
    await build(root);
    expect(read(root, "about/index.html")).toContain('<html lang="en-GB">');
    expect(read(root, "about/index.html")).not.toContain("hreflang");
  });

  it("gives layouts page.lang and page.translations", async () => {
    const root = i18nSite();
    write(
      root,
      "src/layouts/default.ts",
      "export default ({ content, page }) => `<!doctype html><html lang=\"${page.lang}\"><head><title>${page.title}</title></head><body><nav>${page.translations.map((t) => `${t.lang}:${t.route}:${t.current}`).join(\" \")}</nav><main>${content}</main></body></html>`;\n",
    );
    await build(root);
    expect(read(root, "fr/about/index.html")).toContain("<nav>en:/about/:false fr:/fr/about/:true de:/de/ueber-uns/:false</nav>");
    expect(read(root, "blog/post/index.html")).toContain("<nav>en:/blog/post/:true</nav>");
  });

  it("checks translations", async () => {
    const root = i18nSite();
    write(root, "src/pages/de/kontakt.md", "---\ntitle: Kontakt\ndescription: Schreiben Sie uns.\ntranslationOf: /contact/\n---\n# Kontakt\n");
    write(root, "src/pages/fr/a-propos.md", "---\ntitle: À propos 2\ndescription: Encore nous.\ntranslationOf: /about/\n---\n# À propos\n");
    write(root, "src/pages/hidden.md", "---\ntitle: Hidden\ndescription: Not listed.\nnoindex: true\ntranslationOf: /about/\n---\n# Hidden\n");
    const result = await check(root);
    const by = (rule: string) => result.findings.filter((f) => f.rule === rule).map((f) => `${f.source}: ${f.message}`);
    expect(by("translation")).toEqual([
      expect.stringMatching(/^src\/pages\/de\/kontakt\.md: translationOf: \/contact\/ is not a published page/),
      expect.stringContaining('src/pages/fr/about.md: src/pages/fr/about.md and src/pages/fr/a-propos.md are both the "fr" version of /about/.'),
      expect.stringMatching(/^src\/pages\/hidden\.md: translationOf is only for pages in a language folder/),
    ]);
    const missing = by("translation-missing");
    expect(missing).toContainEqual(expect.stringContaining("src/pages/blog/post.md: No fr, de version of this page. Add src/pages/fr/blog/post.md, src/pages/de/blog/post.md"));
    expect(missing.some((m) => m.startsWith("src/pages/about.md"))).toBe(false);
    expect(missing.some((m) => m.startsWith("src/pages/hidden.md"))).toBe(false);
  });

  it("flags a layout whose <html lang> ignores the page's language", async () => {
    const root = i18nSite();
    write(root, "src/layouts/default.ts", "export default ({ content, page, site }) => `<!doctype html><html lang=\"${site.lang}\"><head><title>${page.title}</title></head><body><main>${content}</main></body></html>`;\n");
    const result = await check(root);
    // The fixture's blog uses a layout without any lang, which is the existing "no lang" error.
    const langErrors = result.findings.filter((f) => f.rule === "html-lang" && f.message.includes("doesn't match"));
    expect(langErrors.map((f) => f.page).sort()).toEqual(["/de/ueber-uns/", "/fr/", "/fr/about/", "/fr/blog/", "/fr/blog/premier/"]);
    expect(langErrors[0]!.message).toContain("page.lang");
  });

  it("filters collection() by language", () => {
    const p = (route: string, lang: string): PageSummary => ({ route, lang, title: route, label: route, source: "", frontmatter: { title: route, draft: false, noindex: false, type: "website" } });
    const pages = [p("/blog/a/", "en"), p("/fr/blog/b/", "fr")];
    expect(collection(pages, { lang: "fr" }).map((x) => x.route)).toEqual(["/fr/blog/b/"]);
    expect(() => collection(pages, { lang: "" })).toThrow(/lang/);
  });
});
