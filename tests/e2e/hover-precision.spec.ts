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

test.describe('tree row hover precision', () => {
  test('hovering a file inside a folder does not reveal the folder row toggle', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

    // GitHub persists BOTH viewed-state and tree expand/collapse state per
    // user/PR. A prior spec (folder-rollup-collapse) marks every file viewed
    // and collapses every folder; that state survives into this spec. A
    // viewed folder's toggle is opacity:1 via the viewed-state CSS rule
    // (independent of hover), which would mask the hover behaviour tested
    // here. Establish a clean baseline: clear viewed-state, then expand all
    // folders.
    await resetAllToNotViewed(page);
    await page.waitForTimeout(1500);

    // Expand every collapsed folder (repeat until stable, since expanding a
    // parent can reveal still-collapsed children).
    for (let pass = 0; pass < 5; pass++) {
      const collapsed = await page.evaluate(() => {
        const els = Array.from(
          document.querySelectorAll('[role="treeitem"][aria-expanded="false"]'),
        ) as HTMLElement[];
        els.forEach((el) => el.click());
        return els.length;
      });
      if (collapsed === 0) break;
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(500);

    // Find an expanded folder that has at least one direct child file row.
    const target = await page.evaluate(() => {
      const folders = Array.from(
        document.querySelectorAll('[role="treeitem"][aria-expanded="true"]'),
      ) as HTMLElement[];
      for (const folder of folders) {
        const folderId = folder.id;
        if (!folderId) continue;
        const prefix = folderId + '/';
        const files = Array.from(
          document.querySelectorAll('[role="treeitem"]:not([aria-expanded])'),
        ) as HTMLElement[];
        const child = files.find((f) => {
          if (!f.id || !f.id.startsWith(prefix)) return false;
          return f.id.indexOf('/', prefix.length) === -1;
        });
        if (child) return { folderId, childId: child.id };
      }
      return null;
    });
    expect(target, 'fixture must have an expanded folder with a direct child file').not.toBeNull();

    // Hover the child file row. Tree-item ids are repo-relative paths
    // (slashes, dots) so use a quoted attribute selector, NOT `#id`
    // (and CSS.escape isn't available in the Node test context anyway).
    await page.hover(`[role="treeitem"][id="${target!.childId}"]`);
    // Tiny delay to let :hover apply.
    await page.waitForTimeout(150);

    const opacities = await page.evaluate(({ folderId, childId }) => {
      const folder = document.querySelector(`[role="treeitem"][id="${folderId}"]`)!;
      const child = document.querySelector(`[role="treeitem"][id="${childId}"]`)!;
      const folderBtn = folder.querySelector(':scope > .ghpr-tree-viewed-toggle') as HTMLElement | null;
      const childBtn = child.querySelector(':scope > .ghpr-tree-viewed-toggle') as HTMLElement | null;
      const cs = (el: HTMLElement | null) => (el ? Number(getComputedStyle(el).opacity) : -1);
      return { folder: cs(folderBtn), child: cs(childBtn) };
    }, target!);

    expect(opacities.child, 'file row button visible while hovered').toBeGreaterThan(0.5);
    expect(opacities.folder, 'folder row button hidden while a descendant is hovered').toBeLessThan(0.5);
  });
});
