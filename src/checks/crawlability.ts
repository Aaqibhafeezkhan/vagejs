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

const CHALLENGE = /<title>\s*(Just a moment|Attention Required|Access denied)|cf-challenge|challenge-platform|captcha/i;

/** Does robots.txt disallow the whole site for this token (its own group, or "*" if it has none)? */
export function robotsBlocks(robots: string, token: string): boolean {
  const groups: { agents: string[]; disallowAll: boolean }[] = [];
  let current: { agents: string[]; disallowAll: boolean } | undefined;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], disallowAll: false }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (current && key === "disallow" && value === "/") current.disallowAll = true;
    }
  }
  const own = groups.filter((g) => g.agents.includes(token.toLowerCase()));
  const applicable = own.length ? own : groups.filter((g) => g.agents.includes("*"));
  return applicable.some((g) => g.disallowAll);
}

type Fetcher = typeof fetch;

export async function checkCrawlability(origin: string, options: { fetch?: Fetcher } = {}): Promise<Difference[]> {
  const doFetch = options.fetch ?? fetch;
  const out: Difference[] = [];
  const get = async (url: string, init: RequestInit = {}) => {
    try {
      return await doFetch(url, { signal: AbortSignal.timeout(20_000), ...init });
    } catch {
      return undefined;
    }
  };

  // 1. Crawlers reach the home page (no block, no challenge).
  for (const c of CRAWLERS) {
    const res = await get(`${origin}/`, { headers: { "user-agent": probeUserAgent(c), accept: "text/html" } });
    const body = res?.ok ? await res.text() : "";
    const blocked = !res || !res.ok || res.headers.get("cf-mitigated") !== null || CHALLENGE.test(body.slice(0, 4000));
    if (blocked) {
      const why = !res ? "no response" : res.headers.get("cf-mitigated") ? `blocked by the CDN (cf-mitigated: ${res.headers.get("cf-mitigated")})` : !res.ok ? `HTTP ${res.status}` : "a challenge page instead of the site";
      out.push({
        route: "/",
        severity: c.purpose === "search" ? "error" : "warning",
        kind: "crawler-blocked",
        detail: `${c.token} (${c.provider}, ${c.purpose}) gets ${why}. ${c.purpose === "search" ? "Search engines can't index the site." : "If you didn't block it on purpose, check your host's bot or AI-crawler settings."}`,
      });
    }
  }

  // 2. robots.txt
  const robotsRes = await get(`${origin}/robots.txt`);
  if (robotsRes?.ok) {
    const robots = await robotsRes.text();
    for (const c of CRAWLERS.filter((x) => x.purpose !== "ai-user")) {
      if (robotsBlocks(robots, c.token)) {
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
  if (xRobots && /noindex|none/i.test(xRobots)) {
    out.push({ route: "/", severity: "error", kind: "noindex-header", detail: `The server sends "X-Robots-Tag: ${xRobots}", which keeps the site out of search results.` });
  }

  // 4. One address per page: http should redirect to https, and www/non-www to the site's host.
  const url = new URL(origin);
  if (url.protocol === "https:") {
    const plain = await get(`http://${url.host}/`, { redirect: "manual" });
    const to = plain?.headers.get("location") ?? "";
    if (plain && !(plain.status >= 300 && plain.status < 400 && to.startsWith("https://"))) {
      out.push({ route: "/", severity: "warning", kind: "redirect-missing", detail: `http://${url.host}/ answers ${plain.status} instead of redirecting to https. Turn on "Always use HTTPS" (or equivalent) at your host.` });
    }
  }
  const other = url.hostname.startsWith("www.") ? url.hostname.slice(4) : `www.${url.hostname}`;
  const twin = await get(`${url.protocol}//${other}/`, { redirect: "manual" });
  if (twin && twin.status === 200) {
    out.push({ route: "/", severity: "warning", kind: "duplicate-host", detail: `${other} serves the site too instead of redirecting to ${url.hostname}. Add a redirect at your host so search engines see one address.` });
  }
  return out;
}
