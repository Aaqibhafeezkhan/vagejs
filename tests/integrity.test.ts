import fs from "node:fs";
import path from "node:path";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { check } from "../src/checks/check.js";
import { externalHost, hiddenReason, readLinkLock, spamHits, writeLinkLock } from "../src/checks/integrity.js";
import { linkStatus, nextLock, parseHost } from "../src/checks/links.js";
import { sanitizeHtml } from "../src/content/sanitize.js";
import { copyFixture, write } from "./helpers.js";

const CONFIG = (extra = "") => `export default { site: "https://fixture.example", title: "Fixture Site"${extra} };`;
const rules = async (root: string) => (await check(root)).findings;

describe("inline styles in page content", () => {
  it("are removed by default, so content can't hide links", async () => {
    const out = await sanitizeHtml('<p>Hi<a href="https://spam.example" style="display:none">x</a><span style="position:absolute;left:-9999px">y</span></p>');
    expect(out).not.toContain("style=");
    expect(out).toContain('href="https://spam.example"');
  });

  it("are kept with markdown.inlineStyles", async () => {
    expect(await sanitizeHtml('<p style="color:red">Hi</p>', { inlineStyles: true })).toContain('style="color:red"');
  });
});

describe("hidden links", () => {
  const reason = (html: string) => hiddenReason(parse(html).querySelector("a")!)?.reason;
  it("detects the usual hiding tricks on the link or any ancestor", () => {
    expect(reason('<a href="x" style="display: none">x</a>')).toMatch(/display:none/);
    expect(reason('<div hidden><a href="x">x</a></div>')).toMatch(/hidden <div>/);
    expect(reason('<span style="position:absolute; left:-9999px"><a href="x">x</a></span>')).toMatch(/off-screen/);
    expect(reason('<p style="font-size:0"><a href="x">x</a></p>')).toMatch(/font-size:0/);
    expect(reason('<div style="height:0;overflow:hidden"><a href="x">x</a></div>')).toMatch(/zero size/);
    expect(reason('<a href="x" style="opacity:0">x</a>')).toMatch(/opacity/);
    expect(reason('<a href="x" style="text-indent:-5000px">x</a>')).toMatch(/off-screen/);
  });

  it("leaves visible links alone", () => {
    expect(reason('<a href="x" style="opacity:0.8; margin-left:-10px; font-size:0.9rem">x</a>')).toBeUndefined();
  });

  it("fails check for hidden external links, even when a layout adds them", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG(', security: { outboundLinks: "off" }'));
    write(root, "src/layouts/plain.ts", 'export default ({ content }) => `<html lang="en"><head><title>t</title></head><body><main>${content}</main><div style="display:none"><a href="https://casino.example/">best casino</a><a href="/about/">About</a></div></body></html>`;');
    const found = (await rules(root)).filter((f) => f.rule === "link-hidden");
    expect(found.find((f) => f.message.includes("casino.example"))?.severity).toBe("error");
    expect(found.find((f) => f.message.includes('"/about/"'))?.severity).toBe("warning");
  });
});

describe("outbound link guard", () => {
  function site() {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG());
    write(root, "src/pages/links.md", "---\ntitle: Links\ndescription: Links.\n---\n# Links\n\n[GitHub](https://github.com/x) and [npm](https://www.npmjs.com/package/x) and [home](https://fixture.example/about/)\n");
    return root;
  }

  it("normalizes hosts and ignores the site's own domain", () => {
    expect(externalHost("https://WWW.GitHub.com/a", "https://fixture.example")).toBe("github.com");
    expect(externalHost("https://www.fixture.example/x", "https://fixture.example")).toBeUndefined();
    expect(externalHost("/about/", "https://fixture.example")).toBeUndefined();
    expect(externalHost("mailto:a@b.c", "https://fixture.example")).toBeUndefined();
  });

  it("warns once when there is no links.lock.json yet", async () => {
    const found = (await rules(site())).filter((f) => f.rule.startsWith("link"));
    expect(found.map((f) => f.rule)).toEqual(["links-lock-missing"]);
  });

  it("fails on domains that aren't approved, naming the page", async () => {
    const root = site();
    writeLinkLock(root, ["github.com"]);
    const found = (await rules(root)).filter((f) => f.rule === "link-unapproved");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "error", page: "/links/", source: path.join("src", "pages", "links.md") });
    expect(found[0]!.message).toContain("npmjs.com");
  });

  it("passes once the owner approves, and can be turned off", async () => {
    const root = site();
    writeLinkLock(root, ["github.com", "npmjs.com"]);
    expect((await rules(root)).filter((f) => f.rule.startsWith("link-un"))).toEqual([]);
    write(root, "vage.config.ts", CONFIG(', security: { outboundLinks: "off" }'));
    fs.rmSync(path.join(root, "links.lock.json"));
    expect((await rules(root)).filter((f) => f.rule.startsWith("links"))).toEqual([]);
  });

  it("reports status and computes approvals, refusing things that aren't domains", async () => {
    const root = site();
    writeLinkLock(root, ["github.com", "old.example"]);
    const status = await linkStatus(root);
    expect(status.domains.map((d) => [d.domain, d.approved])).toEqual([["github.com", true], ["npmjs.com", false]]);
    expect(status.unused).toEqual(["old.example"]);
    expect(nextLock(status, ["github.com", "old.example"], ["npmjs.com"], true)).toEqual(["github.com", "npmjs.com"]);
    expect(() => nextLock(status, [], ["https://evil.example/x"], false)).toThrow(/not a domain/);
    expect(readLinkLock(root)?.domains).toEqual(["github.com", "old.example"]);
  });

  it("rejects a malformed lock file", async () => {
    const root = site();
    write(root, "links.lock.json", '{ "domains": "github.com" }');
    await expect(check(root)).rejects.toThrow(/must look like/);
  });
});

describe("spam vocabulary", () => {
  it("recognizes common injected-spam terms, not ordinary words", () => {
    expect(spamHits("Buy cheap viagra and visit our online casino")).toEqual(["casino", "pharmacy spam"]);
    expect(spamHits("We are betting on AI. Our pills of wisdom.")).toEqual([]);
  });

  it("warns in check, and can be turned off", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG(', security: { outboundLinks: "off" }'));
    write(root, "src/pages/promo.md", "---\ntitle: Promo\ndescription: Promo.\n---\n# Promo\n\nGet payday loans today.\n");
    expect((await rules(root)).find((f) => f.rule === "spam-pattern")?.message).toContain("payday loans");
    write(root, "vage.config.ts", CONFIG(', security: { outboundLinks: "off", spamPatterns: false }'));
    expect((await rules(root)).find((f) => f.rule === "spam-pattern")).toBeUndefined();
  });
});

describe("final-review regressions", () => {
  it("strips SVG xlink:href and legacy hiding tags from content", async () => {
    const out = await sanitizeHtml('<svg width="0" height="0"><a xlink:href="https://spam-svg.example/">cheap</a></svg><font color="white"><a href="https://a.example">x</a></font><marquee width="1">y</marquee>');
    expect(out).not.toContain("spam-svg.example");
    expect(out).not.toMatch(/<font|<marquee/);
  });

  it("puts canonical, og:url, meta refresh, iframes and forms through the link lock (layouts too)", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG());
    writeLinkLock(root, []);
    write(root, "src/pages/canon.md", "---\ntitle: Canon\ndescription: Canon.\ncanonical: https://spam-canon.example/landing/\n---\n# Canon\n");
    write(root, "src/layouts/plain.ts", 'export default ({ content }) => `<html lang="en"><head><title>t</title><meta http-equiv="refresh" content="5; url=https://spam-refresh.example/"></head><body><main>${content}</main><iframe src="https://spam-frame.example/" title="x"></iframe><svg><a xlink:href="https://spam-svg.example/"><text>x</text></a></svg></body></html>`;');
    const msgs = (await rules(root)).filter((f) => f.rule === "link-unapproved").map((f) => f.message).join("\n");
    for (const host of ["spam-canon.example", "spam-refresh.example", "spam-frame.example", "spam-svg.example"]) expect(msgs).toContain(host);
  });

  it('"require" makes a missing links.lock.json an error', async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG(', security: { outboundLinks: "require" }'));
    expect((await rules(root)).find((f) => f.rule === "links-lock-missing")?.severity).toBe("error");
  });

  it("rates hiding tricks: strong ones fail for external links, menu-style hiding only warns", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG(', security: { outboundLinks: "off" }'));
    write(
      root,
      "src/layouts/plain.ts",
      'export default ({ content }) => `<html lang="en"><head><title>t</title></head><body><main>${content}</main><nav hidden><a href="https://social.example/">Social</a></nav><details><summary>More</summary><a href="https://more.example/">More</a></details><span aria-hidden="true"><a href="https://aria.example/">a</a></span><svg width="0" height="0"><a href="https://zero.example/"><text>z</text></a></svg><a href="https://empty.example/"></a></body></html>`;',
    );
    const sev = Object.fromEntries((await rules(root)).filter((f) => f.rule === "link-hidden").map((f) => [/https:\/\/([a-z]+)\./.exec(f.message)![1], f.severity]));
    expect(sev).toEqual({ social: "warning", more: "warning", aria: "error", zero: "error", empty: "error" });
  });

  it("doesn't flag a <details> menu button around or inside a <nav>", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG(', security: { outboundLinks: "off" }'));
    write(
      root,
      "src/layouts/plain.ts",
      'export default ({ content }) => `<html lang="en"><head><title>t</title></head><body><header><details><summary>Menu</summary><nav><a href="https://inside.example/">In</a></nav></details><nav><details><summary>More</summary><a href="https://around.example/">Around</a></details></nav></header><main>${content}</main><details><summary>FAQ</summary><a href="https://plain.example/">Plain</a></details></body></html>`;',
    );
    const hidden = (await rules(root)).filter((f) => f.rule === "link-hidden").map((f) => /https:\/\/([a-z]+)\./.exec(f.message)![1]);
    expect([...new Set(hidden)]).toEqual(["plain"]);
  });

  it("doesn't flag links to the site's own pages in a closed <details>, but still flags outside ones", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", CONFIG(', security: { outboundLinks: "off" }'));
    write(
      root,
      "src/layouts/plain.ts",
      'export default ({ content }) => `<html lang="en"><head><title>t</title></head><body><main>${content}<details><summary>Is it free?</summary><p>Yes, see <a href="/about/">about</a> and <a href="https://fixture.example/about/">the same page</a>.</p><a href="https://spam.example/">x</a></details><div hidden><a href="/about/">hidden</a></div></main></body></html>`;',
    );
    const hidden = (await rules(root)).filter((f) => f.rule === "link-hidden").map((f) => f.message);
    expect(hidden.some((m) => m.includes("https://spam.example/"))).toBe(true);
    expect(hidden.some((m) => m.includes("closed <details>") && (m.includes('"/about/"') || m.includes("fixture.example")))).toBe(false);
    expect(hidden.some((m) => m.includes('"/about/"') && m.includes("hidden <div>"))).toBe(true); // other ways of hiding still count
  });

  it("accepts real hosts in any spelling and rejects URLs", () => {
    expect(parseHost("Bücher.DE.")).toBe("xn--bcher-kva.de");
    expect(parseHost("xn--e1afmkfd.xn--p1ai")).toBe("xn--e1afmkfd.xn--p1ai");
    expect(parseHost("192.0.2.1")).toBe("192.0.2.1");
    expect(parseHost("www.GitHub.com")).toBe("github.com");
    expect(() => parseHost("https://github.com/x")).toThrow(/not a domain/);
    expect(() => parseHost("localhost")).toThrow(/not a domain/);
  });

  it("doesn't flag ordinary phrases as spam", () => {
    for (const text of ["Book an online slot for your visit", "Watch Casino Royale tonight", "Escort services for oversize loads", "Super Bowl XXX recap", "Call 555-XXX-XXXX"]) {
      expect(spamHits(text), text).toEqual([]);
    }
    expect(spamHits("Claim your casino bonus and watch xxx videos")).toEqual(["casino", "adult content"]);
  });
});
