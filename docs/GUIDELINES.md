# Guideline monitoring and rule-pack releases

vagejs's behavior depends on facts that providers publish and sometimes change: AI crawler tokens, Core Web Vitals thresholds, GA4 naming limits, the consent-mode call order, the sitemap URL limit, and the GitHub Pages workflow. These facts live in one versioned file, **`src/guidelines/rule-pack.json`**. Each rule there lists:

- `sources`: official documentation it relies on (registered in `sources`, with URL and check cadence)
- `implementedIn`: code that uses it
- `behaviorChanging`: whether a change alters crawler access, indexing, privacy, security or build output
- `data`: the values the code reads at runtime (code never hard-codes them)

`vage guidelines` shows the pack in use. Projects can pin it with `guidelines: { rulePack: "<version>" }`. A pinned project's build fails after a vagejs upgrade that ships a different pack, until the owner reviews the changelog and updates the pin.

## What the monitor does

`.github/workflows/guidelines.yml` runs `scripts/guidelines-monitor.mjs` daily (daily sources every day, weekly sources on Mondays). It:

1. Fetches each source in English and splits the main content into sections by heading.
2. Compares section hashes with `guidelines/snapshots.json`. **Only headings and hashes are stored**, never the documents' text; the live page is the evidence.
3. Writes `guidelines/reports/<date>.md`: changed, added and removed sections, moves, unreachable or unreadable pages, the affected rules, and whether human review is required.
4. Optionally (`--classify`, when `ANTHROPIC_API_KEY` is set) asks Claude (`claude-opus-5-5`, structured output, server-side refusal fallback) for a **draft** classification of each changed section: informative, recommended, required, deprecated or unclear. Page text is passed as untrusted data. The output is labeled "not authoritative".
5. Opens a GitHub issue with the report.

It **never** edits the rule pack, commits, or releases. Sources marked `"monitor": "manual"` (pages that can't be read automatically, such as Bing's client-rendered guidelines) are listed in every report for manual checks.

## Updating the rule pack (human-reviewed)

1. Read the changed sources yourself. Don't rely on the draft classification, blog posts, or a model's memory.
2. Edit `src/guidelines/rule-pack.json` (data, sources, or a moved URL).
3. Bump `version` (`YYYY.M.patch`) and append a `changelog` entry with `date`, `summary`, `reviewedBy` (a named person, not "pending") and the new `contentHash`. `npm test` prints the hash to use and fails until the entry matches.
4. Run `npm test`. Golden outputs in `tests/golden/` show the effect on generated files. If the change is intended, run `UPDATE_GOLDEN=1 npm test` and review the diff in the PR.
5. Get review on the PR. Rules with `behaviorChanging: true` need sign-off from the owner. Protect `main` so this is enforced.
6. Release. Then accept the new baseline: `npm run guidelines:monitor -- --all --update` and commit `guidelines/snapshots.json`.

Commands:

```bash
npm run guidelines:monitor -- --all              # check everything now; exit 2 = changes found
npm run guidelines:monitor -- --only openai-bots
npm run guidelines:monitor -- --all --classify   # + draft LLM classification (Anthropic credentials)
npm run guidelines:monitor -- --all --update     # accept the current state as baseline
```
