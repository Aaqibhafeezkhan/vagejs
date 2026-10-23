# AGENTS.md — VAGE JS framework repo

- Spec: `VAGE_JS_BUILD_SPEC.md`. Decisions: `docs/DECISIONS.md`. Current phase: **2 complete**; stop and report at the end of each phase.
- Layout: `src/cli` (cac commands), `src/core` (config, routes, render, build, Vite loader), `src/content` (Markdown/frontmatter), `src/dev` (dev + preview servers), `src/seo` (head tags, JSON-LD), `src/discovery` (robots/sitemap/llms, crawler registry), `src/checks` (`vage check`), `templates/starter` (scaffold; `_gitignore` is renamed on create).
- Commands: `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`.
- Tests use `tests/fixtures/basic`, copied to a temp dir per test. Never mutate the fixture in place.
- Do not publish to npm (`private: true` is deliberate), push to a remote, or add real credentials.
- Document only behavior that exists; keep `templates/starter/AGENTS.md` in sync with the code.
