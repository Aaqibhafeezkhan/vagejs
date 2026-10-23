# Security policy

## Reporting a vulnerability

Please report security issues **privately**. Don't open a public issue, pull request or discussion.

Use GitHub's private reporting: on this repository, go to **Security → Report a vulnerability**. Only the maintainers can see the report.

Please include:

- affected version (`vage --version`) and command or feature
- steps to reproduce, or a proof of concept
- the impact you expect (what an attacker gains)

We aim to acknowledge reports within 3 business days and to agree a fix and disclosure timeline with you. We credit reporters in the release notes unless you prefer otherwise.

## Supported versions

VAGE JS is pre-release (0.x). Security fixes go into the latest 0.x release only.

## Scope and trust model

In scope:

- HTML/script injection from page content (Markdown, frontmatter) into built sites, discovery files (`robots.txt`, `sitemap.xml`, `llms.txt`) or headers
- the dev and preview servers exposing files or redirecting off-site
- secrets leaking into build output, commits, logs or error messages
- argument or command injection through CLI options and generated commands
- weaknesses in the Google OAuth flow or API-key storage

Out of scope, by design:

- `vage.config.ts`, layouts and installed packages are **trusted code**: they run when you build. Only run `vage` on projects you trust.
- `markdown: { html: "allow" }` and `security: { csp: "off" }` deliberately disable protections.
- Vulnerabilities in third-party services (Google, Cloudflare, Plausible, Clarity) should go to those vendors.

See the "Security review" section of `docs/DECISIONS.md` for past findings and fixes.
