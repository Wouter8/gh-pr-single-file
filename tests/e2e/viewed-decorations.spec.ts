import { expect, Page, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import { waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

async function resetAllToNotViewed(page: Page): Promise<void> {
  // Click every "Viewed" toggle to flip it back to "Not Viewed". GitHub
  // remembers viewed state per user/PR; tests must start from a known state.
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(
      document.querySelectorAll('[id^="diff-"][data-targeted] [aria-label="Viewed"]'),
    ) as HTMLElement[];
    buttons.forEach((b) => b.click());
    return buttons.length;
  });
  if (clicked > 0) {
    // Give the UI time to flip labels back.
    await page.waitForTimeout(800);
  }
}

test.describe('viewed decorations', () => {
  test('file tree shows viewed status; folder rolls up when all files viewed', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('small-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    // GitHub remembers viewed state per user / per PR — previous test runs may
    // have left files in the "Viewed" state. Reset to a known-clean baseline.
    await resetAllToNotViewed(page);
    await page.waitForTimeout(1500);

    // Initially no files should be marked viewed.
    const initial = await page.evaluate(() => ({
      fileItems: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])').length,
      folders: document.querySelectorAll('[role="treeitem"][aria-expanded]').length,
      decoratedFiles: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])[data-ghpr-viewed="1"]').length,
      decoratedFolders: document.querySelectorAll('[role="treeitem"][aria-expanded][data-ghpr-viewed="1"]').length,
    }));
    expect(initial.fileItems, 'tree file count').toBe(fx.expectedFileCount);
    expect(initial.folders, 'at least one folder in tree').toBeGreaterThanOrEqual(1);
    expect(initial.decoratedFiles, 'no decorated files at start').toBe(0);
    expect(initial.decoratedFolders, 'no decorated folders at start').toBe(0);

    // Mark every file as viewed.
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(
        document.querySelectorAll('[id^="diff-"][data-targeted] [aria-label="Not Viewed"]'),
      ) as HTMLElement[];
      buttons.forEach((b) => b.click());
      return buttons.length;
    });
    expect(clicked, '"Not Viewed" buttons clicked').toBe(fx.expectedFileCount);
    await page.waitForTimeout(1500);

    const allViewed = await page.evaluate(() => ({
      decoratedFiles: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])[data-ghpr-viewed="1"]').length,
      decoratedFolders: document.querySelectorAll('[role="treeitem"][aria-expanded][data-ghpr-viewed="1"]').length,
      // Sanity: GitHub's per-diff label flipped to "Viewed".
      diffsStillNotViewed: document.querySelectorAll('[id^="diff-"][data-targeted] [aria-label="Not Viewed"]').length,
    }));
    expect(allViewed.diffsStillNotViewed, 'no remaining "Not Viewed" buttons').toBe(0);
    expect(allViewed.decoratedFiles, 'all files decorated').toBe(fx.expectedFileCount);
    expect(allViewed.decoratedFolders, 'folder rolled up to viewed').toBeGreaterThanOrEqual(1);

    // Un-view one file → folder rollup must drop.
    await page.evaluate(() => {
      const v = document.querySelector('[id^="diff-"][data-targeted] [aria-label="Viewed"]') as HTMLElement;
      v?.click();
    });
    await page.waitForTimeout(1200);

    const oneRemoved = await page.evaluate(() => ({
      decoratedFiles: document.querySelectorAll('[role="treeitem"]:not([aria-expanded])[data-ghpr-viewed="1"]').length,
      decoratedFolders: document.querySelectorAll('[role="treeitem"][aria-expanded][data-ghpr-viewed="1"]').length,
    }));
    expect(oneRemoved.decoratedFiles, 'one file demoted').toBe(fx.expectedFileCount - 1);
    expect(oneRemoved.decoratedFolders, 'folder no longer rolled up').toBe(0);
  });
});
