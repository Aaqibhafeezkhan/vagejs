# Releasing vagejs to npm

Two packages are published together, always with the same version:

| Package | What users run |
| --- | --- |
| `vagejs` | the framework and the `vage` CLI |
| `create-vagejs` | `npm create vagejs@latest my-site` (calls `vage create`) |

Publishing is **public and permanent**: a version number can never be reused, even after unpublishing. `npm publish` runs typecheck, all tests and the end-to-end tests first (`prepublishOnly`), and stops if anything fails.

## Before the first release

1. **npm account**: create one at <https://www.npmjs.com/signup> and enable two-factor authentication (Account → Two-Factor Authentication → "Authorization and writes").
2. **Log in on this machine:**
   ```bash
   npm login
   npm whoami        # should print your npm username
   ```
3. **Push the repo to GitHub, then record its URL in both packages.** npm uses it for links and to show README images:
   ```bash
   REPO=https://github.com/<owner>/<repo>
   npm pkg set repository.type=git repository.url="git+$REPO.git" bugs.url="$REPO/issues"
   (cd packages/create-vagejs && npm pkg set repository.type=git repository.url="git+$REPO.git" repository.directory=packages/create-vagejs bugs.url="$REPO/issues")
   ```
4. **Open items to settle first:**
   - `SECURITY.md`: turn on GitHub private vulnerability reporting (repo Settings → Security), and optionally add a vagejs.com contact address.

## First release (manual, from your machine)

npm's trusted publishing can only be set up on a package that already exists, so 0.1.0 is published by hand:

```bash
npm publish --dry-run                             # rehearsal: tests + package contents, uploads nothing
npm publish                                       # asks for your 2FA code
cd packages/create-vagejs && npm publish && cd ../..
```

Check it worked:

```bash
npm view vagejs version
npm view create-vagejs version
cd /tmp && npm create vagejs@latest test-site && cd test-site && npm install && npm run build
```

## How releases are published now

The owner publishes each release by hand from their own Terminal (`npm publish` in the repo root, then in `packages/create-vagejs`), after the version commit is pushed and CI is green. The version tag (`vX.Y.Z`) and GitHub release are created afterwards, once npm shows the new version. The `Release` workflow below is **disabled** in GitHub Actions (since 0.16.1), because a tag push after a manual publish made it fail with "cannot publish over the previously published version". To switch to publishing from CI instead, run `gh workflow enable Release` and stop publishing by hand; the tag push then publishes with provenance.

## Automated releases (workflow kept, currently disabled)

The workflow publishes from GitHub Actions (`.github/workflows/release.yml`). It uses **trusted publishing**: npm trusts that workflow directly, so no npm token is stored anywhere, and npm adds a signed provenance record automatically (public repo and package).

One-time setup:

1. On npmjs.com, for **each** package (`vagejs`, `create-vagejs`): Settings → Trusted Publisher → GitHub Actions →
   your GitHub user or org, the repository name, workflow `release.yml`, environment `npm`.
   A new trusted publisher must complete its first publish within 2 days, so set this up right before your next release.
2. Then, for each package: Settings → Publishing access → "Require two-factor authentication and disallow tokens".
3. In GitHub, repo Settings → Environments → New environment `npm` → add yourself as a required reviewer. Every release then waits for your approval.

To release a new version (for example 0.1.1):

```bash
npm version 0.1.1 --no-git-tag-version
(cd packages/create-vagejs && npm version 0.1.1 --no-git-tag-version && npm pkg set dependencies.vagejs=0.1.1)
git commit -am "Release 0.1.1"
git tag v0.1.1
git push origin main --tags
```

The workflow checks that the tag and both package versions match, runs the full test suite, waits for your approval, then publishes `vagejs` and `create-vagejs`.

## Versioning

- `0.x`: breaking changes are allowed in minor versions (0.1 → 0.2); say so in the release notes.
- Bump the version whenever behavior changes, including rule-pack changes (projects may pin `guidelines.rulePack`).

## If something goes wrong

- **Bad release:** publish a fixed patch version, then mark the bad one:
  `npm deprecate vagejs@0.1.1 "Broken: use 0.1.2"`. Prefer this over unpublishing, which npm allows only within 72 hours and only with no dependents.
- **Leaked npm token:** revoke it on npmjs.com → Access Tokens. With trusted publishing there are no long-lived tokens to leak.
