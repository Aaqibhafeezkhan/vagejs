import { describe, expect, it } from "vitest";
import { CRAWLERS, checkCrawlability as check, probeUserAgent, robotsBlocks, xRobotsNoindex } from "../src/checks/crawlability.js";

const checkCrawlability = async (origin: string, o: Parameters<typeof check>[1]) => (await check(origin, o)).differences;

type Handler = (url: URL, ua: string, init?: RequestInit) => Response;
const fake = (handler: Handler) =>
  (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), String((init?.headers as Record<string, string> | undefined)?.["user-agent"] ?? ""), init)) as typeof fetch;

/** A well-configured site: https only, one host, everyone allowed. */
const healthy: Handler = (url) => {
  if (url.protocol === "http:") return new Response("", { status: 301, headers: { location: `https://${url.host}/` } });
  if (url.hostname.startsWith("www.")) return new Response("", { status: 301, headers: { location: "https://example.org/" } });
  if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow:\n");
  return new Response("<html><head><title>Home</title></head><body>Hi</body></html>");
};

describe("crawlability", () => {
  it("knows each crawler's documented user agent or token", () => {
    const g = CRAWLERS.find((c) => c.token === "Googlebot")!;
    expect(probeUserAgent(g)).toContain("Googlebot/2.1");
    expect(probeUserAgent(g)).not.toContain("W.X.Y.Z");
    expect(probeUserAgent(CRAWLERS.find((c) => c.token === "ClaudeBot")!)).toContain("ClaudeBot/");
    expect(CRAWLERS.map((c) => c.token)).toEqual(expect.arrayContaining(["Googlebot", "bingbot", "GPTBot", "OAI-SearchBot", "ClaudeBot", "Claude-SearchBot", "PerplexityBot"]));
  });

  it("passes a healthy site", async () => {
    expect(await checkCrawlability("https://example.org", { fetch: fake(healthy) })).toEqual([]);
  });

  it("reports CDN blocks and challenges as warnings (a local probe can't prove a real crawler is blocked)", async () => {
    const found = await checkCrawlability("https://example.org", {
      fetch: fake((url, ua, init) => {
        if (/GPTBot/.test(ua)) return new Response("blocked", { status: 403, headers: { "cf-mitigated": "challenge" } });
        if (/bingbot/.test(ua)) return new Response("<title>Just a moment...</title>");
        return healthy(url, ua, init);
      }),
    });
    const by = Object.fromEntries(found.map((d) => [d.detail.split(" ")[0], d.severity]));
    expect(by).toEqual({ GPTBot: "warning", bingbot: "warning" });
  });

  it("reads robots.txt groups, noindex headers, and missing redirects", async () => {
    expect(robotsBlocks("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n", "GPTBot")).toBe(true);
    expect(robotsBlocks("User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n", "Googlebot")).toBe(false);
    expect(robotsBlocks("User-agent: *\nDisallow: /\n", "bingbot")).toBe(true);
    expect(robotsBlocks("User-agent: Googlebot\nAllow: /\n\nUser-agent: *\nDisallow: /\n", "Googlebot")).toBe(false);

    const found = await checkCrawlability("https://example.org", {
      fetch: fake((url, ua, init) => {
        if (url.pathname === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n");
        if (url.protocol === "http:" || url.hostname.startsWith("www.")) return new Response("<html></html>");
        const res = healthy(url, ua, init);
        return new Response(res.body, { headers: { "x-robots-tag": "noindex" } });
      }),
    });
    const kinds = found.map((d) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(["robots-blocked", "noindex-header", "redirect-missing", "duplicate-host"]));
    expect(found.find((d) => d.detail.startsWith("robots.txt disallows Googlebot"))?.severity).toBe("error");
  });
});

describe("crawlability review fixes", () => {
  it("follows RFC 9309: longest match wins, Allow wins ties, wildcards, Sitemap lines don't split groups", () => {
    expect(robotsBlocks("User-agent: *\nDisallow: /\nAllow: /\n", "GPTBot")).toBe(false);
    expect(robotsBlocks("User-agent: *\nDisallow: /*\n", "GPTBot")).toBe(true);
    expect(robotsBlocks("User-agent: *\nDisallow: /$\n", "GPTBot")).toBe(true);
    expect(robotsBlocks("User-agent: *\nDisallow: /private/\n", "GPTBot")).toBe(false);
    expect(robotsBlocks("User-agent: GPTBot\nSitemap: https://x.example/s.xml\nDisallow: /\n\nUser-agent: *\nAllow: /\n", "GPTBot")).toBe(true);
    expect(robotsBlocks("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n", "ClaudeBot")).toBe(true);
  });

  it("reads X-Robots-Tag per bot", () => {
    expect(xRobotsNoindex("noindex", ["googlebot"])).toBe(true);
    expect(xRobotsNoindex("otherbot: noindex", ["googlebot", "bingbot"])).toBe(false);
    expect(xRobotsNoindex("googlebot: noindex, nofollow", ["googlebot"])).toBe(true);
    expect(xRobotsNoindex("unavailable_after: 2030-01-01", ["googlebot"])).toBe(false);
    expect(xRobotsNoindex("max-snippet: 20, noarchive", ["googlebot"])).toBe(false);
  });

  it("doesn't mistake reCAPTCHA for a challenge, and reports a site-wide block once", async () => {
    const recaptcha = fake((url, ua, init) => (url.pathname === "/" && url.protocol === "https:" && !url.hostname.startsWith("www.") ? new Response('<html><head><title>Home</title><script src="https://www.google.com/recaptcha/api.js"></script></head></html>') : healthy(url, ua, init)));
    expect(await checkCrawlability("https://example.org", { fetch: recaptcha })).toEqual([]);

    const everyone = fake(() => new Response("<title>Just a moment...</title>"));
    const found = await checkCrawlability("https://example.org", { fetch: everyone });
    expect(found.filter((d) => d.kind === "crawler-blocked")).toHaveLength(1);
    expect(found[0]!.detail).toMatch(/Even a normal browser/);
  });

  it("treats a blocked search-engine probe as a warning that explains fake-bot protection", async () => {
    const found = await checkCrawlability("https://example.org", { fetch: fake((url, ua, init) => (/Googlebot/.test(ua) ? new Response("no", { status: 403 }) : healthy(url, ua, init))) });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", kind: "crawler-blocked" });
    expect(found[0]!.detail).toMatch(/fake search bots/);
  });

  it("skips www/http checks for local addresses, and survives a reset while reading", async () => {
    const local = fake((url) => (url.port === "4173" ? new Response("<html><title>x</title></html>") : new Response("", { status: 500 })));
    expect(await checkCrawlability("http://127.0.0.1:4173", { fetch: local })).toEqual([]);
    const flaky = fake((url, ua, init) => {
      if (url.pathname === "/robots.txt") return new Response(new ReadableStream({ start: (c) => c.error(new Error("terminated")) }));
      return healthy(url, ua, init);
    });
    await expect(checkCrawlability("https://example.org", { fetch: flaky })).resolves.toEqual([]);
  });
});
