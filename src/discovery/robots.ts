import type { SiteConfig } from "../core/config.js";
import { VageError } from "../core/errors.js";
import { AI_CRAWLERS } from "./crawlers.js";

type RobotsOptions = Exclude<SiteConfig["seo"]["robots"], false>;

interface Group {
  agents: string[];
  allow: string[];
  disallow: string[];
}

/**
 * robots.txt from explicit config only. Unset AI options add nothing, so the
 * owner's `*` policy applies. robots.txt is advisory and is not access control.
 */
export function robotsTxt(site: SiteConfig, options: RobotsOptions): string {
  const groups: Group[] = options.rules.map((r) => ({
    agents: Array.isArray(r.userAgent) ? r.userAgent : [r.userAgent],
    allow: r.allow,
    disallow: r.disallow,
  }));
  const named = new Set(groups.flatMap((g) => g.agents.map((a) => a.toLowerCase())));

  for (const [purpose, policy] of [
    ["training", options.aiTraining],
    ["search", options.aiSearch],
  ] as const) {
    if (!policy) continue;
    for (const crawler of AI_CRAWLERS.filter((c) => c.purpose === purpose)) {
      if (named.has(crawler.token.toLowerCase())) {
        throw new VageError(
          `robots: "${crawler.token}" is set both in seo.robots.rules and by seo.robots.ai${purpose === "training" ? "Training" : "Search"}. Keep only one.`,
        );
      }
      groups.push({ agents: [crawler.token], allow: policy === "allow" ? ["/"] : [], disallow: policy === "disallow" ? ["/"] : [] });
    }
  }
  if (!named.has("*")) groups.push({ agents: ["*"], allow: [], disallow: [] });

  const body = groups
    .map((g) => {
      const lines = g.agents.map((a) => `User-agent: ${a}`);
      lines.push(...g.allow.map((p) => `Allow: ${p}`), ...g.disallow.map((p) => `Disallow: ${p}`));
      if (!g.allow.length && !g.disallow.length) lines.push("Disallow:");
      return lines.join("\n");
    })
    .join("\n\n");

  const sitemap = site.seo.sitemap && site.site ? `\n\nSitemap: ${site.site}/sitemap.xml` : "";
  return `${body}${sitemap}\n`;
}
