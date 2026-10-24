# Contributing to vagejs

Thanks for helping. vagejs is a young project, so bug reports, docs fixes and small features all make a real difference.

## Ways to help

- **Report a bug** with the [bug template](https://github.com/agevenkat/vagejs/issues/new?template=bug_report.yml). Include your OS, Node.js version and the command you ran.
- **Ask a question or share an idea** in [Discussions](https://github.com/agevenkat/vagejs/discussions).
- **Pick an issue** labeled [good first issue](https://github.com/agevenkat/vagejs/labels/good%20first%20issue) or [help wanted](https://github.com/agevenkat/vagejs/labels/help%20wanted). Comment on it first so nobody else starts the same work.
- **Improve the docs**: the website's docs live in a separate repository, so open an issue here describing the change and we'll update them.
- **Security issues** go to private reporting, never public issues: see [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 22.12 or newer and git.

```bash
git clone https://github.com/agevenkat/vagejs.git
cd vagejs
npm install
npm run typecheck
npm test            # unit and integration tests
npm run test:e2e    # packs vagejs, creates a site, installs it and builds it
```

To try your change on a real site, run `npm run build`, then use `node /path/to/vagejs/dist/cli/index.js <command>` inside a test project.

## Making a change

1. Read [AGENTS.md](AGENTS.md) for how the code is organized, and [docs/DECISIONS.md](docs/DECISIONS.md) for why things are the way they are.
2. Keep the change focused: one fix or feature per pull request.
3. Add or update tests. Tests copy `tests/fixtures/basic` to a temporary folder; never change the fixture in place.
4. Update the docs in the same pull request when behavior changes: `README.md`, `templates/starter/AGENTS.md` (what AI assistants read in every new site) and `CHANGELOG.md` under "Unreleased".
5. Run `npm run typecheck`, `npm test` and `npm run test:e2e` before opening the pull request. CI runs them on Windows, macOS and Linux.

### Facts about other services

Crawler names, size limits and other facts that come from Google, Cloudflare, OpenAI and similar providers live in `src/guidelines/rule-pack.json`, never in code. Changing it needs a version bump, a changelog entry with a named reviewer, and updated golden files (`UPDATE_GOLDEN=1 npm test`). See [docs/GUIDELINES.md](docs/GUIDELINES.md). Link the provider's official documentation in your pull request.

## Writing style

Docs and messages use plain English: short sentences, active voice, no jargon where a common word works. Error messages say what went wrong and how to fix it, and name the file when there is one.

## Be kind

Be respectful and assume good intent. Criticism of code is welcome; criticism of people isn't. The maintainer may remove comments or block people who make the project unwelcoming.
