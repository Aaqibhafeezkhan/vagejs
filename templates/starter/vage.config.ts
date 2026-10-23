import { defineConfig } from "vagejs";

export default defineConfig({
  // Your production origin. Needed for canonical URLs and sitemap.xml. Replace before deploying.
  site: "https://example.com",
  title: "My Website",
  description: "A website built with VAGE JS.",
  lang: "en",

  seo: {
    robots: {
      // AI crawler policy is your decision; unset means the "*" rules apply.
      // aiTraining: "disallow", // GPTBot, ClaudeBot, Google-Extended
      // aiSearch: "allow",      // OAI-SearchBot, Claude-SearchBot
    },
    sitemap: true,
    llmsTxt: { full: false },
    structuredData: {
      // organization: { name: "Your Company", logo: "/images/logo.png" },
    },
  },

  // redirects: { "/old-page/": "/about/" },
});
