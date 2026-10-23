/**
 * Documented robots.txt tokens for AI crawlers, grouped by purpose.
 * Each entry cites the provider's own documentation. Re-verify before changing;
 * do not add tokens from unofficial lists.
 */
export interface CrawlerToken {
  token: string;
  provider: string;
  purpose: "training" | "search";
  source: string;
  verified: string;
}

export const AI_CRAWLERS: CrawlerToken[] = [
  { token: "GPTBot", provider: "OpenAI", purpose: "training", source: "https://developers.openai.com/api/docs/bots", verified: "2026-10-23" },
  { token: "OAI-SearchBot", provider: "OpenAI", purpose: "search", source: "https://developers.openai.com/api/docs/bots", verified: "2026-10-23" },
  {
    token: "ClaudeBot",
    provider: "Anthropic",
    purpose: "training",
    source: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    verified: "2026-10-23",
  },
  {
    token: "Claude-SearchBot",
    provider: "Anthropic",
    purpose: "search",
    source: "https://support.claude.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler",
    verified: "2026-10-23",
  },
  {
    // Controls use for Gemini training and grounding; Google documents that it does not affect Google Search.
    token: "Google-Extended",
    provider: "Google",
    purpose: "training",
    source: "https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers",
    verified: "2026-10-23",
  },
];
