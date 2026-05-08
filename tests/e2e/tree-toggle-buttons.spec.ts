import { expect, Page, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import { waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

/**
 * Reset the PR's viewed state to "no files viewed" by clicking every Viewed
 * toggle that's currently flipped on. GitHub remembers viewed state per
 * user/PR; tests must start from a known baseline.
 */
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

test.describe('per-row tree toggle buttons', () => {
  test('every tree row gets a toggle button; clicking marks underlying diff viewed', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('small-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);
    await resetAllToNotViewed(page);
    await page.waitForTimeout(1000);

    const initial = await page.evaluate(() => ({
      treeItems: document.querySelectorAll('[role="treeitem"]').length,
      buttons: document.querySelectorAll('.ghpr-tree-viewed-toggle').length,
      decoratedFiles: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])[data-ghpr-viewed="1"]').length,
    }));
    expect(initial.buttons, 'one button per tree item').toBe(initial.treeItems);
    expect(initial.decoratedFiles, 'baseline: no files viewed').toBe(0);

    // Click the first FILE row's toggle button — it should mark that file
    // viewed in the underlying diff.
    await page.click('[role="treeitem"]:not([aria-expanded]) > .ghpr-tree-viewed-toggle', { force: true });
    await page.waitForTimeout(1500);

    const afterFile = await page.evaluate(() => ({
      decoratedFiles: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])[data-ghpr-viewed="1"]').length,
      viewedDiffs: document.querySelectorAll('[id^="diff-"][data-targeted] [aria-label="Viewed"]').length,
      // The script's own visibility behaviour mustn't have changed: clicking
      // our toggle bubbles to GitHub's diff button, NOT to the row link, so
      // we should still be looking at the same file (not navigated away).
      url: location.href,
    }));
    expect(afterFile.decoratedFiles, 'one file decorated').toBe(1);
    expect(afterFile.viewedDiffs, 'one diff flipped to Viewed').toBe(1);
  });

  test('folder toggle button marks every descendant file as viewed in one click', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);
    await resetAllToNotViewed(page);
    await page.waitForTimeout(1500);

    const before = await page.evaluate(() => ({
      decoratedFiles: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])[data-ghpr-viewed="1"]').length,
      decoratedFolders: document.querySelectorAll('[role="treeitem"][aria-expanded][data-ghpr-viewed="1"]').length,
    }));
    expect(before.decoratedFiles).toBe(0);
    expect(before.decoratedFolders).toBe(0);

    // Click the folder's toggle button.
    await page.click('[role="treeitem"][aria-expanded] > .ghpr-tree-viewed-toggle', { force: true });
    await page.waitForTimeout(2500);

    const after = await page.evaluate(() => ({
      decoratedFiles: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])[data-ghpr-viewed="1"]').length,
      decoratedFolders: document.querySelectorAll('[role="treeitem"][aria-expanded][data-ghpr-viewed="1"]').length,
      viewedDiffs: document.querySelectorAll('[id^="diff-"][data-targeted] [aria-label="Viewed"]').length,
    }));
    expect(after.decoratedFiles, 'all files decorated').toBe(fx.expectedFileCount);
    expect(after.decoratedFolders, 'folder rolled up to viewed').toBeGreaterThanOrEqual(1);
    expect(after.viewedDiffs, 'every diff flipped to Viewed').toBe(fx.expectedFileCount);

    // Click the folder button again — should un-mark all files.
    await page.click('[role="treeitem"][aria-expanded] > .ghpr-tree-viewed-toggle', { force: true });
    await page.waitForTimeout(2500);

    const undone = await page.evaluate(() => ({
      decoratedFiles: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])[data-ghpr-viewed="1"]').length,
      decoratedFolders: document.querySelectorAll('[role="treeitem"][aria-expanded][data-ghpr-viewed="1"]').length,
    }));
    expect(undone.decoratedFiles, 'files un-marked').toBe(0);
    expect(undone.decoratedFolders, 'folder no longer rolled up').toBe(0);
  });
});
