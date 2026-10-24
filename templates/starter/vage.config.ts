import { defineConfig } from "vagejs";

export default defineConfig({
  // Your production origin. Needed for canonical URLs and sitemap.xml. Replace before deploying.
  site: "https://example.com",
  title: "My Website",
  description: "A website built with vagejs.",
  lang: "en",

  seo: {
    robots: {
      // AI crawler policy is your decision; unset means the "*" rules apply.
      // aiTraining: "disallow", // GPTBot, ClaudeBot, Google-Extended, Applebot-Extended
      // aiSearch: "allow",      // OAI-SearchBot, Claude-SearchBot, PerplexityBot
    },
    sitemap: true,
    llmsTxt: { full: false },
    structuredData: {
      // organization: { name: "Your Company", logo: "/images/logo.png" },
    },
  },

  // Spam protection: links to other websites must be approved in links.lock.json
  // (npx vage links approve <domain>). "require" also fails if that file is deleted.
  security: { outboundLinks: "require" },

  // redirects: { "/old-page/": "/about/" },

  // Analytics is off until you configure it. Tags are added to production builds only.
  // integrations: {
  //   ga4: {
  //     measurementId: process.env.GA4_MEASUREMENT_ID, // e.g. "G-XXXXXXX"
  //     consentDefault: "denied", // your consent UI calls window.vageConsent.update({ analytics_storage: "granted" })
  //     events: { signup_click: { params: ["plan"] } },
  //   },
  //   searchConsole: { property: "sc-domain:example.com" },
  // },
});
