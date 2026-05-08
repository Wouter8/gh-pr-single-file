#!/usr/bin/env ts-node
/**
 * Phase 0 DOM reconnaissance.
 *
 * Loads a real GitHub PR "Files changed" page in Playwright Chromium, dumps the
 * relevant DOM regions, takes a screenshot, and emits a list of candidate CSS
 * selectors for the userscript to depend on.
 *
 * Usage:
 *   npx ts-node scripts/inspect-dom.ts <pr-files-url>
 *   npx ts-node scripts/inspect-dom.ts <pr-files-url> --auth=<storageStatePath>
 *
 * If no URL is given, falls back to GH_INSPECT_URL env var.
 *
 * Output goes to .dom-inspection/ (gitignored) so we never commit scraped HTML.
 */

import { chromium, Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface CandidateSelector {
  selector: string;
  count: number;
  example?: string;
  source: 'data-testid' | 'aria-label' | 'role' | 'id-prefix' | 'class-pattern';
}

const OUT_DIR = path.resolve(__dirname, '..', '.dom-inspection');

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => !a.startsWith('--')) ?? process.env.GH_INSPECT_URL;
  const authArg = args.find(a => a.startsWith('--auth='));
  const storageState = authArg ? authArg.slice('--auth='.length) : undefined;

  if (!url) {
    console.error('ERROR: provide a PR /files URL.');
    console.error('  npx ts-node scripts/inspect-dom.ts https://github.com/<owner>/<repo>/pull/<n>/files');
    console.error('Recommended targets:');
    console.error('  - One of your own merged PRs (use --auth=<storage-state.json> if private)');
    console.error('  - A small merged PR from a stable public repo (cli/cli, microsoft/vscode, etc.)');
    process.exit(2);
  }

  if (!/\/pull\/\d+\/(files|changes)/.test(url)) {
    console.error(`ERROR: URL must end with /pull/<n>/files or /pull/<n>/changes. Got: ${url}`);
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`[inspect-dom] launching chromium`);
  const browser = await chromium.launch();
  const context = await browser.newContext(
    storageState ? { storageState } : undefined,
  );
  const page = await context.newPage();

  console.log(`[inspect-dom] navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  // The new (Jan 2026) Files-changed page is React-rendered. Wait a beat for
  // hydration; we're best-effort here since selectors are unknown.
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {
    console.warn('[inspect-dom] network did not go idle within 30s; continuing anyway');
  });
  // Extra grace period for late re-renders.
  await page.waitForTimeout(2_000);

  await page.screenshot({
    path: path.join(OUT_DIR, 'screenshot.png'),
    fullPage: true,
  });
  console.log(`[inspect-dom] saved screenshot.png`);

  await dumpRegion(page, 'main-region', 'main, [role="main"], #js-repo-pjax-container', 200);
  await dumpRegion(page, 'file-tree-region', '[aria-label*="ile" i], [data-testid*="ile-tree" i], nav[aria-label*="iles" i]', 200);
  await dumpRegion(page, 'diff-area-region', '[data-testid*="diff" i], .js-diff-progressive-container, .file', 200);

  const candidates = await collectCandidateSelectors(page);
  fs.writeFileSync(
    path.join(OUT_DIR, 'candidates.json'),
    JSON.stringify(candidates, null, 2),
  );
  console.log(`[inspect-dom] saved candidates.json (${candidates.length} entries)`);

  // Tree-link probe: find anchors whose href is a hash beginning with #diff-.
  const diffAnchors = await page.$$eval('a[href^="#diff-"]', els =>
    els.slice(0, 20).map(a => {
      let cur: Element | null = a.parentElement;
      let ancestorWithTestId: string | undefined;
      for (let i = 0; i < 8 && cur; i++) {
        const v = cur.getAttribute && cur.getAttribute('data-testid');
        if (v) { ancestorWithTestId = v; break; }
        cur = cur.parentElement;
      }
      return {
        href: (a as HTMLAnchorElement).getAttribute('href'),
        text: (a.textContent ?? '').trim().slice(0, 80),
        classes: (a.getAttribute('class') ?? '').slice(0, 200),
        ancestorWithTestId,
      };
    }),
  ).catch(() => []);
  fs.writeFileSync(
    path.join(OUT_DIR, 'diff-anchors.json'),
    JSON.stringify(diffAnchors, null, 2),
  );
  console.log(`[inspect-dom] saved diff-anchors.json (${diffAnchors.length} sampled anchors)`);

  // Diff-container probe: what wraps a #diff-<sha> id?
  const diffContainers = await page.evaluate(() => {
    const ids = Array.from(document.querySelectorAll('[id^="diff-"]'))
      .slice(0, 10)
      .map(el => {
        let cur: Element | null = el;
        const chain: { tag: string; id?: string; testid?: string; classes?: string }[] = [];
        for (let i = 0; i < 6 && cur; i++) {
          chain.push({
            tag: cur.tagName.toLowerCase(),
            id: cur.id || undefined,
            testid: cur.getAttribute('data-testid') ?? undefined,
            classes: (cur.getAttribute('class') ?? '').slice(0, 120) || undefined,
          });
          cur = cur.parentElement;
        }
        return { idEl: el.id, ancestors: chain };
      });
    return ids;
  });
  fs.writeFileSync(
    path.join(OUT_DIR, 'diff-containers.json'),
    JSON.stringify(diffContainers, null, 2),
  );
  console.log(`[inspect-dom] saved diff-containers.json (${diffContainers.length} samples)`);

  await browser.close();
  console.log(`[inspect-dom] done. Output dir: ${OUT_DIR}`);
}

async function dumpRegion(page: Page, name: string, selectorList: string, maxLines: number) {
  const html = await page.evaluate((sel) => {
    const selectors = sel.split(',').map(s => s.trim()).filter(Boolean);
    for (const s of selectors) {
      const el = document.querySelector(s);
      if (el) return { matched: s, html: el.outerHTML };
    }
    return null;
  }, selectorList);

  if (!html) {
    console.warn(`[inspect-dom] ${name}: no element matched any of: ${selectorList}`);
    fs.writeFileSync(path.join(OUT_DIR, `${name}.html`), `<!-- no match for: ${selectorList} -->`);
    return;
  }

  const lines = html.html.split('\n').slice(0, maxLines).join('\n');
  fs.writeFileSync(
    path.join(OUT_DIR, `${name}.html`),
    `<!-- matched: ${html.matched} -->\n${lines}\n`,
  );
  console.log(`[inspect-dom] ${name}: matched "${html.matched}", saved ${lines.split('\n').length} lines`);
}

async function collectCandidateSelectors(page: Page): Promise<CandidateSelector[]> {
  // Scan the whole page for: data-testid, aria-label, role attributes that look
  // related to "file", "diff", "tree". Also id prefixes like "diff-".
  const raw = await page.evaluate(() => {
    type Cand = { selector: string; count: number; example?: string; source: string };
    const out: Cand[] = [];

    function tally(map: Map<string, { count: number; example?: string }>, key: string, example?: string) {
      const cur = map.get(key) ?? { count: 0, example };
      cur.count++;
      if (!cur.example && example) cur.example = example;
      map.set(key, cur);
    }

    const keywords = /file|diff|tree|view(ed)?|hunk/i;

    // data-testid
    const testids = new Map<string, { count: number; example?: string }>();
    document.querySelectorAll('[data-testid]').forEach(el => {
      const v = el.getAttribute('data-testid')!;
      if (keywords.test(v)) tally(testids, v, el.tagName.toLowerCase());
    });
    testids.forEach((info, v) => {
      out.push({ selector: `[data-testid="${v}"]`, count: info.count, example: info.example, source: 'data-testid' });
    });

    // aria-label
    const arias = new Map<string, { count: number; example?: string }>();
    document.querySelectorAll('[aria-label]').forEach(el => {
      const v = el.getAttribute('aria-label')!;
      if (keywords.test(v)) tally(arias, v, el.tagName.toLowerCase());
    });
    arias.forEach((info, v) => {
      out.push({ selector: `[aria-label="${v}"]`, count: info.count, example: info.example, source: 'aria-label' });
    });

    // role
    const roles = new Map<string, { count: number; example?: string }>();
    document.querySelectorAll('[role]').forEach(el => {
      const v = el.getAttribute('role')!;
      const al = el.getAttribute('aria-label') ?? '';
      if (keywords.test(v) || keywords.test(al)) tally(roles, `${v}|${al}`, el.tagName.toLowerCase());
    });
    roles.forEach((info, v) => {
      const [role, al] = v.split('|');
      out.push({
        selector: al ? `[role="${role}"][aria-label="${al}"]` : `[role="${role}"]`,
        count: info.count,
        example: info.example,
        source: 'role',
      });
    });

    // id prefixes
    const idPrefixes: Record<string, number> = {};
    document.querySelectorAll('[id]').forEach(el => {
      const id = el.id;
      const m = id.match(/^([a-z]+)-/i);
      if (m && keywords.test(m[1])) {
        idPrefixes[m[1]] = (idPrefixes[m[1]] ?? 0) + 1;
      }
    });
    Object.entries(idPrefixes).forEach(([prefix, count]) => {
      out.push({ selector: `[id^="${prefix}-"]`, count, source: 'id-prefix' });
    });

    return out;
  });

  return raw.sort((a, b) => b.count - a.count) as CandidateSelector[];
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
