import { expect, test } from '@playwright/test';
import { FILE_WRAPPER_SELECTOR, getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import { visibleCount, waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

test.describe('on-page toggle', () => {
  test('toggling the on-page checkbox off restores all files visible', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('small-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    const beforeVisible = await visibleCount(page);
    expect(beforeVisible, 'visible before toggle').toBe(1);

    const totalWrappers = await page.locator(FILE_WRAPPER_SELECTOR).count();
    expect(totalWrappers, 'wrappers on small-pr').toBeGreaterThanOrEqual(2);

    await page.click('#ghpr-single-file-toggle-input');
    await page.waitForTimeout(400);

    const afterVisible = await visibleCount(page);
    expect(afterVisible, 'visible after disabling').toBe(totalWrappers);

    await page.click('#ghpr-single-file-toggle-input');
    await page.waitForTimeout(400);

    const finalVisible = await visibleCount(page);
    expect(finalVisible, 'visible after re-enabling').toBe(1);
  });
});
