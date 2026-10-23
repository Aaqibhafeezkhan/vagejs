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

## Not implemented (planned in later phases)

robots.txt, sitemap.xml, llms.txt, canonical/OG metadata, JSON-LD, `vage check`, audits, analytics, GitHub publishing, deployment, MCP.
