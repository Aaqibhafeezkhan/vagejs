import { rulePack, ruleData } from "../guidelines/pack.js";

/**
 * Documented robots.txt tokens for AI crawlers, grouped by purpose. The list
 * lives in the rule pack (rule "robots.ai-crawlers") with its official sources;
 * change it only through a reviewed rule-pack release.
 */
export interface CrawlerToken {
  token: string;
  provider: string;
  purpose: "training" | "search";
  /** Official documentation URL. */
  source: string;
}

export const AI_CRAWLERS: CrawlerToken[] = ruleData<{ crawlers: (Omit<CrawlerToken, "source"> & { source: string })[] }>("robots.ai-crawlers").crawlers.map(
  (c) => ({ ...c, source: rulePack.sources.find((s) => s.id === c.source)!.url }),
);
