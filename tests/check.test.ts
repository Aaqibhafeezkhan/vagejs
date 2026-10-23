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
