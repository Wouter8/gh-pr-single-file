#!/usr/bin/env ts-node
/**
 * Ad-hoc validation: load the userscript against a real public PR and assert
 * core behaviours. This is for human-driven development verification — the
 * production test suite (tests/e2e/) runs against fixture PRs.
 *
 * Usage: npx ts-node scripts/validate-userscript.ts [pr-files-url]
 *   default URL: https://github.com/cli/cli/pull/13326/files
 */

import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEFAULT_URL = 'https://github.com/cli/cli/pull/13326/files';
const USERSCRIPT_PATH = path.resolve(__dirname, '..', 'src', 'github-pr-single-file.user.js');

async function main() {
  const url = process.argv[2] ?? DEFAULT_URL;
  const source = fs.readFileSync(USERSCRIPT_PATH, 'utf-8');

  const browser = await chromium.launch();
  const context = await browser.newContext();
  await context.addInitScript({ content: source });
  const page = await context.newPage();

  page.on('pageerror', (err) => {
    console.error(`[validate] PAGEERROR: ${err.name}: ${err.message}\n${err.stack}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`[validate] CONSOLE.${msg.type().toUpperCase()}: ${msg.text()}`);
    }
  });

  console.log(`[validate] navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4_000); // let userscript timers fire

  const apiState = await page.evaluate(() => {
    const a = (window as any).__ghPrSingleFile;
    if (!a) return { loaded: false };
    return {
      loaded: a.loaded,
      version: a.version,
      callCount: a.callCount,
      lastReadyState: a.lastReadyState,
      lastWrapperCount: a.lastWrapperCount,
      lastTargetId: a.lastTargetId,
      wrappersSeen: typeof a.getFileWrappers === 'function' ? a.getFileWrappers().length : 'fn missing',
      currentTargetId: typeof a.getCurrentTargetId === 'function' ? a.getCurrentTargetId() : 'fn missing',
      docReadyState: document.readyState,
    };
  });
  console.log(`[validate] api state: ${JSON.stringify(apiState)}`);

  const styleApplied = await page.evaluate(() => {
    const w = document.querySelectorAll('copilot-diff-entry')[1];
    if (!w) return null;
    return {
      attr: w.getAttribute('data-ghpr-hidden'),
      computedDisplay: getComputedStyle(w).display,
    };
  });
  console.log(`[validate] second wrapper state: ${JSON.stringify(styleApplied)}`);

  const styleTagPresent = await page.evaluate(() => !!document.getElementById('ghpr-style'));
  console.log(`[validate] style tag present: ${styleTagPresent}`);

  // Force-call applyVisibility now that DOM is fully ready.
  const manualResult = await page.evaluate(() => {
    const a = (window as any).__ghPrSingleFile;
    const result = a.applyVisibility();
    return {
      result,
      lastTargetId: a.lastTargetId,
      secondAttr: document.querySelectorAll('copilot-diff-entry')[1]?.getAttribute('data-ghpr-hidden'),
      secondDisplay: document.querySelectorAll('copilot-diff-entry')[1] ? getComputedStyle(document.querySelectorAll('copilot-diff-entry')[1]).display : null,
    };
  });
  console.log(`[validate] manual applyVisibility result: ${JSON.stringify(manualResult)}`);

  const totalWrappers = await page.locator('copilot-diff-entry').count();
  const visibleWrappers = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('copilot-diff-entry'))
      .filter((w) => getComputedStyle(w).display !== 'none')
      .map((w) => {
        const inner = w.querySelector('[id^="diff-"]');
        return inner ? (inner as HTMLElement).id : null;
      });
  });

  console.log(`[validate] total wrappers: ${totalWrappers}`);
  console.log(`[validate] visible: ${JSON.stringify(visibleWrappers)}`);
  if (totalWrappers === 0) {
    console.error('[validate] FAIL: zero wrappers found. Page may have changed structure.');
    process.exit(1);
  }
  if (visibleWrappers.length !== 1) {
    console.error(`[validate] FAIL: expected exactly 1 visible wrapper, got ${visibleWrappers.length}`);
    process.exit(1);
  }

  // Switch via hash → assert different file becomes visible.
  const allInnerIds = await page.evaluate(() =>
    Array.from(document.querySelectorAll('copilot-diff-entry'))
      .map((w) => {
        const inner = w.querySelector('[id^="diff-"]');
        return inner ? (inner as HTMLElement).id : null;
      })
      .filter(Boolean) as string[],
  );
  if (allInnerIds.length < 3) {
    console.error('[validate] PR has too few files for hash navigation test');
    process.exit(1);
  }
  const otherId = allInnerIds[2];
  await page.evaluate((id: string) => {
    location.hash = '#' + id;
  }, otherId);
  await page.waitForTimeout(500);

  const visibleAfter = await page.evaluate(() =>
    Array.from(document.querySelectorAll('copilot-diff-entry'))
      .filter((w) => getComputedStyle(w).display !== 'none')
      .map((w) => {
        const inner = w.querySelector('[id^="diff-"]');
        return inner ? (inner as HTMLElement).id : null;
      }),
  );
  console.log(`[validate] after hash change visible: ${JSON.stringify(visibleAfter)}`);
  if (visibleAfter.length !== 1 || visibleAfter[0] !== otherId) {
    console.error('[validate] FAIL: hashchange did not switch the visible file');
    process.exit(1);
  }

  // Click a tree link → assert hash + visibility update.
  const thirdHref = await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll('nav[aria-label="File Tree Navigation"] a[href^="#diff-"]'),
    );
    return links[3]?.getAttribute('href') ?? null;
  });
  if (thirdHref) {
    await page.click(`nav[aria-label="File Tree Navigation"] a[href="${thirdHref}"]`);
    await page.waitForTimeout(500);
    const visibleAfterClick = await page.evaluate(() =>
      Array.from(document.querySelectorAll('copilot-diff-entry'))
        .filter((w) => getComputedStyle(w).display !== 'none')
        .map((w) => {
          const inner = w.querySelector('[id^="diff-"]');
          return inner ? (inner as HTMLElement).id : null;
        }),
    );
    const expectedId = thirdHref.replace(/^#/, '');
    console.log(`[validate] after click visible: ${JSON.stringify(visibleAfterClick)}`);
    if (visibleAfterClick.length !== 1 || visibleAfterClick[0] !== expectedId) {
      console.error('[validate] FAIL: tree click did not switch the visible file');
      process.exit(1);
    }
  } else {
    console.warn('[validate] no fourth tree link to click; skipping tree-click validation');
  }

  // ── Toggle off → all visible; toggle back on → 1 visible ──────────────
  const toggleExists = await page.evaluate(() => !!document.getElementById('ghpr-single-file-toggle'));
  if (!toggleExists) {
    console.error('[validate] FAIL: on-page toggle UI not found');
    process.exit(1);
  }

  await page.evaluate(() => (window as any).__ghPrSingleFile.setDisabled(true));
  await page.waitForTimeout(300);
  const visibleWhenDisabled = await page.evaluate(() =>
    Array.from(document.querySelectorAll('copilot-diff-entry'))
      .filter((w) => getComputedStyle(w).display !== 'none').length,
  );
  console.log(`[validate] visible when disabled: ${visibleWhenDisabled} (expected 10)`);
  if (visibleWhenDisabled !== 10) {
    console.error('[validate] FAIL: disable did not unhide all wrappers');
    process.exit(1);
  }

  await page.evaluate(() => (window as any).__ghPrSingleFile.setDisabled(false));
  await page.waitForTimeout(300);
  const visibleWhenReEnabled = await page.evaluate(() =>
    Array.from(document.querySelectorAll('copilot-diff-entry'))
      .filter((w) => getComputedStyle(w).display !== 'none').length,
  );
  console.log(`[validate] visible when re-enabled: ${visibleWhenReEnabled} (expected 1)`);
  if (visibleWhenReEnabled !== 1) {
    console.error('[validate] FAIL: re-enable did not collapse to one visible');
    process.exit(1);
  }

  console.log('[validate] OK — userscript MVP behaviour verified on real GitHub DOM.');
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
