import { expect, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';

const SCRIPT_NAME_NEEDLES = ['github-pr-single-file', 'ghpr', '__ghPrSingleFile'];

test.describe('smoke', () => {
  test('userscript injects on small-pr without console errors', async ({ page }) => {
    await injectUserscriptForTest(page);

    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (SCRIPT_NAME_NEEDLES.some((n) => text.includes(n))) {
          errors.push(text);
        }
      }
    });
    page.on('pageerror', (err) => {
      const text = `${err.name}: ${err.message}\n${err.stack ?? ''}`;
      if (SCRIPT_NAME_NEEDLES.some((n) => text.includes(n))) {
        errors.push(text);
      }
    });

    const fx = getFixture('small-pr');
    const response = await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    expect(response, 'navigation response').not.toBeNull();

    await page.waitForTimeout(3000);

    const loaded = await page.evaluate(() => (window as any).__ghPrSingleFile?.loaded);
    expect(loaded, 'userscript flag').toBe(true);

    expect(errors, 'console/pageerror with our script name').toEqual([]);
  });
});
