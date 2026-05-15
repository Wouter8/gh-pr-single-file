# Tree-improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four behavioural issues in the file-tree review UX: lost folder viewed-state on collapse, leaky hover affordance, view-snap on PR actions, and missing auto-advance on mark-as-viewed.

**Architecture:** All changes land in the single-IIFE userscript at `src/github-pr-single-file.user.js`. We add a session `pathByDiffId` cache (used both for folder rollup and for next-sibling lookup), a `prevViewedById` snapshot for transition detection, and a `lastTargetId`-based fallback inside `applyVisibility`. One CSS rule is tightened with `:not(:has(...))`. New Playwright specs cover each behaviour against live fixture PRs.

**Tech Stack:** Vanilla ES5-style JavaScript (no build step). Playwright + TypeScript for end-to-end tests against live `github.com` PR fixtures.

---

## File Structure

**Modify:**
- `src/github-pr-single-file.user.js` — version bump + all four fixes.

**Create:**
- `tests/e2e/hover-precision.spec.ts` — covers fix #2 (hover affordance).
- `tests/e2e/view-stability.spec.ts` — covers fix #3 (last-target fallback).
- `tests/e2e/folder-rollup-collapse.spec.ts` — covers fix #1 (folder state survives collapse).
- `tests/e2e/auto-advance.spec.ts` — covers fix #4 (auto-advance on mark-as-viewed).

All four new spec files use the same Playwright + fixture conventions as existing specs (see `tests/e2e/viewed-decorations.spec.ts` for the canonical reference).

**Important context for the implementer:**

- Tests run against real GitHub PRs listed in `tests/fixtures/test-prs.json`. Each test takes 30–60 s due to live navigation + a 4 s settle. Don't try to shortcut with mocks.
- GitHub remembers viewed state per user/PR, so every test that touches viewed-state starts with a `resetAllToNotViewed(page)` helper (copied from existing specs — keep using that pattern).
- The userscript is written in ES5-style vanilla JS (`var`, function declarations, no arrow functions). Match the existing style.
- Touch nothing else (`scripts/`, `README.md`, fixtures) unless a step explicitly says so.

---

## Task 1: Version bump

**Files:**
- Modify: `src/github-pr-single-file.user.js` lines 4 and 69

- [ ] **Step 1: Update userscript metadata version**

In `src/github-pr-single-file.user.js`, change line 4 from:

```js
// @version      0.10.0
```

to:

```js
// @version      0.11.0
```

- [ ] **Step 2: Update runtime api.version**

In `src/github-pr-single-file.user.js`, change line 69 from:

```js
  api.version = '0.10.0';
```

to:

```js
  api.version = '0.11.0';
```

- [ ] **Step 3: Validate userscript metadata**

Run: `npx ts-node scripts/validate-userscript.ts`
Expected: exits 0, prints validation success.

- [ ] **Step 4: Commit**

```bash
git add src/github-pr-single-file.user.js
git commit -m "chore: bump userscript to v0.11.0"
```

---

## Task 2: Fix #2 — hover does not propagate from descendant tree rows

**Files:**
- Modify: `src/github-pr-single-file.user.js` lines 294–296 (the hover CSS rule inside `injectStyles()`)
- Create: `tests/e2e/hover-precision.spec.ts`

- [ ] **Step 1: Write the failing Playwright test**

Create `tests/e2e/hover-precision.spec.ts` with this content:

```ts
import { expect, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import { waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

test.describe('tree row hover precision', () => {
  test('hovering a file inside a folder does not reveal the folder row toggle', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    // Find an expanded folder that has at least one direct child file row.
    const target = await page.evaluate(() => {
      const folders = Array.from(
        document.querySelectorAll('[role="treeitem"][aria-expanded="true"]'),
      ) as HTMLElement[];
      for (const folder of folders) {
        const folderId = folder.id;
        if (!folderId) continue;
        const prefix = folderId + '/';
        const files = Array.from(
          document.querySelectorAll('[role="treeitem"]:not([aria-expanded])'),
        ) as HTMLElement[];
        const child = files.find((f) => {
          if (!f.id || !f.id.startsWith(prefix)) return false;
          return f.id.indexOf('/', prefix.length) === -1;
        });
        if (child) return { folderId, childId: child.id };
      }
      return null;
    });
    expect(target, 'fixture must have an expanded folder with a direct child file').not.toBeNull();

    // Hover the child file row. Tree-item ids are repo-relative paths
    // (slashes, dots) so use a quoted attribute selector, NOT `#id`
    // (and CSS.escape isn't available in the Node test context anyway).
    await page.hover(`[role="treeitem"][id="${target!.childId}"]`);
    // Tiny delay to let :hover apply.
    await page.waitForTimeout(150);

    const opacities = await page.evaluate(({ folderId, childId }) => {
      const folder = document.querySelector(`[role="treeitem"][id="${folderId}"]`)!;
      const child = document.querySelector(`[role="treeitem"][id="${childId}"]`)!;
      const folderBtn = folder.querySelector(':scope > .ghpr-tree-viewed-toggle') as HTMLElement | null;
      const childBtn = child.querySelector(':scope > .ghpr-tree-viewed-toggle') as HTMLElement | null;
      const cs = (el: HTMLElement | null) => (el ? Number(getComputedStyle(el).opacity) : -1);
      return { folder: cs(folderBtn), child: cs(childBtn) };
    }, target!);

    expect(opacities.child, 'file row button visible while hovered').toBeGreaterThan(0.5);
    expect(opacities.folder, 'folder row button hidden while a descendant is hovered').toBeLessThan(0.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/e2e/hover-precision.spec.ts`
Expected: FAIL on the `opacities.folder` assertion (the folder button has opacity 1 because of the leaky `:hover`).

- [ ] **Step 3: Tighten the hover selector**

In `src/github-pr-single-file.user.js`, find the block at lines 294–296:

```js
      '[role="treeitem"]:hover > .' + TREE_VIEWED_BTN_CLASS + ',' +
      ' [role="treeitem"][' + VIEWED_ATTR + '="1"] > .' + TREE_VIEWED_BTN_CLASS +
      ' { opacity: 1; }\n' +
```

Replace it with:

```js
      '[role="treeitem"]:hover:not(:has([role="treeitem"]:hover)) > .' + TREE_VIEWED_BTN_CLASS + ',' +
      ' [role="treeitem"][' + VIEWED_ATTR + '="1"] > .' + TREE_VIEWED_BTN_CLASS +
      ' { opacity: 1; }\n' +
```

The `:not(:has([role="treeitem"]:hover))` clause excludes ancestors when any descendant treeitem is also under the cursor — only the deepest hovered row qualifies.

- [ ] **Step 4: Re-run the test to verify it passes**

Run: `npx playwright test tests/e2e/hover-precision.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/github-pr-single-file.user.js tests/e2e/hover-precision.spec.ts
git commit -m "fix: hover affordance only shows on innermost hovered tree row"
```

---

## Task 3: Fix #3 — preserve last-known target across non-diff hash changes

**Files:**
- Modify: `src/github-pr-single-file.user.js` lines 186–191 (inside `applyVisibility`)
- Create: `tests/e2e/view-stability.spec.ts`

- [ ] **Step 1: Write the failing Playwright test**

Create `tests/e2e/view-stability.spec.ts` with this content:

```ts
import { expect, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import {
  collectInnerIds,
  visibleIds,
  waitForUserscriptToSettle,
  waitForWrappersToRender,
} from '../helpers/visibility';

test.describe('view stability', () => {
  test('non-diff hash change (e.g. comment anchor) keeps the previously-targeted file visible', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    const ids = await collectInnerIds(page);
    expect(ids.length, 'fixture has at least 3 files').toBeGreaterThanOrEqual(3);

    // Pick a file that is NOT the first; navigate to it.
    const targetDiff = ids[2];
    await page.evaluate((id) => {
      location.hash = '#' + id;
    }, targetDiff);
    await page.waitForTimeout(500);

    const beforeVisible = await visibleIds(page);
    expect(beforeVisible, 'targeted file is visible').toEqual([targetDiff]);

    // Simulate the hash change that happens when GitHub anchors to a comment.
    await page.evaluate(() => {
      location.hash = '#issuecomment-1';
    });
    // Wait for our hashchange listener + mutation observer to settle.
    await page.waitForTimeout(800);

    const afterVisible = await visibleIds(page);
    expect(afterVisible, 'visible file should not snap back to the first file').toEqual([targetDiff]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/e2e/view-stability.spec.ts`
Expected: FAIL — `afterVisible` is `[ids[0]]` because `applyVisibility` falls back to `wrappers[0]` when the hash is `#issuecomment-1`.

- [ ] **Step 3: Implement the last-target fallback**

In `src/github-pr-single-file.user.js`, find the block at lines 186–191 inside `applyVisibility`:

```js
    var targetId = getCurrentTargetId();
    if (!targetId) {
      var firstInner = getInnerDiffId(wrappers[0]);
      if (!firstInner) return false;
      targetId = firstInner;
    }
```

Replace it with:

```js
    var targetId = getCurrentTargetId();
    if (!targetId) {
      // No diff hash in the URL. This happens during PR actions like
      // anchor-navigation to a comment (#issuecomment-…) or the brief
      // moment after Turbo strips the hash. If we held a previous diff
      // target and it's still present in the diff list, stick with it.
      // Otherwise fall back to the first file (original behaviour).
      if (api.lastTargetId) {
        for (var p = 0; p < wrappers.length; p++) {
          if (getInnerDiffId(wrappers[p]) === api.lastTargetId) {
            targetId = api.lastTargetId;
            break;
          }
        }
      }
      if (!targetId) {
        var firstInner = getInnerDiffId(wrappers[0]);
        if (!firstInner) return false;
        targetId = firstInner;
      }
    }
```

`api.lastTargetId` is already written at the end of `applyVisibility` (line 204) so no other code changes are needed.

- [ ] **Step 4: Re-run the test to verify it passes**

Run: `npx playwright test tests/e2e/view-stability.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the broader test suite to confirm no regression**

Run: `npx playwright test tests/e2e/visibility.spec.ts tests/e2e/smoke.spec.ts tests/e2e/toggle.spec.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/github-pr-single-file.user.js tests/e2e/view-stability.spec.ts
git commit -m "fix: preserve last-targeted file across non-diff hash changes"
```

---

## Task 4: Fix #1 — folder viewed-state survives collapse via session cache

**Files:**
- Modify: `src/github-pr-single-file.user.js`
  - Add cache reset in `ensureInactive` (around line 137–162).
  - Refactor folder rollup loop in `syncViewedDecorations` (around lines 494–516).
- Create: `tests/e2e/folder-rollup-collapse.spec.ts`

- [ ] **Step 1: Write the failing Playwright test**

Create `tests/e2e/folder-rollup-collapse.spec.ts` with this content:

```ts
import { expect, Page, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import { waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

async function resetAllToNotViewed(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('[id^="diff-"][data-targeted] [aria-label="Viewed"]'),
    ) as HTMLElement[];
    buttons.forEach((b) => b.click());
    return buttons.length;
  });
  if (clicked > 0) await page.waitForTimeout(800);
}

test.describe('folder rollup survives collapse', () => {
  test('folder stays decorated as viewed after being collapsed in the tree', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);
    await resetAllToNotViewed(page);
    await page.waitForTimeout(1500);

    // Mark every file viewed.
    await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('[id^="diff-"][data-targeted] [aria-label="Not Viewed"]'),
      ) as HTMLElement[];
      buttons.forEach((b) => b.click());
    });
    await page.waitForTimeout(1800);

    const beforeCollapse = await page.evaluate(() => ({
      folderViewed: document.querySelectorAll('[role="treeitem"][aria-expanded][data-ghpr-viewed="1"]').length,
      expandedFolders: document.querySelectorAll('[role="treeitem"][aria-expanded="true"]').length,
    }));
    expect(beforeCollapse.folderViewed, 'folder rolled up before collapse').toBeGreaterThanOrEqual(1);
    expect(beforeCollapse.expandedFolders, 'fixture has expanded folders').toBeGreaterThanOrEqual(1);

    // Collapse every expanded folder by clicking it. Deepest first so a
    // parent collapse doesn't visually swallow a child.
    await page.evaluate(() => {
      const folders = Array.from(
        document.querySelectorAll('[role="treeitem"][aria-expanded="true"]'),
      ) as HTMLElement[];
      folders.sort((a, b) => {
        const la = parseInt(a.getAttribute('aria-level') || '0', 10);
        const lb = parseInt(b.getAttribute('aria-level') || '0', 10);
        return lb - la;
      });
      folders.forEach((el) => el.click());
    });
    await page.waitForTimeout(1500);

    const afterCollapse = await page.evaluate(() => ({
      folderViewed: document.querySelectorAll('[role="treeitem"][aria-expanded][data-ghpr-viewed="1"]').length,
      visibleFiles: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])').length,
    }));
    expect(afterCollapse.visibleFiles, 'file rows hidden by collapse').toBe(0);
    expect(afterCollapse.folderViewed, 'folder remains decorated as viewed after collapse').toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/e2e/folder-rollup-collapse.spec.ts`
Expected: FAIL — after collapse, `folderViewed` is 0 because the current rollup keys off live `fileItems` which are removed from the DOM when the folder closes.

- [ ] **Step 3: Initialise the path-cache and reset it on deactivation**

In `src/github-pr-single-file.user.js`, find this block in `ensureInactive` (around lines 137–162):

```js
  function ensureInactive() {
    api.active = false;
    if (document.body) document.body.removeAttribute('data-ghpr-active');
    var t = document.getElementById(TOGGLE_ID);
    if (t) t.remove();
    var b = document.getElementById(COLLAPSE_BTN_ID);
    if (b) b.remove();
```

Add a cache reset just below the `api.active = false;` line so the block reads:

```js
  function ensureInactive() {
    api.active = false;
    // Wipe session caches so a re-entry to /files (potentially after the
    // user changed viewed-state in another tab) starts fresh.
    api.pathByDiffId = Object.create(null);
    api.prevViewedById = null;
    if (document.body) document.body.removeAttribute('data-ghpr-active');
    var t = document.getElementById(TOGGLE_ID);
    if (t) t.remove();
    var b = document.getElementById(COLLAPSE_BTN_ID);
    if (b) b.remove();
```

(`prevViewedById = null` is forward-looking — Task 5 reads it as a first-run sentinel. Setting both here keeps the reset in one place.)

- [ ] **Step 4: Refactor `syncViewedDecorations` to populate the cache and roll up from it**

In `src/github-pr-single-file.user.js`, locate `syncViewedDecorations` (lines 440–517). Replace the whole function body (everything between `function syncViewedDecorations() {` and the matching closing `}` at line 517) with the version below. The diff vs. existing is: (a) we populate `api.pathByDiffId` while decorating files, (b) folder rollup iterates over the cache, not the live `fileItems`, and (c) we ensure `api.pathByDiffId` exists.

```js
  function syncViewedDecorations() {
    if (!document.body) return;
    if (!api.pathByDiffId) api.pathByDiffId = Object.create(null);

    // Step 1: build a {diffId → viewed} map from the diff entries on the page.
    var viewedById = Object.create(null);
    var diffs = document.querySelectorAll('[id^="diff-"][data-targeted]');
    if (diffs.length === 0) {
      diffs = document.querySelectorAll('copilot-diff-entry');
    }
    for (var i = 0; i < diffs.length; i++) {
      var d = diffs[i];
      var diffId;
      if (d.id && d.id.indexOf('diff-') === 0) {
        diffId = d.id;
      } else {
        var inner = d.querySelector('[id^="diff-"]');
        diffId = inner ? inner.id : null;
      }
      if (!diffId) continue;
      var hasViewed = !!d.querySelector('[aria-label="Viewed"]');
      var hasNotViewed = !!d.querySelector('[aria-label="Not Viewed"]');
      if (hasViewed && !hasNotViewed) viewedById[diffId] = true;
      else if (hasNotViewed && !hasViewed) viewedById[diffId] = false;
    }

    if (Object.keys(viewedById).length === 0) return;

    // Step 2: decorate file tree items + refresh the path cache.
    var allItems = document.querySelectorAll('[role="treeitem"]');
    for (var j = 0; j < allItems.length; j++) {
      var item = allItems[j];
      if (item.hasAttribute('aria-expanded')) continue; // folder
      var anchor = item.querySelector('a[href^="#diff-"]');
      if (!anchor) continue;
      var href = anchor.getAttribute('href') || '';
      var fileDiffId = href.slice(1).replace(/[?].*$/, '');
      // Remember path↔diffId for use after the folder is collapsed.
      if (item.id) api.pathByDiffId[fileDiffId] = item.id;
      var viewed = viewedById[fileDiffId];
      if (typeof viewed === 'boolean') {
        var want = viewed ? '1' : '0';
        if (item.getAttribute(VIEWED_ATTR) !== want) {
          item.setAttribute(VIEWED_ATTR, want);
        }
      }
    }

    // Step 3: roll up to folders via the path cache so the rollup survives
    // a collapse (when descendant file rows are removed from the DOM).
    for (var k = 0; k < allItems.length; k++) {
      var folder = allItems[k];
      if (!folder.hasAttribute('aria-expanded')) continue;
      if (!folder.id) continue;
      var prefix = folder.id + '/';
      var descendantsViewed = 0;
      var descendantsTotal = 0;
      for (var cachedDiffId in api.pathByDiffId) {
        var cachedPath = api.pathByDiffId[cachedDiffId];
        if (!cachedPath || cachedPath.indexOf(prefix) !== 0) continue;
        if (!(cachedDiffId in viewedById)) continue; // unknown → skip
        descendantsTotal++;
        if (viewedById[cachedDiffId] === true) descendantsViewed++;
      }
      if (descendantsTotal === 0) {
        if (folder.hasAttribute(VIEWED_ATTR)) folder.removeAttribute(VIEWED_ATTR);
        continue;
      }
      var folderWant = descendantsViewed === descendantsTotal ? '1' : '0';
      if (folder.getAttribute(VIEWED_ATTR) !== folderWant) {
        folder.setAttribute(VIEWED_ATTR, folderWant);
      }
    }
  }
```

- [ ] **Step 5: Re-run the new test to verify it passes**

Run: `npx playwright test tests/e2e/folder-rollup-collapse.spec.ts`
Expected: PASS.

- [ ] **Step 6: Re-run the existing viewed-decorations test to confirm no regression**

Run: `npx playwright test tests/e2e/viewed-decorations.spec.ts tests/e2e/tree-toggle-buttons.spec.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/github-pr-single-file.user.js tests/e2e/folder-rollup-collapse.spec.ts
git commit -m "fix: folder viewed-state survives tree collapse via path cache"
```

---

## Task 5: Fix #4 — auto-advance to next sibling on mark-as-viewed

**Files:**
- Modify: `src/github-pr-single-file.user.js`
  - Add `findNextSiblingDiffId` helper (anywhere in the function-declarations region, e.g. before `collapseAllFolders`).
  - Extend `syncViewedDecorations` to detect transitions and call the helper.
- Create: `tests/e2e/auto-advance.spec.ts`

- [ ] **Step 1: Write the failing Playwright test**

Create `tests/e2e/auto-advance.spec.ts` with this content:

```ts
import { expect, Page, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import { collectInnerIds, waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

async function resetAllToNotViewed(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('[id^="diff-"][data-targeted] [aria-label="Viewed"]'),
    ) as HTMLElement[];
    buttons.forEach((b) => b.click());
    return buttons.length;
  });
  if (clicked > 0) await page.waitForTimeout(800);
}

async function goToFile(page: Page, diffId: string): Promise<void> {
  await page.evaluate((id) => {
    location.hash = '#' + id;
  }, diffId);
  await page.waitForTimeout(400);
}

async function currentHashDiffId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const h = location.hash || '';
    if (h.indexOf('#diff-') !== 0) return null;
    const m = h.slice(1).match(/^(diff-[a-f0-9]+)/i);
    return m ? m[1] : null;
  });
}

async function diffIdsByFolder(page: Page): Promise<Record<string, string[]>> {
  // Returns { parentFolderPath: [diffIdInDomOrder, ...] }, restricted to
  // file tree rows currently in the DOM (the medium-pr fixture renders
  // all folders expanded by default).
  return page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll('[role="treeitem"]:not([aria-expanded])'),
    ) as HTMLElement[];
    const out: Record<string, string[]> = {};
    for (const row of rows) {
      const path = row.id;
      const anchor = row.querySelector('a[href^="#diff-"]') as HTMLAnchorElement | null;
      if (!path || !anchor) continue;
      const href = anchor.getAttribute('href') || '';
      const diffId = href.slice(1).replace(/[?].*$/, '');
      const lastSlash = path.lastIndexOf('/');
      const parent = lastSlash === -1 ? '' : path.slice(0, lastSlash);
      if (!out[parent]) out[parent] = [];
      out[parent].push(diffId);
    }
    return out;
  });
}

test.describe('auto-advance on mark-as-viewed', () => {
  test('marking current visible file via native checkbox advances to next sibling', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);
    await resetAllToNotViewed(page);
    await page.waitForTimeout(1500);

    const folders = await diffIdsByFolder(page);
    // Pick a folder that has at least 2 files.
    const folderWithSiblings = Object.keys(folders).find((k) => folders[k].length >= 2);
    expect(folderWithSiblings, 'fixture has a folder with ≥2 files').toBeDefined();
    const [first, second] = folders[folderWithSiblings!];

    await goToFile(page, first);
    expect(await currentHashDiffId(page)).toBe(first);

    // Click the native "Not Viewed" button inside the visible file.
    await page.evaluate((id) => {
      const diff = document.getElementById(id);
      const btn = diff?.querySelector('[aria-label="Not Viewed"]') as HTMLElement | null;
      btn?.click();
    }, first);
    await page.waitForTimeout(1500);

    expect(await currentHashDiffId(page), 'hash advanced to next sibling').toBe(second);
  });

  test('marking the last file in a folder does not change the hash', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);
    await resetAllToNotViewed(page);
    await page.waitForTimeout(1500);

    const folders = await diffIdsByFolder(page);
    const folderWithSiblings = Object.keys(folders).find((k) => folders[k].length >= 2);
    expect(folderWithSiblings).toBeDefined();
    const last = folders[folderWithSiblings!][folders[folderWithSiblings!].length - 1];

    await goToFile(page, last);
    expect(await currentHashDiffId(page)).toBe(last);

    await page.evaluate((id) => {
      const diff = document.getElementById(id);
      const btn = diff?.querySelector('[aria-label="Not Viewed"]') as HTMLElement | null;
      btn?.click();
    }, last);
    await page.waitForTimeout(1500);

    expect(await currentHashDiffId(page), 'hash unchanged for last file').toBe(last);
  });

  test('marking a non-visible file via tree ✓ button does not change the hash', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);
    await resetAllToNotViewed(page);
    await page.waitForTimeout(1500);

    const ids = await collectInnerIds(page);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    const visible = ids[0];
    const other = ids[1];

    await goToFile(page, visible);
    expect(await currentHashDiffId(page)).toBe(visible);

    // Click the tree ✓ on the OTHER row.
    await page.evaluate((diffId) => {
      const anchors = Array.from(
        document.querySelectorAll('[role="treeitem"]:not([aria-expanded]) a[href^="#diff-"]'),
      ) as HTMLAnchorElement[];
      const match = anchors.find((a) => (a.getAttribute('href') || '').indexOf('#' + diffId) === 0);
      const row = match?.closest('[role="treeitem"]') as HTMLElement | null;
      const btn = row?.querySelector(':scope > .ghpr-tree-viewed-toggle') as HTMLElement | null;
      btn?.click();
    }, other);
    await page.waitForTimeout(1500);

    expect(await currentHashDiffId(page), 'hash unchanged when marking a non-visible file').toBe(visible);
  });

  test('single-file mode disabled: native checkbox does not auto-advance', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);
    await resetAllToNotViewed(page);
    await page.waitForTimeout(1200);

    // Disable single-file mode.
    await page.evaluate(() => (window as any).__ghPrSingleFile.setDisabled(true));
    await page.waitForTimeout(500);

    const folders = await diffIdsByFolder(page);
    const folderWithSiblings = Object.keys(folders).find((k) => folders[k].length >= 2);
    expect(folderWithSiblings).toBeDefined();
    const [first] = folders[folderWithSiblings!];

    await goToFile(page, first);

    await page.evaluate((id) => {
      const diff = document.getElementById(id);
      const btn = diff?.querySelector('[aria-label="Not Viewed"]') as HTMLElement | null;
      btn?.click();
    }, first);
    await page.waitForTimeout(1500);

    expect(await currentHashDiffId(page), 'hash unchanged in disabled mode').toBe(first);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/e2e/auto-advance.spec.ts`
Expected: FAIL — auto-advance is not implemented yet; the first test fails because the hash does not advance.

- [ ] **Step 3: Add the `findNextSiblingDiffId` helper**

In `src/github-pr-single-file.user.js`, add this new function declaration. A natural spot is **immediately before** the existing `function collapseAllFolders()` declaration (line 599):

```js
  function findNextSiblingDiffId(diffId) {
    if (!api.pathByDiffId) return null;
    var path = api.pathByDiffId[diffId];
    if (!path) return null;
    var lastSlash = path.lastIndexOf('/');
    var prefix = lastSlash === -1 ? '' : path.slice(0, lastSlash + 1);
    // Walk tree file rows in DOM order; pick the first one AFTER `path`
    // whose id has the same direct parent (no extra slash after the prefix).
    var rows = document.querySelectorAll('[role="treeitem"]:not([aria-expanded])');
    var passed = false;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var rid = row.id;
      if (!rid) continue;
      if (!passed) {
        if (rid === path) passed = true;
        continue;
      }
      // Direct-sibling test.
      if (prefix === '') {
        if (rid.indexOf('/') !== -1) continue;
      } else {
        if (rid.indexOf(prefix) !== 0) continue;
        if (rid.indexOf('/', prefix.length) !== -1) continue;
      }
      var anchor = row.querySelector('a[href^="#diff-"]');
      if (!anchor) continue;
      var href = anchor.getAttribute('href') || '';
      return href.slice(1).replace(/[?].*$/, '');
    }
    return null;
  }
```

- [ ] **Step 4: Detect transitions and navigate inside `syncViewedDecorations`**

In `src/github-pr-single-file.user.js`, open `syncViewedDecorations` (the version written in Task 4). At the very end of the function — after the folder rollup loop, before the closing `}` — append this block:

```js
    // Step 4: detect "not viewed → viewed" transitions and auto-advance.
    // First run: just snapshot, never advance (otherwise every pre-viewed
    // file would look like a fresh transition).
    var prev = api.prevViewedById;
    api.prevViewedById = viewedById;
    if (!prev) return;
    if (api.disabled) return;

    var currentTargetId = getCurrentTargetId();
    if (!currentTargetId) return;
    // We only advance when the file being marked is the one the user is
    // currently looking at — see design doc, fix #4.
    if (viewedById[currentTargetId] !== true) return;
    if (prev[currentTargetId] === true) return; // not a fresh transition

    var nextDiffId = findNextSiblingDiffId(currentTargetId);
    if (!nextDiffId) return;
    if (nextDiffId === currentTargetId) return;
    try {
      location.hash = '#' + nextDiffId;
    } catch (_) {}
```

Note: `getCurrentTargetId` already strips suffixes; we re-use it here for consistency with how `applyVisibility` reads the URL.

- [ ] **Step 5: Re-run the new auto-advance suite to verify it passes**

Run: `npx playwright test tests/e2e/auto-advance.spec.ts`
Expected: all four cases PASS.

- [ ] **Step 6: Re-run prior specs to confirm no regression**

Run: `npx playwright test tests/e2e/viewed-decorations.spec.ts tests/e2e/tree-toggle-buttons.spec.ts tests/e2e/visibility.spec.ts tests/e2e/toggle.spec.ts tests/e2e/folder-rollup-collapse.spec.ts tests/e2e/view-stability.spec.ts tests/e2e/hover-precision.spec.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/github-pr-single-file.user.js tests/e2e/auto-advance.spec.ts
git commit -m "feat: auto-advance to next sibling in folder on mark-as-viewed"
```

---

## Task 6: Final integration check

**Files:** none modified.

- [ ] **Step 1: Run the full Playwright suite**

Run: `npx playwright test`
Expected: every spec under `tests/e2e/` PASSES.

- [ ] **Step 2: Validate the userscript metadata one more time**

Run: `npx ts-node scripts/validate-userscript.ts`
Expected: exits 0, no errors.

- [ ] **Step 3: Sanity-check the diff against the design**

Re-read `docs/superpowers/specs/2026-05-15-tree-improvements-design.md`. Confirm each numbered issue (#1–#4) has a corresponding code change:
- #1 → `api.pathByDiffId` populated in `syncViewedDecorations`; folder rollup iterates the cache.
- #2 → `:hover:not(:has(...))` clause in `injectStyles`.
- #3 → `api.lastTargetId` fallback inside `applyVisibility`.
- #4 → `findNextSiblingDiffId` + transition detection at the tail of `syncViewedDecorations`.

If any are missing, return to the corresponding task and complete it.

- [ ] **Step 4: No commit needed** unless a follow-up fix was required in Step 3.

---

## Notes for the implementer

- **First-run guard for #4**: `api.prevViewedById` starts as `null` (cleared in `ensureInactive`). The very first `syncViewedDecorations` call after activation sets it to the current `viewedById` and returns *before* the transition logic. That is intentional — without it, every already-viewed file on page load would look like a fresh transition and trigger a navigation.
- **Bulk folder ✓ click**: this fires many transitions in one MutationObserver batch, but only the one matching the currently-visible file qualifies for navigation — so bulk-marking a folder where the visible file lives produces exactly one advance (to that file's next sibling), and bulk-marking a folder that does NOT contain the visible file produces zero advances.
- **Cache lifetime**: `api.pathByDiffId` lives in `window.__ghPrSingleFile` and is wiped on `ensureInactive`. Within a session on a single PR, it grows monotonically as tree rows render; entries are never removed individually.
- **CSS `:has()` browser support**: Safari ≥ 15.4, Chrome ≥ 105, Firefox ≥ 121. The script already relies on `:has()` for the diff-list gap-collapse rule, so this introduces no new browser-support requirement.
