import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { build } from "../src/core/build.js";
import { fingerprint, verifySite } from "../src/checks/verify.js";
import { copyFixture } from "./helpers.js";

/** A fake live site that serves the real build output, with optional tampering. */
async function liveSite(tamper: (route: string, html: string) => string = (_, h) => h, extraSitemap = "") {
  const root = copyFixture();
  await build(root);
  const dist = path.join(root, "dist");
  const fetched: string[] = [];
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    fetched.push(url.pathname);
    const file = url.pathname.endsWith("/") ? path.join(dist, url.pathname, "index.html") : path.join(dist, url.pathname);
    if (!fs.existsSync(file)) return new Response("", { status: 404 });
    let body = fs.readFileSync(file, "utf8");
    if (url.pathname === "/sitemap.xml") body = body.replace("</urlset>", `${extraSitemap}</urlset>`);
    else body = tamper(url.pathname, body);
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
    const result = await verifySite(root, { fetch: down });
    expect(result.differences.every((d) => d.kind === "unreachable")).toBe(true);
    await expect(verifySite(root, { fetch: down, url: "not a url" })).rejects.toThrow(/--url/);
  });

  it("fingerprints links, scripts and text, not markup details", () => {
    const a = fingerprint('<body><p>Hi  there</p><a href="/x">x</a><script>var a=1</script></body>', "https://s.example/p/");
    const b = fingerprint('<body>\n<p>Hi there</p>\n<a  href="https://s.example/x">x</a><script>var a=1</script></body>', "https://s.example/p/");
    expect(a).toEqual(b);
  });
});
