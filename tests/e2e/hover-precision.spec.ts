import { expect, test } from '@playwright/test';
import { getFixture, injectUserscriptForTest } from '../helpers/inject-userscript';
import { waitForUserscriptToSettle, waitForWrappersToRender } from '../helpers/visibility';

test.describe('tree row hover precision', () => {
  test('hovering a file inside a folder does not reveal the folder row toggle', async ({ page }) => {
    await injectUserscriptForTest(page);

    const fx = getFixture('medium-pr');
    await page.goto(fx.filesUrl, { waitUntil: 'domcontentloaded' });
    await waitForWrappersToRender(page, 2);
    await waitForUserscriptToSettle(page);

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
