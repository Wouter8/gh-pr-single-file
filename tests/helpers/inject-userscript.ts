/**
 * Loads the .user.js source from disk and injects it into a Playwright page
 * via `addInitScript`, so it runs before any GitHub script does — exactly like
 * Tampermonkey does at `document-start`.
 *
 * The same file we ship to users is what we test, byte-for-byte. The userscript
 * is responsible for guarding against non-matching pages (since @match doesn't
 * apply in Playwright).
 */

import type { BrowserContext, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import fixtures from '../fixtures/test-prs.json';

const USERSCRIPT_PATH = path.resolve(__dirname, '..', '..', 'src', 'github-pr-single-file.user.js');
let cachedSource: string | null = null;

export function userscriptSource(): string {
  if (cachedSource !== null) return cachedSource;
  cachedSource = fs.readFileSync(USERSCRIPT_PATH, 'utf-8');
  return cachedSource;
}

export async function injectUserscript(target: Page | BrowserContext): Promise<void> {
  // Attach to BOTH page and context when given a context, so the auto-created
  // page from Playwright's `test` fixture (which exists before test code runs)
  // also gets the script on its next navigation.
  await target.addInitScript({ content: userscriptSource() });
}

/**
 * Attaches the userscript to both the context and the given page. Use this in
 * Playwright tests that receive an auto-created `page` — `addInitScript` on
 * `context` alone may not apply to the pre-existing page on first navigation
 * in some Playwright versions.
 */
export async function injectUserscriptForTest(page: Page): Promise<void> {
  await page.addInitScript({ content: userscriptSource() });
  await page.context().addInitScript({ content: userscriptSource() });
}

export interface FixtureRecord {
  key: string;
  branch: string;
  prNumber: number;
  url: string;
  filesUrl: string;
  expectedFileCount: number;
  scenarios: string[];
}

export interface TestPrsJson {
  generatedAt: string;
  repo: string;
  fixtures: FixtureRecord[];
}

export function getFixture(key: string): FixtureRecord {
  const list = (fixtures as TestPrsJson).fixtures;
  const fx = list.find((f) => f.key === key);
  if (!fx) throw new Error(`No fixture with key "${key}" in test-prs.json`);
  return fx;
}

export const allFixtures = (fixtures as TestPrsJson).fixtures;

/**
 * The CSS selector list for "this is a per-file diff wrapper". Mirrors the
 * SELECTORS.fileWrappers list in src/github-pr-single-file.user.js. Keep
 * them in lockstep when updating one or the other.
 */
export const FILE_WRAPPER_SELECTOR =
  '[id^="diff-"][data-targeted], copilot-diff-entry, [data-targets="diff-file-filter.diffEntries"]';
