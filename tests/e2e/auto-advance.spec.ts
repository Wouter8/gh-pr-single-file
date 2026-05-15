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
