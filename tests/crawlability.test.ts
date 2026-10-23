import { describe, expect, it } from "vitest";
import { CRAWLERS, checkCrawlability, probeUserAgent, robotsBlocks } from "../src/checks/crawlability.js";

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

  it("reports CDN blocks and challenges: errors for search engines, warnings for AI crawlers", async () => {
    const found = await checkCrawlability("https://example.org", {
      fetch: fake((url, ua, init) => {
        if (/GPTBot/.test(ua)) return new Response("blocked", { status: 403, headers: { "cf-mitigated": "challenge" } });
        if (/bingbot/.test(ua)) return new Response("<title>Just a moment...</title>");
        return healthy(url, ua, init);
      }),
    });
    const by = Object.fromEntries(found.map((d) => [d.detail.split(" ")[0], d.severity]));
    expect(by).toEqual({ GPTBot: "warning", bingbot: "error" });
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
