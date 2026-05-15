# File-tree improvements — design

Date: 2026-05-15
Scope: `src/github-pr-single-file.user.js` (single-file userscript)

## Problem statement

Four behavioural issues in the v0.10.0 userscript:

1. Folder viewed-decoration is lost when the user collapses the folder in the file tree.
2. The folder-row hover ✓ button appears whenever the user hovers any descendant tree row, not only when hovering the folder row itself.
3. After certain PR actions (placing or deleting a review comment), the single-file view snaps back to the first file, forcing the user to re-select the file they were reviewing.
4. There is no "open next file in this folder" behaviour after marking a file as viewed; the user has to navigate manually.

## Goals

- Preserve the user's reviewing position and visual state across PR actions and tree-collapses.
- Make hover affordances precise: the ✓ button only shows on the row the cursor is actually over.
- Speed up the review flow: marking the current file as viewed advances to the next sibling automatically.

## Non-goals

- No new persistent storage (no localStorage extension). All state stays in JS memory for the session.
- No behaviour change while single-file mode is disabled (toggle off). Auto-navigate only fires when single-file mode is on.
- No change to the GitHub-native "Viewed" mechanism itself; we read its state and click its controls.

## Design

### 1. Folder viewed-state survives collapse

**Cause.** `syncViewedDecorations()` rolls up folder state by iterating live `[role="treeitem"]` file rows. When the user collapses a folder, GitHub removes its descendant file rows from the DOM, so `descendantsTotal === 0` and the folder loses its `VIEWED_ATTR`.

**Fix.** Maintain a session-level cache `api.treeFileCache: Map<path, diffId>`. Every `syncViewedDecorations` run that observes file rows refreshes the cache. Folder rollup iterates over cache entries whose path starts with `folder.id + '/'`, looks up viewed-status in `viewedById` (built from the diff-DOM `aria-label`s, independent of the tree), and decorates the folder accordingly.

Cache lifetime: process memory for the session. On `ensureInactive` we leave it alone; on the next active page the IDs naturally apply or get overwritten. No serialisation needed.

Rollup semantics stay the same: folder is `viewed=1` iff every cached descendant file has a known `viewedById` value AND all are `true`. If any descendant is missing from `viewedById` (diff not yet rendered) the folder is conservatively `viewed=0`.

### 2. Hover does not propagate from descendants

**Cause.** `:hover` matches the element under the cursor and all its ancestors. A `[role="treeitem"]:hover` rule therefore also fires on every ancestor tree row, including the parent folder.

**Fix.** Tighten the hover selector with `:not(:has(...))`:

```css
[role="treeitem"]:hover:not(:has([role="treeitem"]:hover)) > .ghpr-tree-viewed-toggle,
[role="treeitem"][data-ghpr-viewed="1"] > .ghpr-tree-viewed-toggle {
  opacity: 1;
}
```

Only the deepest hovered treeitem lacks a hovered treeitem descendant, so only its button shows. Already-viewed rows still show their button via the second selector.

### 3. Last-known target preserved across non-diff hash changes

**Cause.** When the user posts or deletes a comment, GitHub navigates the URL hash to e.g. `#issuecomment-12345` and re-renders the diff list. The MutationObserver fires; `applyVisibility` calls `getCurrentTargetId()` which returns `null` because the hash is no longer `#diff-…`; the fallback then picks `wrappers[0]`.

**Fix.** Inside `applyVisibility`, when `getCurrentTargetId()` returns `null`:

1. If `api.lastTargetId` is set and that diffId still exists in the current `wrappers`, use it.
2. Otherwise fall back to `wrappers[0]` (existing behaviour).

`api.lastTargetId` is already written at the end of every successful `applyVisibility`; only the read path needs updating.

### 4. Auto-open next sibling on mark-as-viewed

**Detection.** In `syncViewedDecorations`, compare the freshly-built `viewedById` against `api.prevViewedById` from the previous run. For each diffId where prev was `false` (or missing) and current is `true`, that is a "marked as viewed" transition. Store the new map onto `api.prevViewedById` before returning.

**Decide whether to navigate.** A transition triggers auto-navigate iff all of:

- `!api.disabled` (single-file mode is on).
- `getCurrentTargetId() === diffId` (the file being marked is the one currently visible).
- A next sibling exists in the same direct parent folder.

This naturally handles all the cases the user covered:
- Folder-bulk via our ✓ button → many transitions in one run, but only the one matching the visible file (if any) qualifies.
- Marking via our tree ✓ button on a non-visible file → fails the "current target" check, nothing happens.
- Native checkbox in the visible file's header → qualifies.
- Unmark (true → false) → not a forward transition, ignored.

**Find next sibling.** Look up the path for `diffId` via the `treeFileCache` (or the live tree if not cached). Compute the direct parent prefix:

```
path "src/a/foo.ts"  → prefix "src/a/"
path "README.md"     → prefix ""    (root files)
```

Iterate `[role="treeitem"]:not([aria-expanded])` items in DOM order, skip until past the current file, then pick the first whose `id` starts with the prefix and contains no further `/` after the prefix. Resolve that row's `<a href="#diff-…">` to its diffId.

**Navigate.** Set `location.hash = '#' + nextDiffId`. Our `hashchange` listener already routes through `onUrlChange → ensureActive → applyVisibility`, which will swap the visible file. No additional scroll logic; the browser handles anchor scroll naturally.

**First-run guard.** On the very first `syncViewedDecorations` call after activation, `api.prevViewedById` is undefined. We must not interpret "every currently-viewed file" as a fresh transition. Treat the first run as initialisation: build `viewedById`, assign to `prevViewedById`, skip transition detection that run.

## Data flow summary

```
MutationObserver / hashchange
        │
        ▼
applyVisibility()            ──┐  uses api.lastTargetId fallback (#3)
                               │  writes api.lastTargetId at end
        │                      │
        ▼                      │
syncViewedDecorations()        │
  ├─ build viewedById          │
  ├─ refresh treeFileCache (#1)│
  ├─ decorate files            │
  ├─ roll up folders via cache (#1)
  ├─ detect transitions vs prevViewedById (#4)
  ├─ for each qualifying transition: navigate via location.hash (#4)
  └─ prevViewedById = viewedById
```

## Test plan

Existing Playwright suite under `tests/e2e/` should be extended:

- **#1**: Open PR with nested folders, mark all files in `src/a/` as viewed, collapse `src/a`, assert the folder row still has `data-ghpr-viewed="1"` and the green colour rule applies.
- **#2**: Hover a file row inside an expanded folder, assert the folder row's `.ghpr-tree-viewed-toggle` has `opacity: 0` while the file row's button has `opacity: 1`.
- **#3**: Simulate a hash change to `#issuecomment-1` while a non-first file is targeted; assert the visible diff is still the previously-targeted file, not `wrappers[0]`.
- **#4**: 
  - Mark current visible file as viewed via native checkbox → assert `location.hash` switches to the next sibling diffId.
  - Mark the last file in a folder as viewed → assert no hash change.
  - Use our folder ✓ to bulk-mark a folder containing the current visible file → assert hash switches to the next sibling.
  - Mark a non-visible file via tree ✓ → assert no hash change.
  - Disable single-file mode and repeat any of the above → assert no hash change.

## Risks

- `:has()` browser support: Safari ≥ 15.4, Chrome ≥ 105, Firefox ≥ 121. The existing stylesheet already uses `:has` (see `[data-testid="progressive-diffs-list"] > *:has(...)`); no new requirement.
- Cache memory: a `Map<path, diffId>` stays bounded by the PR's file count (typically <10⁴). Negligible.
- Auto-navigate could surprise users who mark via the native checkbox without intending to advance. Mitigations: only fires when current=visible (so user is clearly in flow), only goes to direct sibling, never crosses folder boundaries.

## Open questions

None at design time.
