# VAGE JS — AI-Native Web Framework Product & Build Specification

> **Purpose:** Build a lightweight, code-first web framework that AI coding agents can use to create, preview, validate, and publish websites. SEO, search-engine compatibility, AI crawler guidance, performance checks, analytics integrations, and GitHub workflows are built into the framework by default.
>
> **Product brand:** VAGE JS
> **Working CLI command:** `vage` (proposed; validate naming conflicts before release)
> **Proposed npm package:** `vagejs` (unverified; check npm availability before publishing)
> **Domain direction:** `vage.in` is owned by the project owner; `vagejs.com` is booked. Do not assume any other domain is available.
>
> **Primary implementation agent:** Claude Code
>
> **Status:** Product specification and phased implementation plan. This file is not evidence that the described framework or commands already exist.

---

## 1. Product vision

Create an Astro-inspired, AI-native web framework for developers and coding agents. It should be lightweight, terminal-first, extensible, and straightforward to adopt.

A user should be able to ask an AI coding agent to build a website, and the agent should be able to use this framework to:

1. Scaffold a project.
2. Generate pages, layouts, reusable components, and content.
3. Run a local development server with hot reload.
4. Validate accessibility, SEO, structured data, crawler rules, links, and performance budgets.
5. Build a production-ready website.
6. Publish source code to GitHub.
7. Optionally deploy through a supported hosting provider.
8. Connect analytics and search tools with explicit user authorization.
9. Keep guideline knowledge current through a source-backed, reviewed update process.

**No visual editor or admin dashboard is required for the MVP.** The main interfaces are the CLI, configuration files, source code, clear terminal output, documentation, and AI-agent instructions.

## 2. Product principles

- **Code-first:** files and terminal commands are the primary interface.
- **Static by default:** emit HTML with minimal client-side JavaScript unless interactivity or server rendering is explicitly required.
- **AI-agent friendly:** document APIs and commands clearly; provide `AGENTS.md`, agent skills, examples, and optional MCP tools.
- **Secure by default:** never expose access tokens, API secrets, or private environment variables in client bundles or Git commits.
- **Source-backed guidance:** link recommendations and automated rules to official provider documentation.
- **Configurable:** site owners control crawling, tracking, indexing, integrations, and deployment.
- **Honest reporting:** distinguish a passing technical check from guaranteed indexing, ranking, AI citations, or real-user performance.
- **Incremental implementation:** ship a small reliable core before expanding integrations.
- **License-aware:** study Astro and other open-source projects as references; do not copy code without verifying license compatibility and attribution obligations.

## 3. Target users

- Developers who build content-focused and marketing websites.
- Freelancers and agencies producing SEO/AEO-oriented websites.
- Users of Claude Code and other compatible coding agents.
- SaaS teams that want static-first performance, repeatable builds, and automated technical checks.
- Teams that want terminal-driven publishing and integrations without adopting a visual CMS.

## 4. Main user journey

```text
User request
    ↓
AI coding agent discovers framework instructions and tools
    ↓
CLI scaffolds project
    ↓
Agent writes pages, components, and content
    ↓
Local dev server + browser preview
    ↓
Automated checks: build, links, SEO, schema, accessibility, performance
    ↓
Developer reviews and fixes findings
    ↓
Production build
    ↓
GitHub repository
    ↓
Optional hosting deployment
    ↓
Optional analytics and search performance reports
    ↓
Versioned framework/guideline updates
```

## 5. Proposed technical stack

Choose the simplest stable stack that supports the requirements. Confirm current supported versions before implementation.

- **Runtime:** Node.js LTS.
- **Language:** TypeScript.
- **Package manager:** npm initially; avoid requiring multiple package managers for the MVP.
- **CLI:** a maintained TypeScript CLI library, selected during implementation.
- **Development server:** Vite or another well-supported development server.
- **Content:** Markdown first; add MDX only if the initial architecture supports it cleanly.
- **Schemas:** Zod or an equivalent TypeScript schema validator.
- **HTML generation:** server-side/static rendering with a clear rendering boundary.
- **Testing:** unit tests, integration tests, fixture websites, and end-to-end smoke tests.
- **CI:** GitHub Actions.
- **Publishing:** Git CLI first; optional GitHub API integration later.
- **Performance:** Lighthouse CI or Lighthouse programmatic integration, with PageSpeed Insights API support for deployed sites.
- **Integrations:** official APIs and documented OAuth/credential flows where available.

Do not add a database, hosted control plane, or visual dashboard to the MVP unless a real requirement demands it.

## 6. Architecture

Keep the implementation modular. Suggested package/module boundaries:

```text
packages/
  cli/                 # create, dev, build, check, audit, connect, deploy
  core/                # configuration, routing, rendering, build orchestration
  content/             # Markdown loading, content collections, schema validation
  discovery/           # robots.txt, sitemap.xml, llms.txt, metadata
  structured-data/     # JSON-LD helpers and validators
  checks/              # link, route, SEO, accessibility and config checks
  performance/         # bundle budgets, Lighthouse and PageSpeed adapters
  integrations/        # GA4, GSC, Bing, Clarity and other adapters
  guidelines/          # official source registry, snapshots, rule versions
  agent-support/       # AGENTS.md templates, skills and optional MCP server
  deploy/              # GitHub and hosting adapters
examples/
  starter/
  marketing-site/
  content-site/
docs/
tests/
```

This is a proposed organization. If a monorepo creates too much overhead, begin with a single TypeScript package and preserve these module boundaries internally.

### Core responsibilities

1. **CLI:** validate arguments, provide helpful errors, and orchestrate core modules.
2. **Framework core:** configuration, route discovery, rendering, build output, dev server.
3. **Content engine:** Markdown pages and typed content collections.
4. **Discovery engine:** generate and validate crawl/discovery resources.
5. **Compatibility engine:** maintain provider-specific, versioned rules linked to authoritative sources.
6. **Quality engine:** static checks and actionable diagnostics.
7. **Integration adapters:** isolated API clients, authentication, and reporting.
8. **Publishing engine:** safe Git operations and optional deployment adapters.
9. **Agent support:** instructions and machine-readable docs for coding agents.

## 7. CLI design

The commands below are proposed. Implement and document only commands that actually work.

```bash
# Create a project
npx vagejs create my-website

cd my-website
npm install

# Development
npm run dev
# or, if the CLI is globally available:
vage dev

# Build and checks
vage check
vage build
vage preview

# Auditing
vage audit
vage audit --url https://example.com

# Optional integrations
vage connect ga4
vage connect gsc
vage report analytics
vage report search

# Publishing
vage deploy:github
vage deploy
```

### CLI requirements

- Print the local preview URL and port.
- Support port selection and explain port conflicts.
- Provide readable, actionable errors.
- Return non-zero exit codes for failed builds and configured strict checks.
- Support machine-readable JSON output for CI and agents.
- Avoid destructive Git operations without explicit confirmation.
- Never claim a deployment succeeded until the provider confirms it.
- Keep commands stable and versioned once released.

## 8. Project conventions and file-based routing

Proposed starter structure:

```text
my-website/
├── src/
│   ├── pages/
│   │   ├── index.md
│   │   ├── about.md
│   │   └── blog/
│   │       └── first-post.md
│   ├── layouts/
│   ├── components/
│   └── content/
├── public/
│   ├── favicon.svg
│   └── images/
├── tests/
├── AGENTS.md
├── framework.config.ts
├── package.json
└── .gitignore
```

The exact route rules and component syntax must be specified before implementing the renderer. Start with simple Markdown routes and a minimal layout/component mechanism. Do not claim Astro API compatibility unless it is deliberately implemented and tested.

## 9. Default SEO, discovery, and AI-readiness features

Generate these from actual project configuration and published routes. Do not require users to maintain them manually.

### 9.1 `robots.txt`

- Serve `/robots.txt`.
- Support explicit, configurable rules per user-agent.
- Reference the canonical sitemap URL.
- Avoid blocking public assets needed for rendering.
- Provide safe defaults, but never silently override the owner's crawler policy.
- Keep search crawler permissions separate from model-training crawler permissions where the provider supports that distinction.
- Do not imply that robots directives are access control. Private resources must be protected by authentication and authorization.

### 9.2 `sitemap.xml`

- Generate a valid XML sitemap from published, indexable, canonical routes.
- Exclude drafts, redirects, noindex pages, duplicate canonical URLs, and private routes.
- Include `lastmod` only when a trustworthy content modification time is known.
- Support sitemap indexes if required by scale.
- Validate XML and URLs during build.
- Do not promise indexing merely because a URL appears in the sitemap.

### 9.3 `llms.txt` and optional `llms-full.txt`

- Generate `/llms.txt` as a curated Markdown guide to important public pages and documentation.
- Optionally generate `/llms-full.txt` when the site owner opts in.
- Make clear that `llms.txt` is an emerging convention, not a universally adopted or guaranteed indexing standard.
- Do not place secrets, private content, or non-public URLs in generated files.
- Do not duplicate the entire site unnecessarily.

### 9.4 Metadata and canonical URLs

- Title and meta description support.
- Canonical link support with normalized absolute URLs.
- Open Graph and social metadata.
- Language attributes and optional alternate-language links.
- Configurable index/noindex directives.
- Correct status codes and redirect rules.
- No fabricated page titles, descriptions, author information, dates, or factual claims.

### 9.5 Structured data

- Provide typed JSON-LD helpers for relevant types, such as `Organization`, `WebSite`, `Article`, `Product`, and `BreadcrumbList`.
- Generate only schemas that match the visible page content and use case.
- Validate syntax and required/recommended fields.
- Avoid schema spam, unsupported properties, and invented facts.
- Treat Google's rich-result eligibility rules as provider-specific rather than assuming all schema types produce rich results.

### 9.6 AEO/GEO support

- Encourage clear headings, descriptive links, factual language, accessible HTML, and useful content.
- Support author/source attribution and visible publication/update dates when known.
- Do not generate empty FAQ sections or keyword-stuffed text merely to chase rich results.
- Do not promise AI citations, recommendations, or ranking gains.

## 10. Official-guideline monitoring and learning

Create a versioned registry of official documentation sources. The system should regularly check sources for changes, summarize differences, and propose rule updates. It must not blindly rewrite production behavior based on scraped text or LLM guesses.

### Initial source registry

Maintain exact URLs, provider names, source categories, last-checked timestamps, and change-detection method. Verify current official URLs during implementation.

- Google Search Central: https://developers.google.com/search/docs
- Google Search Essentials: https://developers.google.com/search/docs/essentials
- Google structured data: https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data
- Google PageSpeed Insights API: https://developers.google.com/speed/docs/insights/v5/get-started
- Bing Webmaster Guidelines: https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a
- IndexNow: https://www.indexnow.org/documentation
- OpenAI crawlers: https://developers.openai.com/api/docs/bots
- Anthropic web crawling guidance: https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- Schema.org: https://schema.org/docs/documents.html
- W3C accessibility resources: https://www.w3.org/WAI/standards-guidelines/

### Monitoring workflow

1. Check official sources on a scheduled cadence (for example, daily or weekly depending on source volatility).
2. Record the fetch time, canonical source URL, content fingerprint, and available published/updated date.
3. Detect and store changed sections or snapshots where legally and technically appropriate.
4. Produce a concise change report with source links and affected rules.
5. Ask an LLM to classify the change as informative, recommended, required, deprecated, or unclear. Treat the classification as a draft, not authority.
6. Require human review for rules that change crawler access, indexing behavior, privacy, security, build output, or public APIs.
7. Run regression tests against fixtures before publishing updated rules.
8. Version and release approved rule packs.
9. Let projects pin a rule-pack version or opt into a supported update policy.
10. Keep an audit trail of why each rule exists and which official source supports it.

### Important distinctions

- Provider guidance can conflict; keep rules provider-specific.
- Do not treat unofficial blog posts as official requirements.
- Do not use a language model's internal knowledge as proof of current policy.
- Do not claim that every LLM provider supports `llms.txt`.
- Do not confuse crawler permission with indexing or citation guarantees.
- Do not automatically grant training or search crawlers access without honoring site-owner settings.

## 11. Performance and PageSpeed engine

### Local checks

- Production build succeeds.
- Bundle and asset-size budgets.
- Broken internal links and missing assets.
- Images with missing dimensions or unsuitable formats where detectable.
- Unnecessary client-side JavaScript where measurable.
- Accessibility checks using a suitable automated checker.
- Static SEO and structured-data checks.

### Deployed URL checks

- Integrate with the Google PageSpeed Insights API when a user supplies a URL and, if required, an API key.
- Run Lighthouse audits for mobile and desktop where supported.
- Report performance, accessibility, SEO, and best-practice scores when provided by the underlying tool.
- Record the URL, device strategy, audit timestamp, tool version, and relevant configuration.
- Provide a concise list of findings and potential fixes.

### Core Web Vitals

Report the metrics accurately:

- **LCP:** good at 2.5 seconds or less.
- **INP:** good at 200 milliseconds or less.
- **CLS:** good at 0.1 or less.

These thresholds are assessed at the 75th percentile of real-user page loads for Google's field-data assessment. Explain that lab audits are simulated measurements and are not substitutes for field data. Field data may be unavailable for low-traffic pages or sites.

### Performance budgets

Allow configurable budgets for:
- Lighthouse categories.
- JavaScript and CSS bundle size.
- Image and font payload.
- Number of requests where useful.
- Build duration where relevant.

Initial example targets could be 90+ Lighthouse performance, 95+ accessibility, and 95+ SEO. Treat these as configurable goals, not universal guarantees. Strict mode should be opt-in so external API outages or noisy lab results do not unexpectedly block all builds.

## 12. Analytics and search integrations

Integrations should be optional, modular, and disabled until configured by the site owner.

### Google Analytics 4 (GA4)

- Support a Measurement ID in project configuration.
- Provide a minimal integration that avoids duplicate tags.
- Support custom events through an explicit typed API.
- Respect consent and applicable privacy requirements.
- Do not place service-account secrets or private API credentials in client-side code.
- Distinguish browser collection from authenticated reporting API access.

### Google Search Console (GSC)

- Support user-authorized authentication and property selection.
- Use the official Search Console APIs for supported performance reports and URL/site operations.
- Explain that not all features in the Search Console UI are exposed through APIs.
- Keep OAuth tokens and refresh tokens securely stored outside the repository.
- Do not claim a URL is indexed just because a sitemap submission succeeded.
- Provide helpful instructions for verifying site ownership when needed.

### Google Tag Manager (GTM)

- Optional container ID configuration.
- Avoid loading duplicate GTM and direct analytics tags.
- Provide a documented consent and data-layer strategy.

### Bing Webmaster Tools and IndexNow

- Support relevant authenticated reporting or submission APIs where available.
- Implement IndexNow as an optional URL notification integration.
- Treat notifications as hints, not a guarantee of crawling or indexing.

### Other optional integrations

Design adapters for:
- Microsoft Clarity.
- Plausible Analytics.
- Ahrefs and Semrush, only when suitable API access and user credentials are available.
- Additional providers via a documented adapter interface.

Do not require every integration for a project to build. Analytics scripts should not be added by default without consent/configuration decisions.

## 13. Integration configuration and secrets

Example illustrative configuration:

```ts
export default defineConfig({
  site: "https://example.com",

  seo: {
    robots: true,
    sitemap: true,
    llmsTxt: true,
    structuredData: true,
  },

  performance: {
    lighthouse: true,
    budgets: {
      performance: 90,
      accessibility: 95,
      seo: 95,
    },
  },

  integrations: {
    ga4: {
      enabled: Boolean(process.env.GA4_MEASUREMENT_ID),
      measurementId: process.env.GA4_MEASUREMENT_ID,
    },
  },
});
```

This is illustrative until the API is implemented.

Security rules:
- Commit an `.env.example`, never a real `.env`.
- Add `.env`, token files, local credentials, build artifacts, and private logs to `.gitignore` as appropriate.
- Validate required environment variables without printing secret values.
- Keep client-exposed variables explicitly allowlisted.
- Provide a secure, documented authentication flow for OAuth integrations.
- Never log access tokens or secrets.
- Use least-privilege scopes.
- Allow users to revoke and remove connections.

## 14. GitHub publishing and deployment

### GitHub publishing

Support Git CLI first. An optional GitHub API integration can be added later.

The publishing flow should:
1. Verify the working directory and repository state.
2. Run configured checks and production build.
3. Show the files to be committed.
4. Confirm before creating or pushing commits if the action is not explicitly pre-authorized.
5. Never overwrite a remote branch or discard changes without explicit consent.
6. Avoid committing secrets, local environment files, caches, and generated artifacts unless intentionally configured.
7. Display the confirmed repository URL and branch after successful push.

### Hosting adapters

Plan for:
- Cloudflare Pages / Workers, according to supported output mode.
- Vercel.
- Netlify.
- Any static host that can serve the generated output directory.

Use provider-supported deployment methods. Do not claim server-side rendering support for a provider until the adapter implements and tests it.

### CI

Provide a GitHub Actions starter workflow to:
- Install dependencies using the lockfile.
- Run tests.
- Run `check`.
- Build the website.
- Optionally run non-flaky audits.
- Deploy only after successful checks and appropriate branch/environment permissions.

## 15. AI-agent compatibility

The framework must be easy for Claude Code and other compatible coding agents to discover and use.

Include:
- A root `AGENTS.md` explaining architecture, commands, conventions, testing, and safety rules.
- Claude Code-specific guidance if useful, without making the framework exclusive to one agent.
- Optional reusable agent skills for scaffold, build, audit, and integration setup.
- Clear examples of valid configuration and generated output.
- A machine-readable command/help output mode.
- Optional MCP server only after the core CLI is stable.
- Explicit confirmation steps for destructive operations, publishing, OAuth authorization, and production deployment.

Do not assume an LLM can access the user's filesystem, browser, credentials, or network unless the agent environment grants that capability.

## 16. Testing and quality gates

Every module needs tests. At minimum:

### Core
- New project scaffolds and installs.
- Development server starts and serves routes.
- Markdown routes render expected HTML.
- Build output is deterministic where feasible.
- Preview serves the production output.

### Discovery/SEO
- Robots file is valid and honors configuration.
- Sitemap XML is valid and contains only eligible routes.
- Canonical URLs are normalized.
- `llms.txt` contains only public configured content.
- Noindex and redirects are handled correctly.
- JSON-LD is valid and based on page content.

### Performance and accessibility
- Budget logic has unit tests.
- Audit failures are actionable.
- External API failure is reported clearly.
- Automated accessibility tests run against fixture sites.

### Integrations
- Use mocked APIs for tests; never require real credentials in CI.
- Verify authentication failures, rate limits, retries, and malformed responses.
- Ensure credentials never appear in logs or client bundles.

### Publishing
- Test with a temporary local Git repository.
- Test dirty working tree and remote-conflict scenarios.
- Verify no secret files are staged.
- Use explicit confirmation for destructive actions.

## 17. Phased implementation plan

Do not try to build every feature in one pass. Claude Code should work phase by phase, with tests and a review after each milestone.

### Phase 0 — Repository and design decisions
- Inspect the current repository before changing files.
- Identify existing code, package manager, conventions, and tests.
- Record architecture decisions and trade-offs.
- Confirm VAGE JS branding, npm package and CLI naming, supported Node version, license, and initial output mode. Verify package-name availability and trademark/domain risks; do not publish or register names without explicit owner approval.
- Do not overwrite an existing project.

**Exit criteria:** documented decisions and a clean, understandable repository plan.

### Phase 1 — Minimal framework
- Build CLI scaffolding.
- Generate a starter project.
- Implement basic file-based Markdown routes.
- Add a minimal layout/rendering model.
- Implement local development server and hot reload.
- Implement production static build and preview.
- Add starter tests and documentation.

**Exit criteria:** a new project can be created, previewed locally, built, and previewed from production output.

### Phase 2 — Discovery and SEO defaults
- Generate robots.txt, sitemap.xml, llms.txt.
- Implement metadata and canonical URLs.
- Add JSON-LD helpers.
- Implement checks and actionable diagnostics.
- Add fixture-based regression tests.

**Exit criteria:** generated discovery files and metadata match the actual route set and site configuration.

### Phase 3 — AI-agent support
- Add `AGENTS.md` to generated projects.
- Document commands and configuration in an agent-friendly format.
- Add examples and machine-readable help.
- Test a representative coding-agent workflow.
- Consider MCP only after the CLI API is stable.

**Exit criteria:** an agent can create and modify a site using documented commands without guessing APIs.

### Phase 4 — Performance and accessibility
- Add bundle and asset budgets.
- Integrate automated accessibility checks.
- Add Lighthouse local/deployed audits.
- Add PageSpeed Insights API support.
- Add clear lab-versus-field data explanations.

**Exit criteria:** a website can be audited locally and, when available, by deployed URL.

### Phase 5 — GitHub and deployment
- Implement safe Git initialization, commit, and push workflow.
- Add CI starter workflow.
- Add one hosting adapter first, selected based on the MVP target audience.
- Add deployment previews and clear errors.

**Exit criteria:** a user can publish source code to GitHub and follow a tested deployment path.

### Phase 6 — GA4 and GSC
- Implement secure, documented setup flows.
- Add GA4 tag configuration and event helpers.
- Add GSC OAuth/property selection and supported reports.
- Add consent/privacy controls and secret handling tests.

**Exit criteria:** users can connect their own properties and retrieve authorized reports without exposing credentials.

### Phase 7 — Guideline monitoring
- Build the official source registry.
- Implement scheduled change detection.
- Store versioned rule packs and evidence links.
- Generate change reports.
- Require review for behavior-changing rules.
- Add regression tests and documented update/release process.

**Exit criteria:** guideline changes are traceable, reviewable, testable, and do not silently change production behavior.

### Phase 8 — Additional integrations
- Add Bing Webmaster Tools, IndexNow, Clarity, Plausible, and other adapters based on demand.
- Add hosting providers and optional CMS/content-source adapters.
- Avoid expanding scope before reliability and documentation are strong.

## 18. Non-goals for the first release

- A visual page builder or admin dashboard.
- Guaranteed Google indexing, rankings, or AI citations.
- Automatic access to user accounts or credentials without authorization.
- A hosted analytics platform that stores all customer data.
- Full compatibility with Astro's internal APIs.
- A general-purpose CMS with user management and editorial workflows.
- Automatically changing production crawler permissions without user approval.
- An LLM that trains itself on scraped documentation without traceability or review.

## 19. Definition of done for the MVP

The MVP is ready when all of the following are true:

- [ ] A user can scaffold a project using the documented CLI.
- [ ] The generated project installs successfully from its lockfile.
- [ ] A local development server runs with hot reload.
- [ ] Markdown routes render correctly.
- [ ] A production static build completes.
- [ ] Production output can be previewed locally.
- [ ] `robots.txt`, `sitemap.xml`, and `llms.txt` are generated from configuration and routes.
- [ ] Metadata, canonical URLs, and supported JSON-LD can be configured.
- [ ] `check` returns actionable results and meaningful exit codes.
- [ ] Tests run in CI without requiring private API credentials.
- [ ] The generated project includes agent instructions and examples.
- [ ] Publishing to GitHub is safe, tested, and documented.
- [ ] Secrets are not committed or exposed in browser bundles.
- [ ] Documentation distinguishes implemented behavior from planned features.

## 20. Instructions for Claude Code

### VAGE JS naming and release guardrails
- Use **VAGE JS** as the working product brand in docs and examples.
- Treat `vagejs` as a proposed npm package name and `vage` as a proposed CLI command only; neither is confirmed available.
- Do not publish to npm, reserve domains, create public organizations, or make trademark claims without explicit owner approval.
- Before package setup, check the exact npm package names and inspect existing packages, repositories, domains, and relevant trademark records. Report findings with links and distinguish confirmed facts from unverified possibilities.
- The owner prefers a globally oriented `.com` domain; `vagejs.com` is booked. `vage.in` is owned and can be used as a temporary project homepage or redirect if the owner chooses. Do not describe `.in` as technically unsuitable; present domain trade-offs factually.
- Keep product branding, npm package name, executable CLI name, GitHub repository name, and domain as separate decisions that can differ.


Use this document as the product specification, not as permission to implement every phase at once.

1. Start by inspecting the repository and reporting what already exists.
2. Propose a concise implementation plan for **Phase 0 and Phase 1 only**.
3. Ask before making any destructive change or overwriting existing files.
4. Implement small, testable increments.
5. Run the relevant tests after each increment and fix failures before proceeding.
6. Keep APIs and documentation aligned with actual code.
7. Do not invent successful test results, provider support, or deployment status.
8. Do not add real secrets, tokens, or credentials to source control.
9. Prefer official current documentation for external APIs; record links and access dates.
10. At the end of each phase, report:
    - What was implemented.
    - Files changed.
    - Commands run and their actual results.
    - Known limitations.
    - The next recommended milestone.
11. Stop at the end of each phase and summarize before moving to the next one unless the user explicitly requests end-to-end implementation.
12. Keep the MVP focused: a working CLI, local preview, static build, and tests come before external integrations.

### First task to give Claude Code

> Read `BUILD_SPEC.md` completely. Inspect the existing repository without overwriting anything. Summarize the current state, identify decisions that need confirmation, and propose a small Phase 0–1 implementation plan. Do not implement later phases yet. Once the plan is approved, build a minimal working framework that can scaffold a Markdown-based website, run locally with hot reload, produce a static build, preview that build, and pass automated tests. Keep all unimplemented capabilities clearly marked as planned.

---

## Appendix A — Example generated website configuration

This is a conceptual example only; exact API names should be settled during implementation.

```ts
export default defineConfig({
  site: "https://example.com",

  output: "static",

  seo: {
    robots: true,
    sitemap: true,
    llmsTxt: true,
    structuredData: true,
  },

  performance: {
    budgets: {
      performance: 90,
      accessibility: 95,
      seo: 95,
    },
  },

  integrations: {
    ga4: {
      enabled: false,
    },
    searchConsole: {
      enabled: false,
    },
  },
});
```

## Appendix B — Expected output from a successful build

```text
dist/
├── index.html
├── about/
│   └── index.html
├── blog/
│   └── first-post/
│       └── index.html
├── robots.txt
├── sitemap.xml
├── llms.txt
├── assets/
└── favicon.svg
```

Actual output may differ based on the selected routing strategy and configured integrations.

## Appendix C — Key external references

Verify each URL and its current guidance during implementation:

- Google Search documentation: https://developers.google.com/search/docs
- Google Search Essentials: https://developers.google.com/search/docs/essentials
- Google PageSpeed Insights API: https://developers.google.com/speed/docs/insights/v5/get-started
- Search Console API: https://developers.google.com/webmaster-tools
- Google Analytics Data API: https://developers.google.com/analytics/devguides/reporting/data/v1
- Bing Webmaster Guidelines: https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a
- IndexNow: https://www.indexnow.org/documentation
- OpenAI crawler documentation: https://developers.openai.com/api/docs/bots
- Anthropic crawler guidance: https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler
- Schema.org: https://schema.org/docs/documents.html
- W3C accessibility standards: https://www.w3.org/WAI/standards-guidelines/
- GitHub Actions documentation: https://docs.github.com/actions
- Lighthouse: https://developer.chrome.com/docs/lighthouse/overview/
