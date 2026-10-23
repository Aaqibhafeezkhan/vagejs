# VAGE JS

An AI-native, static-first web framework. **Pre-release (Phase 6)**: not published to npm.

## What works today

```bash
vage create <dir> [--vage-spec <spec>] [--json]   # scaffold a Markdown site
vage dev      [--root .] [--port N] [--host]      # dev server with live reload
vage build    [--root .] [--json]                 # static build into dist/ (+ robots.txt, sitemap.xml, llms.txt)
vage check    [--root .] [--json] [--strict]      # SEO, links, JSON-LD, basic a11y; writes nothing
vage audit    [--root .] [--lighthouse] [--url U] [--strategy mobile|desktop|both] [--strict] [--json]
                                                  # budgets + axe a11y; optional Lighthouse; PageSpeed/CrUX for deployed URLs
vage preview  [--root .] [--port N] [--host]      # serve dist/ locally
vage deploy:github [--remote URL] [--dry-run] [--yes] [--json]   # check, build, safe commit + push (asks first)
vage deploy        [--remote URL] [--no-wait] [--dry-run] [--yes] # GitHub Pages via Actions; confirms with GitHub
vage connect gsc|ga4 / vage disconnect google      # read-only Google OAuth (PKCE, loopback); token outside the repo
vage report search|analytics [--days N] [--json]  # Search Console top queries/pages; GA4 top pages
vage info     [--json]                            # commands + config/frontmatter JSON Schemas for agents
```

Generated sites include `AGENTS.md` (conventions, recipes, definition of done) and `CLAUDE.md` (imports AGENTS.md).

Failures exit with code 1. With `--json`, output is `{ "ok": true, ... }` or `{ "ok": false, "error": "..." }`.

See [`templates/starter/AGENTS.md`](templates/starter/AGENTS.md) for routing, frontmatter, layouts and config, and [`docs/DECISIONS.md`](docs/DECISIONS.md) for design decisions.

## Trying it locally (before any npm release)

```bash
npm install
npm run build
npm pack                                   # -> vagejs-0.1.0.tgz
node dist/cli/index.js create ../my-site --vage-spec "file:$PWD/vagejs-0.1.0.tgz"
cd ../my-site && npm install && npm run dev
```

## Development

```bash
npm run typecheck
npm test            # unit + integration (dev server, preview, build)
npm run test:e2e    # pack -> create -> npm install/ci -> build (needs npm registry or cache)
```

## Planned, not implemented

Bing Webmaster Tools, IndexNow, Clarity, Plausible, hosting adapters other than GitHub Pages. See `VAGE_JS_BUILD_SPEC.md`.

## License

MIT
