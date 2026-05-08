import { expect, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest, FILE_WRAPPER_SELECTOR } from '../helpers/inject-userscript';
import { collectInnerIds, visibleIds, waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

// (small style note) every test in this file uses the small-pr or medium-pr
// fixture — they're the cheapest navigations.

test.describe('hashchange', () => {
  test('programmatic hash change switches the visible file', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    const allIds = await collectInnerIds(page);
    expect(allIds.length, 'wrappers seen').toBeGreaterThanOrEqual(2);

    const initialVisible = await visibleIds(page);
    expect(initialVisible.length).toBe(1);
    const targetId = allIds.find((id) => id !== initialVisible[0])!;
    expect(targetId, 'a different id to switch to').toBeTruthy();

    await page.evaluate((id: string) => {
      window.location.hash = '#' + id;
    }, targetId);
    await page.waitForTimeout(400);

    const visibleAfter = await visibleIds(page);
    expect(visibleAfter.length, 'after hashchange').toBe(1);
    expect(visibleAfter[0], 'after hashchange id').toBe(targetId);
  });
});

test.describe('SPA tab navigation', () => {
  test('script activates after navigating Conversation → Files via Turbo / pushState (no hard refresh)', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('small-pr');
    // Land on the Conversation tab (no /files in URL). Userscript should load
    // but stay inactive — no toggle UI visible yet.
    const conversationUrl = fx.url; // ".../pull/N", without /files
    await page.goto(conversationUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const beforeNav = await page.evaluate(() => ({
      loaded: (window as any).__ghPrSingleFile?.loaded,
      active: (window as any).__ghPrSingleFile?.active,
      toggleInDom: !!document.getElementById('ghpr-single-file-toggle'),
    }));
    expect(beforeNav.loaded, 'script loaded on conversation tab').toBe(true);
    expect(beforeNav.active, 'NOT active on conversation tab').not.toBe(true);
    expect(beforeNav.toggleInDom, 'no toggle on conversation tab').toBe(false);

    // Click the "Files changed" tab — GitHub uses an SPA navigation here.
    // We must use Playwright's page.click (which dispatches a real Event
    // sequence) — `link.click()` from page.evaluate fires only the native
    // click event, which React's synthetic-event system happily ignores, so
    // the navigation never happens.
    const tabHref = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href]')).find((el) =>
        /\/pull\/\d+\/(files|changes)(?:[/?#]|$)/.test((el as HTMLAnchorElement).href),
      ) as HTMLAnchorElement | undefined;
      return a?.getAttribute('href') ?? null;
    });
    expect(tabHref, '"Files changed" link must exist on the conversation tab').toBeTruthy();
    await page.click(`a[href="${tabHref}"]`);
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    const afterNav = await page.evaluate(() => ({
      url: location.href,
      active: (window as any).__ghPrSingleFile?.active,
      toggleInDom: !!document.getElementById('ghpr-single-file-toggle'),
      lastWrapperCount: (window as any).__ghPrSingleFile?.lastWrapperCount,
    }));
    expect(afterNav.active, 'active after SPA nav').toBe(true);
    expect(afterNav.toggleInDom, 'toggle present after SPA nav').toBe(true);
    expect(afterNav.lastWrapperCount, 'wrappers detected').toBeGreaterThan(0);

    const visible = await visibleIds(page);
    expect(visible.length, 'exactly one file visible after SPA nav').toBe(1);
  });
});

test.describe('mark-as-viewed survives', () => {
  test('clicking the "Viewed" checkbox does not unhide other files', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('small-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    const beforeVisible = await visibleIds(page);
    expect(beforeVisible.length, 'one visible before').toBe(1);

    // The "Viewed" / "Not Viewed" toggle on the new UI is exposed as
    // aria-label="Not Viewed" (button) inside the visible diff. The old UI
    // uses class "js-reviewed-toggle" or input[name="viewed"].
    const viewedClicked = await page.evaluate((selectorList: string) => {
      const wrappers = Array.from(document.querySelectorAll(selectorList));
      const visible = wrappers.find((el) => getComputedStyle(el as Element).display !== 'none');
      if (!visible) return { ok: false, reason: 'no visible wrapper' };

      const candidates: Array<HTMLElement | null> = [
        visible.querySelector('[aria-label="Not Viewed"]') as HTMLElement | null,
        visible.querySelector('[aria-label="Viewed"]') as HTMLElement | null,
        visible.querySelector('input[name="viewed"]') as HTMLInputElement | null,
        visible.querySelector('.js-reviewed-toggle') as HTMLElement | null,
      ];
      const target = candidates.find(Boolean);
      if (!target) return { ok: false, reason: 'viewed control not found in visible wrapper' };
      (target as HTMLElement).click();
      return { ok: true };
    }, FILE_WRAPPER_SELECTOR);

    if (!viewedClicked.ok) {
      throw new Error(`Could not click viewed checkbox: ${viewedClicked.reason}`);
    }

    await page.waitForTimeout(2000);

    const afterVisible = await visibleIds(page);
    expect(afterVisible.length, 'still exactly one visible after toggling Viewed').toBe(1);
  });
});
