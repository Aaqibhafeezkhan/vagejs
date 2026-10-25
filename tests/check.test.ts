import { describe, expect, it } from "vitest";
import { check, type Finding } from "../src/checks/check.js";
import { copyFixture, write } from "./helpers.js";

const rules = (findings: Finding[]) => findings.map((f) => `${f.severity}:${f.rule}:${f.page ?? f.source ?? "site"}`);

describe("vage check", () => {
  it("reports exactly the known problems in the fixture", async () => {
    const result = await check(copyFixture());
    // The fixture's "plain" layout omits <html lang>, on purpose. Drafts are not checked.
    expect(rules(result.findings)).toEqual(["error:html-lang:/blog/"]);
    expect(result).toMatchObject({ ok: false, errors: 1, warnings: 0, pagesChecked: 7 });
  });

  it("finds broken links, draft links, missing assets, alt text and redirecting links", async () => {
    const root = copyFixture();
    write(
      root,
      "src/pages/index.md",
      `---\ntitle: Home\ndescription: Home page.\n---\n# Home\n\n[a](/nope/) [b](/blog/wip/) [c](/about) [d](https://fixture.example/about/) [e](https://elsewhere.example/) [f](/old/) [g](mailto:x@y.z) [h](/images/logo.png)\n\n<img src="/missing.png" alt="x" width="1" height="1"><img src="/images/logo.png" width="1" height="1"><a href="/about/"></a>\n`,
    );
    const messages = (await check(root)).findings.filter((f) => f.page === "/").map((f) => `${f.rule}: ${f.message}`);
    expect(messages).toEqual([
      'img-alt: <img src="/images/logo.png"> has no alt attribute (use alt="" for decorative images).',
      'link-broken: Link to "/nope/" does not match any page or file.',
      'link-broken: Link to "/blog/wip/" points to a draft page, which is not published.',
      'link-trailing-slash: Link to "/about" redirects; use "/about/".',
      'link-text: Link to "/about/" has no accessible text.',
      'asset-missing: <img src="/missing.png"> does not exist in the build output.',
    ]);
  });

  it("warns when rendered titles and meta descriptions may be shortened", async () => {
    const root = copyFixture();
    const longTitle = "T".repeat(61);
    const longDescription = "D".repeat(161);
    write(root, "src/pages/index.md", `---
title: ${longTitle}
description: ${longDescription}
---
# Home
`);

    const findings = (await check(root)).findings.filter((f) => f.page === "/");
    const titleWarning = findings.find((f) => f.rule === "title-length");
    const descriptionWarning = findings.find((f) => f.rule === "meta-description-length");

    expect(titleWarning).toMatchObject({ severity: "warning", source: "src/pages/index.md" });
    expect(titleWarning?.message).toContain("src/pages/index.md");
    // The layout adds the site name, so the rendered title is longer than the frontmatter one.
    expect(Number(/is (\d+) characters/.exec(titleWarning?.message ?? "")?.[1])).toBeGreaterThan(61);
    expect(titleWarning?.message).toContain("may be shortened in search results");
    expect(descriptionWarning).toMatchObject({ severity: "warning", source: "src/pages/index.md" });
    expect(descriptionWarning?.message).toContain("src/pages/index.md");
    expect(descriptionWarning?.message).toContain("161 characters");
    expect(descriptionWarning?.message).toContain("may be shortened in search results");
  });

  it("skips length warnings on pages kept out of search", async () => {
    const root = copyFixture();
    write(root, "src/pages/index.md", `---
title: ${"T".repeat(61)}
description: ${"D".repeat(161)}
noindex: true
---
# Home
`);

    const rules = (await check(root)).findings.filter((f) => f.page === "/").map((f) => f.rule);
    expect(rules).not.toContain("title-length");
    expect(rules).not.toContain("meta-description-length");
  });

  it("validates JSON-LD written by layouts", async () => {
    const root = copyFixture();
    write(
      root,
      "src/layouts/plain.ts",
      `export default ({ content }: { content: string }) => \`<html lang="en"><head><title>t</title><script type="application/ld+json">{bad json</script><script type="application/ld+json">{"@type":"Thing"}</script></head><body>\${content}</body></html>\`;`,
    );
    const messages = (await check(root)).findings.filter((f) => f.page === "/blog/").map((f) => f.message);
    expect(messages).toEqual([expect.stringMatching(/not valid JSON/), expect.stringMatching(/"@context"/)]);
  });

  it("warns about duplicates, missing descriptions, placeholder sites and blanket robots blocks", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://example.com", title: "T", seo: { robots: { rules: [{ userAgent: "*", disallow: ["/"] }] } } };');
    write(root, "src/pages/about.md", "---\ntitle: Home\n---\n# About\n");
    const result = await check(root);
    expect(rules(result.findings)).toEqual(
      expect.arrayContaining([
        "warning:config:site",
        "warning:meta-description:/about/",
        "warning:title-duplicate:site",
        "warning:robots-blocks-all:robots.txt",
      ]),
    );
  });

  it("passes when there are only warnings, and fails in strict mode", async () => {
    const root = copyFixture();
    write(root, "src/layouts/plain.ts", 'export default ({ content }: { content: string }) => `<html lang="en"><head><title>t</title></head><body>${content}</body></html>`;');
    expect((await check(root)).ok).toBe(true);
    write(root, "src/pages/extra.md", "---\ntitle: Extra\n---\nNo heading or description.\n");
    const relaxed = await check(root);
    expect(relaxed).toMatchObject({ ok: true, errors: 0 });
    expect(relaxed.warnings).toBeGreaterThan(0);
    expect((await check(root, { strict: true })).ok).toBe(false);
  });
});

describe("redirect targets (review finding)", () => {
  it("flags redirects to pages that don't exist, and accepts real targets", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", redirects: { "/gone/": "/nowhere/", "/old/": "/about/", "/ext/": "https://example.org/x" } };');
    const result = await check(root);
    const hits = result.findings.filter((f) => f.rule === "redirect-target");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain('"/gone/" points to "/nowhere/"');
  });
});
