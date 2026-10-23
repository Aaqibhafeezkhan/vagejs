# AGENTS.md — VAGE JS framework repo

- Spec: `VAGE_JS_BUILD_SPEC.md`. Decisions: `docs/DECISIONS.md`. Current phase: **8 complete** (all spec phases implemented; see docs/DECISIONS.md for what is verified live vs mocked); stop and report at the end of each phase.
- Layout: `src/cli` (cac commands), `src/core` (config, routes, render, build, Vite loader), `src/content` (Markdown/frontmatter), `src/dev` (dev + preview servers), `src/seo` (head tags, JSON-LD), `src/discovery` (robots/sitemap/llms, crawler registry), `src/checks` (`vage check`), `src/cli/info.ts` (`vage info --json`), `src/audit` (budgets, axe, Lighthouse, PSI/CrUX), `src/deploy` (safe git publish, secret scan, GitHub Pages), `src/integrations` (analytics tags, Google OAuth, GSC/GA4 reports, shared HTTP), `src/guidelines` (rule pack + monitor core), `scripts/` (maintainer monitor and classifier), `templates/starter` (scaffold; `_gitignore` is renamed on create).
- Commands: `npm run typecheck`, `npm test`, `npm run test:e2e`, `npm run build`. Real Lighthouse test: `VAGE_TEST_LIGHTHOUSE=1 npx vitest run tests/audit.test.ts`.
- Tests use `tests/fixtures/basic`, copied to a temp dir per test. Never mutate the fixture in place.
- Do not publish to npm (`private: true` is deliberate), push to a remote, or add real credentials. Deploy tests use local bare repos and a fake `gh` runner only.
- Document only behavior that exists; keep `templates/starter/AGENTS.md` in sync with the code.
- Provider facts live in `src/guidelines/rule-pack.json`, never hard-coded. Changing it needs a version bump, a changelog entry with a named reviewer, and golden updates (`UPDATE_GOLDEN=1 npm test`). See `docs/GUIDELINES.md`.
