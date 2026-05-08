# github-pr-single-file

A userscript that brings Bitbucket-style **one-file-at-a-time** review UX to
GitHub's "Files changed" pages. Click a file in the file tree → only that file's
diff is visible. Everything else is hidden until you switch.

The userscript itself is plain JavaScript — no build step, no bundler, no
dependencies. It's installable into Tampermonkey/Violentmonkey by visiting the
raw URL.

## Install (for users)

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Edge/Firefox/Safari)
   or [Violentmonkey](https://violentmonkey.github.io/) in your browser.
2. **Click this link to install:**
   [`https://raw.githubusercontent.com/Wouter8/gh-pr-single-file/main/src/github-pr-single-file.user.js`](https://raw.githubusercontent.com/Wouter8/gh-pr-single-file/main/src/github-pr-single-file.user.js)
   Tampermonkey/Violentmonkey will detect the `.user.js` extension and the
   `// ==UserScript==` header and pop up an install prompt. Confirm to install.
3. Visit any GitHub PR's *Files changed* page. Only one file is visible. A
   small "Single-file mode" checkbox appears in the bottom-right; uncheck it
   to disable (state persists in `localStorage`). A "Collapse all" button
   appears in the file tree, useful for big PRs.

**Auto-updates:** the script header sets `@updateURL` and `@downloadURL` to
this repo's `main` branch raw URL. Tampermonkey checks for updates daily by
default — when the `@version` is bumped and pushed to `main`, your installed
copy updates itself within a day. Force a check via Tampermonkey dashboard →
script row → "Check for userscript updates" icon.

The userscript:

- Hides every file diff except the one matching `#diff-<sha>` in the URL.
- Falls back to the first file when no hash is present.
- Catches every URL update path: `hashchange`, `popstate`, **and**
  `history.pushState/replaceState` (the new GitHub UI uses `replaceState`,
  which silently bypasses `hashchange`).
- Uses a `MutationObserver` to re-apply visibility when GitHub re-renders
  (e.g. after marking a file as viewed).
- Supports both the **classic UI** (`/pull/N/files`) and the **new React UI**
  (`/pull/N/changes` — the default for logged-in users since Jan 2026).
- Does **not** intercept `J` / `K`, the "Mark as viewed" checkbox, or
  line-comment controls.

## Repository layout

```
github-pr-single-file/
├── src/
│   ├── github-pr-single-file.user.js   ← the deliverable
│   └── SELECTORS.md                    ← evidence + stability notes for every selector we depend on
├── tests/
│   ├── e2e/                            ← Playwright specs (one per concern)
│   ├── fixtures/test-prs.json          ← URLs of the fixture PRs the tests run against
│   └── helpers/
│       ├── inject-userscript.ts        ← loads .user.js into Playwright via addInitScript
│       ├── visibility.ts               ← shared selectors and visibility probes
│       └── save-auth.ts                ← one-time GitHub login → .auth/github.json
├── scripts/
│   ├── inspect-dom.ts                  ← Phase-0 DOM reconnaissance helper
│   ├── setup-fixture-prs.ts            ← idempotent fixture-branch + draft-PR creator
│   ├── fixture-content.ts              ← deterministic content generators used by setup-fixture-prs
│   └── validate-userscript.ts          ← ad-hoc end-to-end check against any public PR (cli/cli by default)
├── playwright.config.ts
├── package.json
└── tsconfig.json
```

## Development setup

Requires Node 20+ and `gh` CLI authenticated (`gh auth status` succeeds).

```sh
npm install
npx playwright install chromium

# One-time: capture an authenticated GitHub session for the test browser.
# Opens a real Chromium window — log in, then come back to the terminal.
# The result is saved to .auth/github.json (gitignored).
npx ts-node tests/helpers/save-auth.ts

# Create the fixture PRs in *this* repo if they don't already exist.
# Idempotent. See "Fixture PRs" below.
npx ts-node scripts/setup-fixture-prs.ts

# Run the test suite (Playwright Chromium against live GitHub).
npm test
```

> **Why the manual login step?** The new GitHub UI variant
> (`/pull/N/changes`) is only served to logged-in viewers. We capture a real
> login session once and cache it in `.auth/github.json` for the test browser
> to reuse. Re-run `save-auth.ts` if your tests start asserting against a
> "Sign in to GitHub" page — session cookies expire.

## Fixture PRs

The test suite runs against four open draft PRs in *this* repository, each
labelled `[FIXTURE — DO NOT MERGE]`. They are deliberately kept open and must
**never be merged or closed**.

| Branch | Files | Scenarios |
| ------ | ----- | --------- |
| `fixtures/small-pr` | 3 | base behaviour |
| `fixtures/medium-pr` | ~10 | file-tree clicks, hash-on-load |
| `fixtures/large-pr` | 65 | coexistence with GitHub's auto single-file mode |
| `fixtures/edge-cases-pr` | 6 | deleted, renamed, binary, no-EOL, very long single line |

`tests/fixtures/test-prs.json` records each PR's URL, number, expected file
count, and scenarios. Tests read from it; nothing is hardcoded.

### Re-creating fixtures from scratch

```sh
# Default: create any missing branches and PRs, leave existing ones alone.
npx ts-node scripts/setup-fixture-prs.ts

# Force-reset every fixture branch to the current generator output.
# Use this after editing scripts/fixture-content.ts. Existing PRs keep
# their numbers; their branches are force-pushed.
npx ts-node scripts/setup-fixture-prs.ts --update

# Print what would happen without making any changes.
npx ts-node scripts/setup-fixture-prs.ts --dry-run
```

The script also commits a small `__fixtures__/` directory to `main` on the
very first run. That directory contains the "before" state of files that the
edge-cases PR deletes or renames. Do not remove it; the edge-cases fixture
depends on it.

> **⚠️ DO NOT MERGE THE FIXTURE PRs.** They are not real changes. Merging
> them would dump the random fixture content (`__fixtures__/large-pr/*` etc.)
> into `main` and silently break the test suite. The PR titles are
> `[FIXTURE — DO NOT MERGE]` for exactly this reason.

## Tests

Each spec lives under `tests/e2e/`. They navigate live GitHub PRs and inject
the userscript via `addInitScript`. The same source we ship to users is what
the tests run against — byte for byte.

| Spec                     | Coverage                                                |
| ------------------------ | ------------------------------------------------------- |
| `smoke.spec.ts`          | Test 1: page loads, no console errors with our name     |
| `visibility.spec.ts`     | Tests 2–4: initial state, hash-on-load, tree click      |
| `resilience.spec.ts`     | Tests 5–6: programmatic hashchange, mark-as-viewed loop |
| `toggle.spec.ts`         | Test 7: on-page disable toggle                          |
| `edge-cases.spec.ts`     | Tests 8–9: edge cases, large-PR coexistence with native |

Tests retry up to 2× for network flakiness against github.com. Failures are
not silenced or skipped.

### Ad-hoc validation against any PR

`scripts/validate-userscript.ts` is a one-off sanity check that loads the
userscript against any public PR and verifies core behaviours (default
single-visible, hash navigation, tree click, toggle off / on). Useful when
you suspect a GitHub UI change but the fixture tests pass:

```sh
npx ts-node scripts/validate-userscript.ts                                # cli/cli/pull/13326 (default)
npx ts-node scripts/validate-userscript.ts https://github.com/<owner>/<repo>/pull/<n>/files
```

## Releasing a new version

1. Make changes in `src/github-pr-single-file.user.js`.
2. Bump `// @version` in the userscript header.
3. Run `npm test`; all 9 specs must pass.
4. Commit + push to `main`. Tampermonkey-installed users get the update on
   their next periodic check.

## When GitHub changes its DOM

Read [`src/SELECTORS.md`](src/SELECTORS.md). It documents:

- every CSS selector / DOM contract the userscript depends on,
- the evidence backing each selector (HTML excerpts captured from a real PR),
- the stability assessment (🟢 / 🟡 / 🔴),
- and the order in which selectors are likely to break.

The recommended workflow when a test fails after a GitHub UI rollout:

1. Re-run the reconnaissance script:
   `npx ts-node scripts/inspect-dom.ts <pr-files-or-changes-url> --auth=.auth/github.json`
2. Compare the new output (`.dom-inspection/`) to the assumptions in
   `SELECTORS.md`.
3. Update both `SELECTORS.md` and the `SELECTORS` constant in
   `src/github-pr-single-file.user.js` together.
4. Re-run the test suite.

## Limitations / known issues

- **Per-page toggle persistence is global.** The "Single-file mode" checkbox
  saves a single boolean in `localStorage`, applying to every PR you visit.
  Per-PR persistence is intentionally not implemented (and would be confusing
  to debug if it desynced).
- **No keyboard shortcut.** Toggling currently requires clicking the on-page
  checkbox. Adding `Shift+S` (or similar) is a possible follow-up but would
  need to coexist with GitHub's own bindings.
