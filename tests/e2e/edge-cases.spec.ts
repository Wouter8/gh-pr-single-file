import { expect, test } from '@playwright/test';
import { FILE_WRAPPER_SELECTOR, getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import { collectInnerIds, visibleCount, visibleIds, waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

test.describe('edge cases', () => {
  test('deleted, renamed, binary, no-EOL, long-line files all rotate normally', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('edge-cases-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, fx.expectedFileCount);
    await waitForUserscriptToSettle(page);

    const allIds = await collectInnerIds(page);
    expect(allIds.length, 'wrappers seen on edge-cases-pr').toBe(fx.expectedFileCount);

    const initial = await visibleIds(page);
    expect(initial.length, 'initial visible count').toBe(1);

    for (const id of allIds) {
      await page.evaluate((target: string) => { window.location.hash = '#' + target; }, id);
      await page.waitForTimeout(250);
      const visible = await visibleIds(page);
      expect(visible.length, `visible count when hash=#${id}`).toBe(1);
      expect(visible[0], `visible id when hash=#${id}`).toBe(id);
    }
  });
});

test.describe('large PR coexistence', () => {
  test('script does not conflict with native auto single-file mode; toggle still works', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('large-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    // 65 files: GitHub's progressive renderer takes longer.
    await waitForWrappersToRender(page, 10, 30_000);
    await page.waitForTimeout(6000);

    const wrappersTotal = await page.locator(FILE_WRAPPER_SELECTOR).count();
    expect(wrappersTotal, 'wrappers on large-pr').toBeGreaterThanOrEqual(10);

    const visibleNow = await visibleCount(page);
    expect(visibleNow, 'visible on large-pr (single-file mode active)').toBe(1);

    // Disable our script via toggle; visible count must rise above 1.
    await page.click('#ghpr-single-file-toggle-input');
    await page.waitForTimeout(700);
    const visibleAfterDisable = await visibleCount(page);
    expect(visibleAfterDisable, 'visible after we disable').toBeGreaterThan(1);

    // None of our hide markers should remain set to "1".
    const stillHiddenByUs = await page.locator('[data-ghpr-hidden="1"]').count();
    expect(stillHiddenByUs, 'wrappers still hidden by our data-attr').toBe(0);

    // Re-enable; 1 visible again.
    await page.click('#ghpr-single-file-toggle-input');
    await page.waitForTimeout(700);
    const visibleAfterReEnable = await visibleCount(page);
    expect(visibleAfterReEnable, 'visible after re-enable').toBe(1);

    // Native J/K shortcuts: pressing J should not throw and should not be
    // intercepted by us. Just check our state is sane afterwards.
    const callCountBefore = await page.evaluate(() => (window as any).__ghPrSingleFile?.callCount);
    await page.keyboard.press('j');
    await page.waitForTimeout(400);
    const callCountAfter = await page.evaluate(() => (window as any).__ghPrSingleFile?.callCount);
    expect(typeof callCountAfter).toBe('number');
    expect(callCountAfter, 'callCount stays sensible after J').toBeGreaterThanOrEqual(callCountBefore);
  });
});
