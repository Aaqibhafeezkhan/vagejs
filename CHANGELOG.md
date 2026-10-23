# Changelog

## 0.2.0 (unreleased)

Fixes found by building [vagejs.com](https://vagejs.com) with vagejs.

### Added
- **Lists of pages in layouts.** Layouts receive `pages` (every published page: route, url, title, description, frontmatter), and `collection(pages, { under, sort, limit })` picks a section and orders it (`"date"`, `"title"`, `"route"` or your own function). Blog indexes and sidebars no longer need hand-kept lists.
- **`html` template tag** with automatic escaping, plus `raw()` for trusted markup such as `content`. Arrays are joined; `null`, `undefined` and `false` render nothing. Plain template strings still work.
- **Layout field schemas.** A layout can `export const frontmatter = z.object({ ... })` (`z` is re-exported from `vagejs`). Pages using it are validated strictly: unknown or mistyped fields fail the build, naming the file. Defaults are filled in.
- **`frontmatter-empty` check.** `vage check` warns about frontmatter values that came out empty, such as text split by a comma inside `{ }`.
- **Image dimensions.** Markdown images from `public/` get `width` and `height` read from the file (PNG, JPEG, GIF, WebP, SVG), `decoding="async"`, and `loading="lazy"` after the first image.
- **Cloudflare Workers target.** `deploy.target: "cloudflare-workers"` (and `deploy.cloudflareWorker`) uploads a new version and switches all traffic to it, so custom domains stay up; a new Worker gets a first `wrangler deploy`. A project `wrangler.jsonc` is used when present. `_headers` and `_redirects` are written for both Cloudflare targets.

### Changed
- The name is written **vagejs** everywhere (CLI output, docs, templates).
- The starter's default layout uses `html` and `raw(content)`.
- The Cloudflare Pages target explains Cloudflare's move of new projects to Workers when a deploy fails for that reason.
- Rule pack 2026.10.0: reviewer name written as "Venkatesh A G E". No rules or sources changed, so the pack version (and existing pins) stay the same.

### Not yet
- Image resizing and WebP/AVIF conversion.

## 0.1.0 (2026-10-23)

First release.
