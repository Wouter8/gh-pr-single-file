import { defineConfig } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const AUTH_STATE = path.resolve(__dirname, '.auth/github.json');
const HAVE_AUTH = fs.existsSync(AUTH_STATE);

if (!HAVE_AUTH) {
  console.warn(
    '[playwright.config] .auth/github.json not found — tests will run unauthenticated.\n' +
      '                    Run `npx ts-node tests/helpers/save-auth.ts` to record a session\n' +
      '                    once. Tests that require authenticated access to private PRs will fail without it.',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // sequential keeps console-log capture sane
  retries: 2, // network flakiness against github.com
  workers: 1, // ditto
  // Tests do their own waitForTimeout for userscript settling, plus a
  // navigation against live github.com. 30s (Playwright default) is too
  // tight; 90s gives room for slow page loads + a 6s settle.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'https://github.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    storageState: HAVE_AUTH ? AUTH_STATE : undefined,
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  // Deliberately NOT using `devices['Desktop Chrome']` — the UA it sets makes
  // GitHub serve a DOM variant with no copilot-diff-entry wrappers, which
  // breaks our selectors. Default Playwright Chromium UA gets the variant we
  // built against.
  projects: [{ name: 'chromium' }],
});
