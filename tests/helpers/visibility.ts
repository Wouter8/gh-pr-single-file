import type { Page } from '@playwright/test';
import { FILE_WRAPPER_SELECTOR } from './inject-userscript';

/**
 * Helpers shared between specs. Centralised so when a GitHub UI rollout
 * forces a selector change, we update one place.
 */

export async function waitForUserscriptToSettle(page: Page) {
  await page.waitForTimeout(4000);
}

/**
 * Wait until the page actually shows file diff wrappers (the userscript can't
 * hide what hasn't rendered yet). The new-UI React app may not have rendered
 * the diff list at DOMContentLoaded.
 */
export async function waitForWrappersToRender(page: Page, minimum = 1, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await page.locator(FILE_WRAPPER_SELECTOR).count();
    if (n >= minimum) return n;
    await page.waitForTimeout(250);
  }
  return page.locator(FILE_WRAPPER_SELECTOR).count();
}

export async function collectInnerIds(page: Page): Promise<string[]> {
  return page.evaluate((sel: string) => {
    const out: string[] = [];
    document.querySelectorAll(sel).forEach((w) => {
      // For the new UI, the wrapper IS the [id^="diff-"] element. For the
      // old UI (copilot-diff-entry), the id is on a descendant.
      const el = w as HTMLElement;
      const id = el.id?.startsWith('diff-')
        ? el.id
        : (w.querySelector('[id^="diff-"]') as HTMLElement | null)?.id;
      if (id) out.push(id);
    });
    return out;
  }, FILE_WRAPPER_SELECTOR);
}

export async function visibleIds(page: Page): Promise<string[]> {
  return page.evaluate((sel: string) => {
    function isVisible(el: Element): boolean {
      const view = (el as HTMLElement).ownerDocument.defaultView!;
      const cs = view.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      let cur: Element | null = (el as HTMLElement).parentElement;
      while (cur) {
        const pc = view.getComputedStyle(cur);
        if (pc.display === 'none' || pc.visibility === 'hidden') return false;
        cur = cur.parentElement;
      }
      return true;
    }
    const wrappers = Array.from(document.querySelectorAll(sel));
    const seen = new Set<string>();
    const out: string[] = [];
    wrappers.forEach((w) => {
      if (!isVisible(w)) return;
      const el = w as HTMLElement;
      const id = el.id?.startsWith('diff-')
        ? el.id
        : (w.querySelector('[id^="diff-"]') as HTMLElement | null)?.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    });
    return out;
  }, FILE_WRAPPER_SELECTOR);
}

export async function visibleCount(page: Page): Promise<number> {
  return (await visibleIds(page)).length;
}
