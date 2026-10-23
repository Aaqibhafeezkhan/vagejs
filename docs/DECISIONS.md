# Architecture decisions

Phase 0 record. Dates are 2026-10-23 unless noted.

## Confirmed by the owner

| Decision | Choice |
| --- | --- |
| Dev server / module loading | Vite 8 |
| License | MIT |
| Node floor | `>=22.12.0` (owner chose "Node 22+"; 22.12 is Vite 8's minimum) |
| Version control | Local `git init`, no remote |

## Naming status (not reserved, not published)

`npm view` on 2026-10-23 returned 404 (no published package) for `vagejs`, `vage`, `create-vagejs`, `@vagejs/core`.
A 404 only means nothing is published under that name right now. Trademark, GitHub org and domain
checks have **not** been done. `package.json` is `"private": true` to prevent an accidental publish.
Brand (VAGE JS), npm name (`vagejs`), CLI (`vage`), repo name and domain remain separate decisions.

## Implementation choices (Phase 1)

- **Single package**, with spec module boundaries as folders: `src/cli`, `src/core`, `src/content`, `src/dev`. Split into a monorepo only if it earns its overhead.
- **Config file is `vage.config.ts`** (spec placeholder was `framework.config.ts`). Validated with Zod as a strict object, so unknown keys fail instead of being silently ignored. Phase 1 keys: `site`, `title`, `description`, `lang`.
- **Routes**: `src/pages/**/*.md` → trailing-slash routes (`about.md` → `/about/` → `dist/about/index.html`). `_`-prefixed files/folders are ignored. Route collisions are build errors. `404.md` → `dist/404.html`.
- **Trailing slashes**: dev and preview both 301-redirect `/about` → `/about/`, matching most static hosts.
- **Frontmatter**: YAML; `title` required (no generated titles), `description`, `draft`, `layout` optional; extra keys pass through to layouts.
- **Layouts are plain TypeScript functions** `({ content, page, site }) => string` in `src/layouts/<name>.ts`, loaded through Vite's SSR loader. No custom template language or component syntax yet. A built-in default layout is used when `src/layouts/default.ts` is absent.
- **Markdown**: `marked` (GFM). Raw HTML in Markdown is passed through (content is author-controlled).
- **Zero client JS in build output.** The dev server injects only Vite's client for live reload.
- **Live reload, not HMR**: any change under `src/` or to the config sends a full page reload. Pages are re-rendered per request, so new pages need no restart.
- **Builds are atomic-ish**: all pages render before `dist/` is replaced, so a failing build leaves the last good output.
- **Unpublished install path**: `vage create --vage-spec file:<tarball>` lets a generated project install the local package until a real release exists.

## Phase 2: discovery and SEO

- **One site model** (`src/core/site.ts`) renders all pages, then derives sitemap.xml, llms.txt and robots.txt from it. Build, dev server and `check` all use it, so the files cannot drift from the routes.
- **Head tags are injected** before `</head>` rather than requiring layouts to call a helper. Any tag the layout already writes is left alone, so no duplicates and no silent overrides.
- **Nothing invented**: tags and JSON-LD fields appear only when backed by config or frontmatter. No auto breadcrumbs (they would have to match visible UI). No `lastmod` from file mtimes.
- **robots.txt** is neutral by default (`User-agent: *` / `Disallow:`). AI groups are opt-in and split into training vs search, using tokens from provider docs recorded in `src/discovery/crawlers.ts` (verified 2026-10-23). User-initiated fetchers (ChatGPT-User, Claude-User) are excluded because the providers say robots.txt may not apply to them.
- **Hand-written `public/robots.txt` etc. is an error**, not silently overwritten.
- **Redirects** are static meta-refresh pages (noindex, canonical to target). Static hosts need host-specific config for real 301s; that belongs to deploy adapters (Phase 5).
- **`site` must be an origin.** Base paths are rejected until links and assets support them.
- **`vage check`** renders in memory (no `dist/` writes). Errors exit 1; `--strict` also fails on warnings. Each rule links official docs where one exists.
- **HTML inspection** uses `node-html-parser`, not regex.

### Phase 2 limitations

- No sitemap index; more than 50,000 URLs is an explicit error.
- No hreflang/alternate-language links yet.
- Accessibility checks are basic (lang, alt, link text, image dimensions); full automated testing is Phase 4.

## Phase 3: AI-agent support

- **`vage info --json`** is generated from the live cac command list and the Zod schemas (`z.toJSONSchema`), so it cannot drift. Field docs live in `.describe()` on the schemas.
- **Generated projects** get `AGENTS.md` (agent-neutral) and a one-line `CLAUDE.md` that imports it, so the guidance stays agent-neutral.
- **Agent workflow test** (`tests/e2e.test.ts`): discover via `info`, add a page, hit a broken link, fix it from the `check` finding, build. This is a scripted simulation of an agent, not an LLM in the loop.
- **MCP deferred**: the CLI plus `--json` covers the same operations. Add MCP once the command surface is stable.

## Phase 4: performance and accessibility

- **`vage audit`** builds, measures every page (HTML + referenced local JS/CSS/images/fonts, including fonts/images from CSS `url()`), and runs axe-core in jsdom. Sizes are uncompressed; transfer size depends on the host.
- **Severity**: axe critical/serious = error; moderate/minor, budget misses and lab scores = warning. `--strict` fails on warnings. External API failures are warnings unless `--strict`, so outages and noisy lab runs don't block builds by default.
- **jsdom 28, not 30**: jsdom 29 and 30 require Node ≥22.13 / ≥22.22.2; 28 matches our `>=22.12` floor. Revisit when the floor rises. Layout-dependent axe rules (color contrast etc.) can't be decided in jsdom and are reported as "needs review", not as passes.
- **Lighthouse is an optional peer dependency** (~19 MB, needs Chrome), loaded from the user's project only with `--lighthouse` / `performance.lighthouse.enabled`. It audits the local preview server.
- **Deployed URLs**: PageSpeed Insights v5 for lab data; **CrUX API for field data**, because Google's PSI docs (checked 2026-10-23) say CrUX field data in PSI is planned for discontinuation. Field metrics: LCP, INP, CLS at p75, rated with web.dev thresholds (2.5 s / 200 ms / 0.1). URL-level data falls back to origin-level.
- **API keys** come from env (`PAGESPEED_API_KEY`, `CRUX_API_KEY`), are sent as the `x-goog-api-key` header (never in URLs), and are redacted from all error text. Retries: 3 attempts, 1 s / 2 s backoff on 429/5xx/network errors.
- **The audit module is lazy-loaded** by the CLI, so jsdom doesn't slow other commands.

### Phase 4 verification status

- Local Lighthouse: verified with a real run (Lighthouse 13.5.0, Chrome, 2026-10-23); CI runs it on Ubuntu.
- PageSpeed Insights live: the keyless call hit Google's shared daily quota (HTTP 429), which verified the error path only. The success path, the CrUX API and header-based key auth are tested against mocks of the documented response shapes, not live. Verify with a real key before relying on them.
- CrUX "no data" is assumed to be HTTP 404 (not specified in the docs).

## Not implemented (planned in later phases)

Analytics, Search Console, GitHub publishing, deployment, MCP server.
