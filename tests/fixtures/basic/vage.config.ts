// Plain object (no "vagejs" import) so the fixture works without a built package.
export default {
  site: "https://fixture.example",
  title: "Fixture Site",
  description: "A fixture site for tests.",
  lang: "en-GB",
  seo: {
    robots: { aiTraining: "disallow", rules: [{ userAgent: "*", disallow: ["/private/"] }] },
    llmsTxt: { full: true },
    structuredData: { organization: { name: "Fixture Org", logo: "/images/logo.png" } },
  },
  redirects: { "/old": "/about/" },
};
