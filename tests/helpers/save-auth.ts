#!/usr/bin/env ts-node
/**
 * One-time interactive helper to capture a logged-in GitHub session for the
 * Playwright test suite.
 *
 * Usage:
 *   npx ts-node tests/helpers/save-auth.ts
 *
 * Opens a Chromium window, lets you log in to GitHub manually (including any
 * 2FA), then saves the resulting cookies + localStorage to `.auth/github.json`.
 * The file is gitignored — it contains a session cookie and must NEVER be
 * committed.
 *
 * Re-run this if your tests start failing with "Sign in to GitHub" page
 * snapshots — your session cookie has likely expired.
 */

import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

const AUTH_FILE = path.resolve(__dirname, '..', '..', '.auth', 'github.json');

async function main() {
  console.log('[save-auth] Launching headed Chromium for manual GitHub login.');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://github.com/login', { waitUntil: 'domcontentloaded' });
  console.log('[save-auth] Log in to GitHub (incl. 2FA if any), then come back to this terminal.');

  await waitForEnter('[save-auth] Press <Enter> after you see the GitHub home page (you are logged in): ');

  // Sanity check: make sure we are actually logged in.
  const currentUrl = page.url();
  if (currentUrl.includes('/login')) {
    console.error(`[save-auth] You are still on a login URL (${currentUrl}). Aborting.`);
    await browser.close();
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  await context.storageState({ path: AUTH_FILE });
  console.log(`[save-auth] Saved storage state to ${AUTH_FILE}`);
  await browser.close();
}

function waitForEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
