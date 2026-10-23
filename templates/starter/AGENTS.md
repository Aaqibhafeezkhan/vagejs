# AGENTS.md

This website uses **VAGE JS** (pre-release). Only the features listed here exist today.

## Commands

| Command           | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Dev server with live reload. Prints the local URL.        |
| `npm run build`   | Static build into `dist/`. Exits non-zero on any error.   |
| `npm run check`   | SEO, link, structured-data and basic a11y checks. Writes nothing. Exit 1 on errors (`--strict`: also on warnings). |
| `npm run audit`   | Builds, then checks page-weight budgets and runs axe accessibility rules. `--lighthouse` adds a local Lighthouse run (install `lighthouse`; needs Chrome). `--url <https://...>` audits a deployed page via PageSpeed Insights (+ CrUX field data with `CRUX_API_KEY`). |
| `npm run preview` | Serves `dist/` locally.                                   |

Add `--json` to `npx vage build`, `check` or `audit` for machine-readable output (`{ ok: false, error }` on failure).
Run `npm run check` after every change and fix all errors before finishing.

## Machine-readable reference

`npx vage info --json` prints every command and option plus JSON Schemas for `vage.config.ts` and page frontmatter. Prefer it over guessing.

## Recipes

- **Add a page:** create `src/pages/<slug>.md` with `title` and `description` frontmatter; link to it as `/<slug>/` (trailing slash).
- **Add a blog post:** `src/pages/blog/<slug>.md`; for Article data add `type: article`, plus `author` / `datePublished` only if the owner provided them.
- **Add a layout:** `src/layouts/<name>.ts`, then `layout: <name>` in frontmatter. Keep `<html lang>`, one `<title>` and `</head>`.
- **Rename a page:** move the file, then add `redirects: { "/old-slug/": "/new-slug/" }` to `vage.config.ts`.
- **Hide a page from search:** `noindex: true` (it stays published). To unpublish, use `draft: true` or delete it.
- **AI crawler policy:** set `seo.robots.aiTraining` / `aiSearch` only on the owner's instruction.

## Definition of done

`npm run check` reports 0 errors and `npm run build` succeeds. Report remaining warnings to the owner rather than hiding them.

## Routing

Every `.md` file in `src/pages/` becomes a page:

- `src/pages/index.md` → `/`
- `src/pages/about.md` → `/about/`
- `src/pages/blog/index.md` → `/blog/`
- `src/pages/blog/first-post.md` → `/blog/first-post/`
- `src/pages/404.md` → `dist/404.html` (not a route)
- Files or folders starting with `_` are ignored.
- Two files mapping to the same route is a build error.

## Frontmatter

```yaml
---
title: Page title        # required
description: One line    # meta description, og:description, llms.txt
draft: true              # skipped in builds (still visible in dev); links to drafts fail `check`
layout: default          # loads src/layouts/<name>.ts
noindex: true            # robots noindex; excluded from sitemap.xml and llms.txt
canonical: /other/       # canonical override (path or absolute URL); page then leaves the sitemap
image: /images/og.png    # og:image (made absolute using `site`)
type: article            # og:type + Article JSON-LD (default: website)
author: Jane Doe         # Article author
datePublished: 2026-01-31
dateModified: 2026-02-15 # also used as sitemap <lastmod>
---
```

Do not invent titles, descriptions, dates, authors or facts. Ask the site owner.

## Layouts

`src/layouts/<name>.ts` default-exports a function `({ content, page, site }) => string`.
`content` is already-rendered HTML; escape every other interpolated value with `escapeHtml` from `vagejs`.
`page.url` is the absolute canonical URL (when `site` is set and the page is indexable).

The layout must contain `</head>`. VAGE JS inserts these before it, skipping any the layout already writes:
meta description, robots noindex, canonical, Open Graph, `twitter:card`, and JSON-LD
(WebSite + configured Organization on `/`, Article for `type: article`). If the layout writes its own
`application/ld+json`, automatic JSON-LD is skipped. Helpers: `organization`, `website`, `article`,
`breadcrumbList`, `jsonLdScript` from `vagejs`. Only mark up what is visible on the page.

## Generated files

From the published pages and config (never from `public/`; a hand-written `public/robots.txt` etc. is a build error):

- `robots.txt`: `*` allowed unless you add `seo.robots.rules`. AI crawler groups only if you set `aiTraining` / `aiSearch`.
- `sitemap.xml`: indexable, self-canonical, non-draft pages. Needs `site`.
- `llms.txt` (+ `llms-full.txt` with `llmsTxt: { full: true }`): same pages. An emerging convention; not a guarantee that AI tools use it.
- Redirects: `redirects: { "/old/": "/new/" }` become noindex meta-refresh pages (dev server answers 301).

## Config

`vage.config.ts` keys: `site` (origin only, no path), `title`, `description`, `lang`,
`seo: { robots, sitemap, llmsTxt, structuredData }`, `redirects`. Unknown keys are an error.

## Performance and accessibility

Budgets live in `vage.config.ts` under `performance.budgets` (Lighthouse scores and per-page KB/requests). They are starting points, not standards.
Budget misses and lab scores are warnings (`--strict` fails on them). axe violations of serious/critical impact are errors.
Lab results (Lighthouse, PageSpeed) are simulated and vary between runs; field data (CrUX, real users at p75) is what Google's Core Web Vitals assessment uses, and is missing for low-traffic sites.
`vage audit --url` uses the **site owner's own** Google Cloud API keys; VAGE JS has none of its own and never calls PageSpeed without a key. Keys come from `PAGESPEED_API_KEY` / `CRUX_API_KEY`, or are saved by the owner with `npx vage connect pagespeed` / `crux` (stored outside the project). Never ask for, print, or commit a key; never put one in `vage.config.ts`.

## Publishing and deployment

Always ask the site owner before publishing or deploying. Show them the plan first:

- `npx vage deploy:github --dry-run`: runs check + build and lists exactly what would be committed and pushed.
- `npx vage deploy:github --remote <git-url>`: commits and pushes after confirmation (`--yes` skips the prompt; use only with the owner's approval). Refuses secrets (`.env`, keys, token-like strings), `dist/`, `node_modules/`, and never force-pushes. If the push is rejected, pull/rebase manually.
- `npx vage deploy --target cloudflare-pages --project <name>` (or `deploy: { target: "cloudflare-pages", cloudflareProject }` in config): uploads `dist/` with Wrangler. Non-production branches get preview URLs. Config redirects become real 301s (`_redirects`). It reports success only when Wrangler succeeds and the URL responds. Needs `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` or `npx wrangler login`.
- `npx vage deploy`: GitHub Pages (default target). Adds `.github/workflows/deploy.yml` (if missing), publishes, enables Pages via `gh` if needed, then waits for the Actions run. It says "deployed" only when GitHub reports success.

After deploying, `npx vage indexnow --changed-since HEAD~1` (needs `integrations.indexNow.key`) tells IndexNow search engines about changed pages. It's a hint, not a guarantee of indexing; ask the owner first.

GitHub Pages needs a custom domain or a `<user>.github.io` repository, because VAGE JS does not support base paths yet.
`.github/workflows/ci.yml` runs check, build and audit on every push and PR, and uploads `dist/` as a downloadable preview artifact.

## Analytics and search reports

Off unless configured in `vage.config.ts` under `integrations`. Ask the site owner before adding analytics; it has privacy and consent implications.

- **Plausible** / **Microsoft Clarity**: `integrations.plausible.snippet` / `integrations.clarity.snippet` hold the exact snippet from the provider's dashboard, inserted verbatim. Don't invent or edit snippets.
- **GA4** (`integrations.ga4.measurementId`) or **Tag Manager** (`integrations.gtm.containerId`): never both. Tags are added to production builds only (not `npm run dev`) and skip localhost.
- **Consent**: Google's `consentDefault` is `"denied"` unless changed. The site must provide its own consent UI that calls `window.vageConsent.update({ analytics_storage: "granted", ad_storage: "denied" })`; this forwards to Google and Clarity (consentv2).
- **Events**: declare them (for every configured provider that receives events: ga4/gtm/plausible), then mark elements: `<a href="/pricing/" data-vage-event="signup_click" data-vage-param-plan="pro">`. `vage check` fails on undeclared events/params and on duplicate Google tags.
- **Reports**: `npx vage connect gsc|ga4` (browser OAuth, read-only scopes; token stored outside the repo), then `npx vage report search` / `npx vage report analytics`. `npx vage disconnect google` revokes access. Needs `GOOGLE_OAUTH_CLIENT_ID` (see `.env.example`).
- Secrets go in `.env` (git-ignored) or the shell, never in `vage.config.ts` or committed files.

## Provider rules

`npx vage guidelines` lists the provider facts VAGE JS uses (AI crawler tokens, Web Vitals thresholds, GA4 limits) with their official sources. Pin a version with `guidelines: { rulePack: "<version>" }` so an upgrade can't silently change output.

## Not implemented yet

Bing Webmaster Tools API, Netlify/Vercel adapters, CMS content sources, multi-language sites, base paths. Do not use or document them as available. A passing `check` does not guarantee indexing, rankings or AI citations.

## Safety

Never commit `.env` files or credentials. Static files in `public/` are copied to `dist/` as-is.
