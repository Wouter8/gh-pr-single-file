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
