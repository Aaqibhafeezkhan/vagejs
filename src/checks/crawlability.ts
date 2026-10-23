import { ruleData } from "../guidelines/pack.js";
import type { Difference } from "./verify.js";

/**
 * Can search engines and AI crawlers actually reach the live site? Checks what a site's
 * own files can't show: CDN/firewall blocks and challenges, robots.txt rules, missing
 * http→https and www redirects, and noindex headers. Probes send each crawler's
 * documented user agent (or token), so blocks based on the real crawlers' IP
 * addresses can't be detected this way.
 */

export interface Crawler {
  token: string;
  provider: string;
  purpose: "search" | "ai-search" | "ai-training" | "ai-user";
  userAgent?: string;
  source: string;
}

export const CRAWLERS: Crawler[] = ruleData<{ crawlers: Crawler[] }>("crawlers.probes").crawlers;

/** The documented user agent (W.X.Y.Z filled in), or a minimal one carrying the documented token. */
export function probeUserAgent(c: Crawler): string {
  return c.userAgent ? c.userAgent.replace("W.X.Y.Z", "131.0.0.0") : `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ${c.token}/1.0)`;
}

/** A challenge or block page, recognized by its title (not by scripts like reCAPTCHA that normal pages load). */
const CHALLENGE_TITLE = /<title>\s*(Just a moment|Attention Required|Access denied|Checking your browser)/i;

/** robots.txt path pattern -> RegExp (RFC 9309: "*" wildcard, "$" end anchor). */
function patternRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/**
 * Is the site root ("/") disallowed for this crawler? RFC 9309: the crawler follows the
 * groups naming its token (merged), else the "*" groups; among rules matching "/", the
 * longest pattern wins and Allow wins ties. Lines like Sitemap: don't end a group.
 */
export function robotsBlocks(robots: string, token: string): boolean {
  type Group = { agents: string[]; rules: { allow: boolean; pattern: string }[] };
  const groups: Group[] = [];
  let current: Group | undefined;
  let collectingAgents = false;
  for (const raw of robots.split(/\r?\n/)) {
    const m = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/i.exec(raw.replace(/#.*/, ""));
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!;
    if (key === "user-agent") {
      if (!current || !collectingAgents) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if (key === "allow" || key === "disallow") {
      collectingAgents = false;
      if (current && value) current.rules.push({ allow: key === "allow", pattern: value });
    }
  }
  const named = groups.filter((g) => g.agents.includes(token.toLowerCase()));
  const rules = (named.length ? named : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  let best: { allow: boolean; length: number } | undefined;
  for (const r of rules) {
    if (!patternRegex(r.pattern).test("/")) continue;
    const length = r.pattern.length;
    if (!best || length > best.length || (length === best.length && r.allow)) best = { allow: r.allow, length };
  }
  return best !== undefined && !best.allow;
}

/** Does an X-Robots-Tag value say noindex for everyone, or for one of these crawlers? */
export function xRobotsNoindex(value: string, tokens: string[]): boolean {
  const lower = tokens.map((t) => t.toLowerCase());
  // "googlebot: noindex, nofollow" targets one bot; "noindex" targets all.
  return value.split(/,(?=\s*[a-z-]+\s*:)/i).some((part) => {
    const m = /^\s*([a-z-]+)\s*:\s*(.*)$/i.exec(part);
    const target = m && !/^(unavailable_after|max-[a-z-]+)$/i.test(m[1]!) ? m[1]!.toLowerCase() : undefined;
    const directives = target ? m![2]! : part;
    return (!target || lower.includes(target)) && /\b(noindex|none)\b/i.test(directives);
  });
}

type Fetcher = typeof fetch;

export async function checkCrawlability(origin: string, options: { fetch?: Fetcher } = {}): Promise<{ differences: Difference[]; crawlersChecked: number }> {
  const doFetch = options.fetch ?? fetch;
  const out: Difference[] = [];
  const get = async (url: string, init: RequestInit = {}) => {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(20_000), ...init });
      // Read the body here too: a reset mid-download is a failed request, not a crash.
      const body = res.ok ? (await res.text()).slice(0, 8000) : "";
      return { status: res.status, ok: res.ok, headers: res.headers, body };
    } catch {
      return undefined;
    }
  };
  const blockedReason = (res: Awaited<ReturnType<typeof get>>) =>
    !res ? "no response" : res.headers.get("cf-mitigated") ? `blocked by the CDN (cf-mitigated: ${res.headers.get("cf-mitigated")})` : !res.ok ? `HTTP ${res.status}` : CHALLENGE_TITLE.test(res.body) ? "a challenge page instead of the site" : undefined;

  // 1. Crawlers reach the home page. Only blocks that a normal browser doesn't get count.
  const browser = await get(`${origin}/`, { headers: { "user-agent": "Mozilla/5.0 (compatible; vagejs-verify) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", accept: "text/html" } });
  const browserBlocked = blockedReason(browser);
  if (browserBlocked) {
    out.push({ route: "/", severity: "error", kind: "crawler-blocked", detail: `Even a normal browser gets ${browserBlocked}, so crawlers can't reach the site either.` });
  } else {
    for (const c of CRAWLERS) {
      const why = blockedReason(await get(`${origin}/`, { headers: { "user-agent": probeUserAgent(c), accept: "text/html" } }));
      if (!why) continue;
      out.push({
        route: "/",
        severity: "warning",
        kind: "crawler-blocked",
        detail: `${c.token} (${c.provider}, ${c.purpose}) gets ${why}. ${
          c.purpose === "search"
            ? "If your host blocks fake search bots, this probe (which can't come from the real crawler's addresses) may be what's blocked; confirm in Google Search Console or Bing Webmaster Tools."
            : "If you didn't block it on purpose, check your host's bot or AI-crawler settings."
        }`,
      });
    }
  }

  // 2. robots.txt
  const robotsRes = await get(`${origin}/robots.txt`);
  if (robotsRes?.ok) {
    for (const c of CRAWLERS.filter((x) => x.purpose !== "ai-user")) {
      if (robotsBlocks(robotsRes.body, c.token)) {
        out.push({
          route: "/robots.txt",
          severity: c.purpose === "search" ? "error" : "warning",
          kind: "robots-blocked",
          detail: `robots.txt disallows ${c.token} (${c.provider}, ${c.purpose}) from the whole site.${c.purpose === "ai-training" ? " Fine if that's your choice (seo.robots.aiTraining)." : ""}`,
        });
      }
    }
  }

  // 3. noindex sent as a header hides the site even when the HTML says nothing.
  const home = await get(`${origin}/`, { redirect: "manual" });
  const xRobots = home?.headers.get("x-robots-tag");
  if (xRobots && xRobotsNoindex(xRobots, ["googlebot", "bingbot"])) {
    out.push({ route: "/", severity: "error", kind: "noindex-header", detail: `The server sends "X-Robots-Tag: ${xRobots}", which keeps the site out of search results.` });
  }

  // 4. One address per page: http should redirect to https, and www/non-www to the site's host.
  //    Skipped for local addresses (ports, IPs, localhost), where there's no public twin.
  const url = new URL(origin);
  const publicHost = !url.port && !/^(localhost|\d+\.\d+\.\d+\.\d+|\[.*\])$/i.test(url.hostname) && url.hostname.includes(".");
  if (publicHost && url.protocol === "https:") {
    const plain = await get(`http://${url.host}/`, { redirect: "manual" });
    const to = plain?.headers.get("location") ?? "";
    if (plain && !(plain.status >= 300 && plain.status < 400 && to.startsWith("https://"))) {
      out.push({ route: "/", severity: "warning", kind: "redirect-missing", detail: `http://${url.host}/ answers ${plain.status} instead of redirecting to https. Turn on "Always use HTTPS" (or equivalent) at your host.` });
    }
  }
  if (publicHost) {
    const other = url.hostname.startsWith("www.") ? url.hostname.slice(4) : `www.${url.hostname}`;
    const twin = await get(`${url.protocol}//${other}/`, { redirect: "manual" });
    if (twin && twin.status === 200) {
      out.push({ route: "/", severity: "warning", kind: "duplicate-host", detail: `${other} serves the site too instead of redirecting to ${url.hostname}. Add a redirect at your host so search engines see one address.` });
    }
  }
  return { differences: out, crawlersChecked: browserBlocked ? 0 : CRAWLERS.length };
}
