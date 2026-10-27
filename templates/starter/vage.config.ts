import { defineConfig } from "vagejs";

export default defineConfig({
  // Your production origin. Needed for canonical URLs and sitemap.xml. Replace before deploying.
  site: "https://example.com",
  title: "My Website",
  description: "A website built with vagejs.",
  lang: "en",

  // Menus for layouts (props.menus). Edit them here, not in the layout.
  // { page: "/about/" } uses that page's navTitle or title; other sites: { label: "GitHub", href: "https://..." }.
  menus: {
    main: [{ page: "/" }, { page: "/about/" }, { page: "/blog/" }],
  },

  seo: {
    robots: {
      // AI crawler policy is your decision; unset means the "*" rules apply.
      // aiTraining: "disallow", // GPTBot, ClaudeBot, Google-Extended, Applebot-Extended
      // aiSearch: "allow",      // OAI-SearchBot, Claude-SearchBot, PerplexityBot
    },
    sitemap: true,
    // llms.txt plus llms-full.txt, and a Markdown copy of each page (/about/ -> /about.md), for AI tools.
    llmsTxt: { full: true },
    markdownCopies: true,
    // RSS feed for the blog at /blog/feed.xml.
    feeds: [{ under: "/blog/" }],
    // Once the project is in git: sitemap <lastmod> dates from each page's last commit.
    // lastmod: "git",
    // Social preview image for pages without their own `image:` (1200x630 PNG or JPG in public/).
    // defaultImage: "/images/og.png",
    structuredData: {
      // BreadcrumbList for the trail src/layouts/default.ts shows.
      breadcrumbs: true,
      // Who runs the site (home page JSON-LD, and the publisher of articles). Only true facts.
      // organization: { name: "Your Company", url: "https://example.com", logo: "/images/logo.png", sameAs: ["https://www.linkedin.com/company/..."] },
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
