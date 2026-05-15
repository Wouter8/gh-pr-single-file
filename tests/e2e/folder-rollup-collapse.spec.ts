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
