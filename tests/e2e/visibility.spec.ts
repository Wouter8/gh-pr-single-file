import { expect, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import { collectInnerIds, visibleCount, visibleIds, waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

test.describe('initial state', () => {
  test('exactly one file is visible on small-pr (no hash)', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('small-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    const visible = await visibleCount(page);
    expect(visible, 'visible wrapper count').toBe(1);
  });
});

test.describe('hash respected on load', () => {
  test('navigating with a #diff-<sha> shows that specific file', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');

    // First load: peek at the wrapper IDs that GitHub generates for this PR.
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    const allIds = await collectInnerIds(page);
    expect(allIds.length, 'wrappers seen on medium-pr').toBeGreaterThanOrEqual(2);

    const target = allIds[Math.floor(allIds.length / 2)];

    // Reload with the hash baked into the URL.
    await page.goto(`${fx.filesUrl}#${target}`, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    const visible = await visibleIds(page);
    expect(visible.length, 'visible wrapper count').toBe(1);
    expect(visible[0], 'visible wrapper inner id').toBe(target);
  });
});

test.describe('file tree click', () => {
  test('clicking a tree link switches the visible file', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    // The tree's anchor markup differs between UIs, but in both, the href
    // takes the form "#diff-<sha>" and the link lives inside an element with
    // role=treeitem (new UI) or aria-label "File Tree Navigation" (old UI).
    const treeLinks = await page.$$eval(
      '[role="tree"] a[href^="#diff-"], nav[aria-label="File Tree Navigation"] a[href^="#diff-"]',
      (els) =>
        els.map((a) => ({
          href: (a as HTMLAnchorElement).getAttribute('href'),
          text: (a.textContent ?? '').trim(),
        })),
    );
    expect(treeLinks.length, 'tree links').toBeGreaterThanOrEqual(2);

    const targetIndex = Math.min(2, treeLinks.length - 1);
    const targetHash = treeLinks[targetIndex].href!;
    const targetId = targetHash.replace(/^#/, '').replace(/[?].*$/, '');

    await page.click(
      `[role="tree"] a[href="${targetHash}"], nav[aria-label="File Tree Navigation"] a[href="${targetHash}"]`,
    );
    await waitForUserscriptToSettle(page);

    const visible = await visibleIds(page);
    expect(visible.length, 'visible wrapper count after click').toBe(1);
    expect(visible[0], 'visible wrapper inner id after click').toBe(targetId);
  });
});
