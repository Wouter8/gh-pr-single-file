# GitHub Files-changed DOM dependencies

Snapshot of which DOM elements `github-pr-single-file.user.js` depends on, with
evidence and stability assessments. **Update this file the moment a test
asserts a different selector after a GitHub UI change.**

---

## GitHub serves two UI variants

GitHub redirects the path between two URLs depending on viewer state:

| Path | Served when | DOM flavour |
| ---- | ----------- | ----------- |
| `/pull/N/files` | Logged-out viewers, classic UI feature flag | Stimulus-controlled server-rendered HTML with `<copilot-diff-entry>` wrappers |
| `/pull/N/changes` | Logged-in default since the Jan 2026 rollout | React app rooted at `<react-app>`, CSS-module-hashed class names |

The userscript matches **both** paths via `@match` and supports **both** DOM
flavours via fallback selector chains. When you write a new test, navigate to
`/pull/N/files` — GitHub will redirect to `/changes` if appropriate for the
session, and our code handles either landing.

---

## Inspection contexts

| When                                      | Auth                | Final URL    | DOM flavour observed |
| ----------------------------------------- | ------------------- | ------------ | -------------------- |
| 2026-05-07, `cli/cli/pull/13326/files`    | logged-out          | `/files`     | classic              |
| 2026-05-07, `Wouter8/.../pull/2/files`    | logged-out          | `/files`     | classic              |
| 2026-05-08, `Wouter8/.../pull/2/changes`  | logged-in (saved)   | `/changes`   | new (React)          |

Re-run with: `npx ts-node scripts/inspect-dom.ts <pr-files-or-changes-url> [--auth=.auth/github.json]`

---

## Selectors the userscript depends on

### S1 — Per-file diff element

The userscript hides per-file diffs by setting `data-ghpr-hidden="1"` on a
target element and applying CSS `display: none !important`. It tries the
following selectors in order until one yields >0 matches:

1. **`[id^="diff-"][data-targeted]`** — the New UI's diff element.
   - Each file's diff has `id="diff-<sha>"`, `class="Diff-module__diffTargetable__... Diff-module__diff__..."`, `data-targeted="false"`, `data-estimated-height="<n>"`, `role="region"`, `aria-labelledby`.
   - Direct child of a `.PullRequestDiffsList-module__diffEntry__<hash>` wrapper which has only this one child, so hiding the inner diff visually collapses the wrapper.
   - The CSS-module class hashes (`__pirZi`, `__rx9XH`, `__djnVa`) churn on every deploy. We deliberately do NOT depend on them. We pick the diff element by *attributes*, not classes.
   - Evidence: `.dom-inspection/diff-containers.json` (entries 3+ in the new-UI sample).

2. **`copilot-diff-entry`** — the Old UI's per-file wrapper.
   - Custom element, exactly one per file.
   - Direct ancestor of the inner `div.file.js-file[id="diff-<sha>"]`.
   - Evidence: classic UI inspections.

3. **`[data-targets="diff-file-filter.diffEntries"]`** — Stimulus-target attribute on the inner div in the Old UI.

4. **`div.file.js-file[id^="diff-"]`** — the inner div itself in the Old UI.

The CSS rule mirrors this list:

```css
[id^="diff-"][data-targeted][data-ghpr-hidden="1"],
copilot-diff-entry[data-ghpr-hidden="1"],
[data-targets="diff-file-filter.diffEntries"][data-ghpr-hidden="1"],
div.file.js-file[id^="diff-"][data-ghpr-hidden="1"]
{ display: none !important; }
```

### S2 — `#diff-<sha>` URL contract (both UIs)

- The fragment a file is addressable by is `#diff-<long-hex-sha>`.
- The element with that id is either the Old UI's `div.file.js-file` or the New UI's `[data-targeted]` diff.
- File-tree links in **both** UIs use the same `href="#diff-<sha>"` format.

🟢 Stability: very high — this is a public deep-link contract.

### S3 — File-tree anchors

Tree-row anchors live inside:

- New UI: `[role="tree"][aria-label="File Tree"]` containing `[role="treeitem"][aria-label="<filename>"]` rows. Each row has an `<a href="#diff-<sha>" class="fgColor-default prc-Link-Link-...">`.
- Old UI: `nav[aria-label="File Tree Navigation"]` containing `<a class="ActionList-content hx_ActionList-content" href="#diff-<sha>">`.

Tests find a tree link with `[role="tree"] a[href^="#diff-"], nav[aria-label="File Tree Navigation"] a[href^="#diff-"]`.

### S4 — How navigation actually fires (this changed!)

In the **Old UI**, clicking a tree link did a hash navigation, which fires the standard `hashchange` event. In the **New UI**, React intercepts the click and updates the URL via `history.replaceState` — which **does NOT fire `hashchange` or `popstate`**.

Userscript countermeasure (`patchHistoryMethods()` in the source):

```js
['pushState', 'replaceState'].forEach(name => {
  const original = history[name];
  history[name] = function () {
    const result = original.apply(this, arguments);
    applyVisibility();           // re-evaluate after URL change
    return result;
  };
});
```

Plus a 300 ms `location.hash` poll as a last-resort fallback. Plus `hashchange` and `popstate` listeners which still fire for genuine navigations.

🟡 Stability risk: if GitHub starts using a different routing primitive (URL Pattern API, etc.), the patching trick breaks. The polling fallback would still cover hash-only URL changes.

### S5 — "Viewed" / "Not Viewed" toggle (resilience test only)

For test 6 (mark-as-viewed survives) we need to find and click the per-file Viewed control:

- New UI: `[aria-label="Not Viewed"]` button (10 instances on a 10-file PR — one per file).
- Old UI: `input[name="viewed"]` or `.js-reviewed-toggle`.

The userscript itself does NOT depend on this — it simply must not break it. The selectors above are used only by the test.

---

## Selectors the userscript deliberately does NOT depend on

| Selector                                              | Why we avoid it                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `.PullRequestDiffsList-module__diffEntry__djnVa`      | CSS-module class hash — churns every deploy.                                 |
| `.Diff-module__diffTargetable__pirZi`                 | Same.                                                                        |
| `[id^="diff-"]` *unconstrained*                       | Matches non-file-diff elements like `diff-comparison-viewer-container`, `diff-file-tree-filter`, `diff-content`. |
| `[data-testid="progressive-diffs-list"] > div > *`    | Brittle structural path. Can use as last-resort discovery, but our own selectors are stronger. |
| Generated/utility class names (`tmp-mt-4`, etc.)      | Tailwind-style utility classes churn frequently.                             |
| The "Mark as viewed" checkbox class                   | We must not block its click handlers. We never query for it from the script. |
| `J` / `K` keyboard shortcut handlers                  | GitHub owns these. We do not register conflicting bindings.                  |

---

## Stability summary

| Layer                                                               | Risk |
| ------------------------------------------------------------------- | ---- |
| `#diff-<sha>` URL contract                                          | 🟢 low |
| `[id^="diff-"][data-targeted]` on New UI                            | 🟡 medium — `data-targeted` could be renamed; we have 3 fallbacks |
| `copilot-diff-entry` on Old UI                                      | 🟡 medium — could be renamed |
| `nav[aria-label="File Tree Navigation"]` / `[role="tree"]`          | 🟢 low (we don't depend, just observe) |
| `history.replaceState` interception                                 | 🟡 medium — depends on GitHub continuing to use replaceState |

If a test against a fixture PR fails after a GitHub UI rollout, the
likely-culprit-order is:

1. `data-targeted` renamed → S1 falls back further down the chain; check `.dom-inspection/candidates.json` for the new attribute.
2. `copilot-diff-entry` renamed → same fallback chain catches it.
3. URL `/changes` path renamed → update both `@match` and `isFilesPage()` regex.
4. Hash format changes (e.g. `#file-<...>` instead of `#diff-<...>`) → update `getCurrentTargetId()`.

Run `npx ts-node scripts/inspect-dom.ts <url> --auth=.auth/github.json`
against the failing fixture, compare to the entries above, and update both
`SELECTORS.md` and the `SELECTORS` constant in
`src/github-pr-single-file.user.js` together.
