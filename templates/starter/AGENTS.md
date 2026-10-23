# AGENTS.md

This website uses **VAGE JS** (pre-release). Only the features listed here exist today.

## Commands

| Command           | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Dev server with live reload. Prints the local URL.        |
| `npm run build`   | Static build into `dist/`. Exits non-zero on any error.   |
| `npm run check`   | SEO, link, structured-data and basic a11y checks. Writes nothing. Exit 1 on errors (`--strict`: also on warnings). |
| `npm run preview` | Serves `dist/` locally.                                   |

Add `--json` to `npx vage build` or `npx vage check` for machine-readable output (`{ ok: false, error }` on failure).
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

## Not implemented yet

Lighthouse/PageSpeed audits, full automated accessibility testing, analytics, Search Console, GitHub publishing, deployment. Do not use or document them as available. A passing `check` does not guarantee indexing, rankings or AI citations.

## Safety

Never commit `.env` files or credentials. Static files in `public/` are copied to `dist/` as-is.
