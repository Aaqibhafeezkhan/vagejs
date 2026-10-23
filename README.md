<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/agevenkat/vagejs/main/assets/brand/vagejs-logo-dark.svg">
    <img src="https://raw.githubusercontent.com/agevenkat/vagejs/main/assets/brand/vagejs-logo.svg" alt="vagejs" width="320">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/vagejs"><img src="https://img.shields.io/npm/v/vagejs?color=4F46E5&label=npm" alt="npm version"></a>
  <a href="https://github.com/agevenkat/vagejs/actions/workflows/ci.yml"><img src="https://github.com/agevenkat/vagejs/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/npm/l/vagejs?color=2E2A8C" alt="MIT license"></a>
</p>

# vagejs

An AI-native, static-first web framework. Write pages in Markdown, and vagejs builds a fast static site with SEO, `llms.txt`, accessibility and security handled for you. It's built so AI coding agents can use it without guessing. **Pre-release (0.x).**

- **Static by default**: plain HTML, no client JavaScript unless you add analytics.
- **SEO built in**: `robots.txt`, `sitemap.xml`, `llms.txt`, canonical URLs, Open Graph and JSON-LD, generated from your pages.
- **Checks before you ship**: `vage check` (links, SEO, structured data, accessibility) and `vage audit` (page-weight budgets, axe, optional Lighthouse and PageSpeed).
- **Safe by default**: page content is sanitized; secrets, build output and force-pushes are refused; Cloudflare deploys get a computed Content-Security-Policy.
- **Agent-friendly**: every site ships with `AGENTS.md`, and `vage info --json` describes every command and config option.

## Quick start

Requires **Node.js 22.12 or newer**.

```bash
npm create vagejs@latest my-site
cd my-site
npm install
npm run dev
```

Open the URL it prints. Edit `src/pages/index.md` and the browser reloads.

## Using vagejs

### Project layout

```text
my-site/
├── src/
│   ├── pages/          # every .md file is a page
│   │   ├── index.md    # → /
│   │   ├── about.md    # → /about/
│   │   └── blog/
│   │       └── first-post.md   # → /blog/first-post/
│   └── layouts/
│       └── default.ts  # HTML around each page
├── public/             # copied to the site as-is (favicons, images)
├── vage.config.ts      # site settings
└── AGENTS.md           # instructions for AI coding agents
```

### Write a page

```markdown
---
title: Pricing
description: Plans and prices.
---

# Pricing

Our plans start at …
```

Save it as `src/pages/pricing.md` and it's served at `/pricing/`. `title` is required. `description`, `draft`, `noindex`, `canonical`, `image`, `type: article`, `author`, `datePublished` and `dateModified` are optional; see [`templates/starter/AGENTS.md`](templates/starter/AGENTS.md).

Images in `public/` used as `![Alt text](/images/photo.jpg)` get their `width` and `height` from the file, so the page doesn't jump while loading.

### Write a layout

Layouts are TypeScript functions. The `html` template tag escapes every value for you; `raw()` inserts trusted HTML such as the rendered page. (Escaping doesn't check URLs, so validate link targets that come from frontmatter.) `pages` lists every published page, and `collection()` picks and sorts them:

```ts
import { collection, html, raw, z, type Layout } from "vagejs";

// Optional: fields this layout accepts. Pages using it are checked strictly, so typos fail the build.
export const frontmatter = z.object({ intro: z.string().optional() });

const layout: Layout = ({ content, page, site, pages }) => html`<!doctype html>
<html lang="${site.lang}">
  <head><title>${page.title}</title></head>
  <body>
    <main>${raw(content)}</main>
    <h2>Latest posts</h2>
    <ul>${collection(pages, { under: "/blog/", sort: "date", limit: 5 }).map((p) => html`<li><a href="${p.route}">${p.title}</a></li>`)}</ul>
  </body>
</html>`;

export default layout;
```

### Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with live reload |
| `npm run check` | Links, SEO, structured data and basic accessibility; writes nothing |
| `npm run build` | Static site in `dist/`, plus `robots.txt`, `sitemap.xml`, `llms.txt` |
| `npm run audit` | Page-weight budgets and automated accessibility (`-- --lighthouse` adds Lighthouse) |
| `npm run preview` | Serves `dist/` locally, the way a static host would |

Add `--json` to `npx vage build`, `check` or `audit` for machine-readable output. Failures exit with code 1.

### Configure the site

`vage.config.ts`:

```ts
import { defineConfig } from "vagejs";

export default defineConfig({
  site: "https://example.com", // your real domain (used for canonical URLs and the sitemap)
  title: "My Website",
  description: "What this site is about.",
  seo: {
    robots: { aiTraining: "disallow" }, // optional: block AI training crawlers, keep search
    llmsTxt: { full: false },
  },
  redirects: { "/old-page/": "/new-page/" },
});
```

Unknown keys are an error, so typos don't silently do nothing. `npx vage info --json` prints the full schema.

### Deploy

```bash
npx vage deploy:github --remote https://github.com/you/site.git   # check, build, safe commit + push (asks first)
npx vage deploy                                                  # GitHub Pages via Actions
npx vage deploy --target cloudflare-workers --project my-site    # Cloudflare Workers: new version, no downtime
npx vage deploy --target cloudflare-pages --project my-site      # older Cloudflare Pages projects
```

Every deploy shows its plan and asks for confirmation (`--dry-run` to preview, `--yes` to skip). It reports success only after the host confirms.

Cloudflare now creates new static sites as Workers, so use `cloudflare-workers` for new projects. For a custom domain, add a `wrangler.jsonc` with your `routes`; vagejs uses it and switches versions without re-attaching domains, so the site stays up during deploys.

### Analytics, Search Console and audits of live pages

Optional, and off until configured: GA4 or Google Tag Manager (consent denied by default), Plausible, Microsoft Clarity, IndexNow. `vage connect gsc|ga4` adds read-only Search Console and GA4 reports, and `vage audit --url https://your-site` runs PageSpeed and CrUX with **your own** Google API key. Details are in the generated `AGENTS.md`.

## Updating

vagejs follows semver. While it's 0.x, a minor version (0.1 → 0.2) may include breaking changes, so read the release notes before moving up a minor version.

```bash
npm outdated vagejs           # see what's available
npm update vagejs             # latest patch in your range (with ^0.2.0: any 0.2.x)
npm install vagejs@latest     # move to the newest version, including a new minor
npx vage --version            # confirm
npx vage check && npx vage build
```

If your config pins the rule pack (`guidelines: { rulePack: "…" }`), a build after an update that ships new provider rules stops with a message. Review them with `npx vage guidelines`, then update the pin. New projects always use the latest version through `npm create vagejs@latest`.

## Use with AI coding agents

Every site includes `AGENTS.md` (conventions, recipes, definition of done) and `CLAUDE.md` (imports `AGENTS.md`). Agents can discover the API instead of guessing:

```bash
npx vage info --json    # commands, options, config and frontmatter JSON Schemas
npx vage check --json   # findings with file, rule and fix hints
```

## Command reference

```bash
vage create <dir> [--vage-spec <spec>] [--json]   # scaffold a Markdown site
vage dev      [--root .] [--port N] [--host]      # dev server with live reload
vage build    [--root .] [--json]                 # static build into dist/ (+ robots.txt, sitemap.xml, llms.txt)
vage check    [--root .] [--json] [--strict]      # SEO, links, JSON-LD, basic a11y; writes nothing
vage audit    [--root .] [--lighthouse] [--url U] [--strategy mobile|desktop|both] [--strict] [--json]
                                                  # budgets + axe a11y; optional Lighthouse; PageSpeed/CrUX for deployed URLs
vage preview  [--root .] [--port N] [--host]      # serve dist/ locally
vage deploy:github [--remote URL] [--branch B] [-m MSG] [--dry-run] [--yes] [--json]   # check, build, safe commit + push (asks first)
vage deploy        [--remote URL] [--no-wait] [--dry-run] [--yes] # GitHub Pages via Actions; confirms with GitHub
vage deploy --target cloudflare-workers [--project NAME]          # new Worker version at 100%; custom domains stay up
vage deploy --target cloudflare-pages --project NAME [--branch B] # Wrangler upload; preview URL per branch
vage indexnow --changed-since REF | --urls … | --all              # IndexNow URL notification (asks first)
vage connect gsc|ga4 / vage disconnect google      # read-only Google OAuth (PKCE, loopback); token outside the repo
vage connect pagespeed|crux / vage disconnect …   # save your own Google API key for audit --url (outside the repo)
vage report search|analytics [--days N] [--json]  # Search Console top queries/pages; GA4 top pages
vage guidelines [--json]                          # rule pack: provider facts in use, sources, changelog
vage info     [--json]                            # commands + config/frontmatter JSON Schemas for agents
```

## Planned, not implemented

Bing Webmaster Tools API, Netlify/Vercel adapters, CMS content sources, multi-language sites, base paths, sitemap indexes, MCP server, image resizing and WebP/AVIF conversion.

## Security

Page content is sanitized, dev/preview servers serve only what a site needs, and Cloudflare deploys get security headers with a computed Content-Security-Policy. Report vulnerabilities privately: see [SECURITY.md](SECURITY.md).

## Contributing

```bash
npm install
npm run typecheck
npm test            # unit + integration (dev server, preview, build)
npm run test:e2e    # pack -> create -> npm install/ci -> build (needs npm registry or cache)
```

Design decisions: [docs/DECISIONS.md](docs/DECISIONS.md). Provider rules and how they're monitored: [docs/GUIDELINES.md](docs/GUIDELINES.md). Releasing: [docs/RELEASING.md](docs/RELEASING.md).

## Brand assets

- `assets/brand/vagejs-icon.svg`: the icon, as received (with C2PA content credentials).
- `assets/brand/vagejs-logo.svg` and `vagejs-logo-dark.svg`: the wordmark for light and dark backgrounds, with **Space Grotesk Bold embedded** (a 1.6 KB WOFF2 subset of the glyphs used), so it renders the same without the font installed. Space Grotesk is © 2020 The Space Grotesk Project Authors, under the SIL Open Font License 1.1 (`assets/brand/fonts/OFL.txt`). Editing the file invalidated its C2PA signature, so that block was removed. The dark variant only changes the text colors (`#F4F5FA` and `#A5B4FC`).
- New sites get `favicon.svg`, `favicon.ico` (16/32/48) and `apple-touch-icon.png` (180) in `public/`.

Regenerate (maintainer tools; need Chrome, and Python with `fonttools` and `brotli`):

```bash
node scripts/brand/favicons.mjs templates/starter/public/favicon.svg templates/starter/public
python -I scripts/brand/embed-logo-font.py "SpaceGrotesk[wght].ttf" <original-logo.svg> assets/brand/vagejs-logo.svg
```

## License

MIT © 2026 vagejs.com
