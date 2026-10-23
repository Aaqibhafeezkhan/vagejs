# AGENTS.md

This website uses **VAGE JS** (pre-release). Only the features listed here exist today.

## Commands

| Command           | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run dev`     | Dev server with live reload. Prints the local URL.        |
| `npm run build`   | Static build into `dist/`. Exits non-zero on any error.   |
| `npm run preview` | Serves `dist/` locally.                                   |

`npx vage build --json` prints a machine-readable result: `{ ok, pages, skippedDrafts, outDir, durationMs }` or `{ ok: false, error }`.

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
description: One line    # optional; used for <meta name="description">
draft: true              # optional; drafts are skipped in builds (still visible in dev)
layout: default          # optional; loads src/layouts/<name>.ts
---
```

Do not invent titles, descriptions, dates, authors or facts. Ask the site owner.

## Layouts

`src/layouts/<name>.ts` default-exports a function `({ content, page, site }) => string`.
`content` is already-rendered HTML; escape every other interpolated value with `escapeHtml` from `vagejs`.

## Config

`vage.config.ts` accepts only: `site` (absolute URL), `title`, `description`, `lang`. Unknown keys are an error.

## Not implemented yet

robots.txt, sitemap.xml, llms.txt, canonical/Open Graph tags, JSON-LD, `vage check`, audits, analytics, deployment. Do not use or document them as available.

## Safety

Never commit `.env` files or credentials. Static files in `public/` are copied to `dist/` as-is.
