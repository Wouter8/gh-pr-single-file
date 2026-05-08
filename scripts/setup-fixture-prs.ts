#!/usr/bin/env ts-node
/**
 * Idempotently create / update the fixture branches + draft PRs that the
 * userscript test suite runs against.
 *
 * Usage:
 *   npx ts-node scripts/setup-fixture-prs.ts            # create missing fixtures, leave existing alone
 *   npx ts-node scripts/setup-fixture-prs.ts --update   # force-reset every fixture branch to the current generator output
 *   npx ts-node scripts/setup-fixture-prs.ts --dry-run  # print what would happen, don't push or create PRs
 *
 * Exit code: 0 on success (incl. "everything already exists"), non-zero on failure.
 *
 * Requires:
 *   - `gh` authenticated (gh auth status)
 *   - push access to the current repo's main branch (only first run, to seed __fixtures__/)
 */

import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateEdgeCases,
  generateLarge,
  generateMedium,
  generateSmall,
  MAIN_BASE_FILES,
} from './fixture-content';

const TITLE_PREFIX = '[FIXTURE — DO NOT MERGE]';
const REPO_ROOT = path.resolve(__dirname, '..');
const TEST_PRS_JSON = path.join(REPO_ROOT, 'tests/fixtures/test-prs.json');

interface FixtureDef {
  key: 'small-pr' | 'medium-pr' | 'large-pr' | 'edge-cases-pr';
  branch: string;
  titleSuffix: string;
  scenarios: string[];
  expectedFileCount: number;
  apply: (worktreeDir: string) => void;
}

interface CliOpts {
  update: boolean;
  dryRun: boolean;
}

interface RepoInfo {
  nameWithOwner: string; // owner/name
  defaultBranch: string;
}

interface PrInfo {
  number: number;
  url: string;
  isDraft: boolean;
  title: string;
}

interface FixtureRecord {
  key: string;
  branch: string;
  prNumber: number;
  url: string;
  filesUrl: string;
  expectedFileCount: number;
  scenarios: string[];
}

const FIXTURES: FixtureDef[] = [
  {
    key: 'small-pr',
    branch: 'fixtures/small-pr',
    titleSuffix: 'small fixture (2-3 files)',
    scenarios: ['base behavior verification'],
    expectedFileCount: 3,
    apply: (dir) => {
      generateSmall(dir);
    },
  },
  {
    key: 'medium-pr',
    branch: 'fixtures/medium-pr',
    titleSuffix: 'medium fixture (~10 files)',
    scenarios: ['file-tree clicks', 'hash-respected-on-load'],
    expectedFileCount: 10,
    apply: (dir) => {
      generateMedium(dir);
    },
  },
  {
    key: 'large-pr',
    branch: 'fixtures/large-pr',
    titleSuffix: 'large fixture (60+ files)',
    scenarios: ["coexistence with GitHub's native auto single-file mode"],
    expectedFileCount: 65,
    apply: (dir) => {
      generateLarge(dir);
    },
  },
  {
    key: 'edge-cases-pr',
    branch: 'fixtures/edge-cases-pr',
    titleSuffix: 'edge cases (deleted, renamed, binary, no-EOL, long line)',
    scenarios: ['deleted file', 'renamed file', 'binary file', 'no newline at EOF', 'very long single line'],
    expectedFileCount: 6,
    apply: (dir) => {
      const plan = generateEdgeCases(dir);
      // Apply renames (the `from` path was created by MAIN_BASE_FILES on main; the
      // worktree was checked out from origin/main, so it's there).
      for (const ren of plan.renames) {
        execFileSync('git', ['-C', dir, 'mv', ren.from, ren.to], { stdio: 'inherit' });
      }
      for (const del of plan.deletes) {
        execFileSync('git', ['-C', dir, 'rm', del], { stdio: 'inherit' });
      }
    },
  },
];

// --- main --------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  log(`opts: ${JSON.stringify(opts)}`);

  ensureGhAuth();
  const repo = getRepoInfo();
  log(`repo: ${repo.nameWithOwner} (default branch: ${repo.defaultBranch})`);

  fetchOrigin(repo.defaultBranch);

  ensureMainBaseFiles(repo, opts);

  // After main may have just been updated, refetch.
  fetchOrigin(repo.defaultBranch);

  const records: FixtureRecord[] = [];
  for (const fx of FIXTURES) {
    log(`\n=== fixture: ${fx.key} ===`);
    const branchExists = remoteBranchExists(fx.branch);
    if (!branchExists || opts.update) {
      log(`branch ${fx.branch}: ${branchExists ? '--update set, force-resetting' : 'creating'}`);
      createOrResetBranch(repo, fx, opts);
    } else {
      log(`branch ${fx.branch}: exists, leaving alone`);
    }

    let pr = findOpenPr(repo, fx.branch);
    if (!pr) {
      log(`PR for ${fx.branch}: none open, creating draft`);
      pr = createDraftPr(repo, fx, opts);
    } else {
      log(`PR for ${fx.branch}: #${pr.number} (${pr.isDraft ? 'draft' : 'NOT draft'}) — ${pr.url}`);
      if (!pr.isDraft) {
        warn(`PR #${pr.number} is no longer marked draft. Re-run with attention; the fixture must stay draft.`);
      }
      if (!pr.title.startsWith(TITLE_PREFIX)) {
        warn(`PR #${pr.number} title no longer starts with "${TITLE_PREFIX}". Title: ${pr.title}`);
      }
    }

    records.push({
      key: fx.key,
      branch: fx.branch,
      prNumber: pr.number,
      url: pr.url,
      filesUrl: `${pr.url}/files`,
      expectedFileCount: fx.expectedFileCount,
      scenarios: fx.scenarios,
    });
  }

  writeTestPrsJson(repo, records);
  log(`\nwrote ${TEST_PRS_JSON}`);
  log(`\nall fixtures ready:`);
  for (const r of records) log(`  ${r.key}: ${r.url}/files`);
}

// --- args / env --------------------------------------------------------------------

function parseArgs(argv: string[]): CliOpts {
  return {
    update: argv.includes('--update'),
    dryRun: argv.includes('--dry-run'),
  };
}

function ensureGhAuth() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch (e) {
    fail('`gh auth status` failed. Run `gh auth login` first.');
  }
}

function getRepoInfo(): RepoInfo {
  const out = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  });
  const parsed = JSON.parse(out) as { nameWithOwner: string; defaultBranchRef: { name: string } };
  return {
    nameWithOwner: parsed.nameWithOwner,
    defaultBranch: parsed.defaultBranchRef.name,
  };
}

// --- git ---------------------------------------------------------------------------

function fetchOrigin(defaultBranch: string) {
  execFileSync('git', ['fetch', 'origin', defaultBranch], { stdio: 'inherit', cwd: REPO_ROOT });
}

function remoteBranchExists(branch: string): boolean {
  try {
    const out = execFileSync('git', ['ls-remote', '--heads', 'origin', branch], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function originHas(repoRelPath: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `origin/HEAD:${repoRelPath}`], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function ensureMainBaseFiles(repo: RepoInfo, opts: CliOpts) {
  const missing = MAIN_BASE_FILES.filter(([rel]) => !originHas(rel));
  if (missing.length === 0) {
    log(`main base files already present (${MAIN_BASE_FILES.length} files)`);
    return;
  }

  log(`main is missing ${missing.length} base files; will commit them to main`);
  for (const [rel] of missing) log(`  + ${rel}`);
  if (opts.dryRun) {
    log('[dry-run] would commit base files to main');
    return;
  }

  withTempWorktree(`origin/${repo.defaultBranch}`, (dir) => {
    for (const [rel, content] of missing) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    execFileSync('git', ['-C', dir, 'add', ...missing.map(([r]) => r)], { stdio: 'inherit' });
    execFileSync(
      'git',
      ['-C', dir, 'commit', '-m', 'chore(fixtures): seed __fixtures__/ base files for fixture PRs'],
      { stdio: 'inherit' },
    );
    execFileSync('git', ['-C', dir, 'push', 'origin', `HEAD:${repo.defaultBranch}`], { stdio: 'inherit' });
  });
}

function createOrResetBranch(repo: RepoInfo, fx: FixtureDef, opts: CliOpts) {
  if (opts.dryRun) {
    log(`[dry-run] would create/reset ${fx.branch}`);
    return;
  }
  withTempWorktree(`origin/${repo.defaultBranch}`, (dir) => {
    fx.apply(dir);
    // Stage everything: new + deleted + renamed (rename was already `git mv`'d)
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'inherit' });

    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf-8' });
    if (!status.trim()) {
      log(`${fx.branch}: generator produced no changes vs main; skipping`);
      return;
    }

    execFileSync(
      'git',
      ['-C', dir, 'commit', '-m', `${TITLE_PREFIX} ${fx.titleSuffix}`],
      { stdio: 'inherit' },
    );
    // Force-push the new commit as the fixture branch (replaces existing if any).
    execFileSync(
      'git',
      ['-C', dir, 'push', 'origin', `+HEAD:refs/heads/${fx.branch}`],
      { stdio: 'inherit' },
    );
  });
}

function withTempWorktree(baseRef: string, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-pr-fixture-'));
  try {
    execFileSync('git', ['worktree', 'add', '--detach', dir, baseRef], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    });
  } catch (e) {
    // mkdtemp left an empty dir; clean up.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw e;
  }
  try {
    fn(dir);
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', dir], {
        stdio: 'inherit',
        cwd: REPO_ROOT,
      });
    } catch (e) {
      warn(`failed to remove temp worktree at ${dir}: ${(e as Error).message}`);
    }
  }
}

// --- gh / PRs ----------------------------------------------------------------------

function findOpenPr(repo: RepoInfo, branch: string): PrInfo | null {
  const out = execFileSync(
    'gh',
    ['pr', 'list',
      '--repo', repo.nameWithOwner,
      '--head', branch,
      '--state', 'open',
      '--json', 'number,url,isDraft,title'],
    { encoding: 'utf-8' },
  );
  const list = JSON.parse(out) as PrInfo[];
  return list[0] ?? null;
}

function createDraftPr(repo: RepoInfo, fx: FixtureDef, opts: CliOpts): PrInfo {
  const title = `${TITLE_PREFIX} ${fx.titleSuffix}`;
  const body = [
    'This PR is a test fixture for the `github-pr-single-file.user.js` test suite. It is intentionally kept open and **must not be merged**.',
    '',
    `- Branch: \`${fx.branch}\``,
    `- Scenarios covered: ${fx.scenarios.join(', ')}`,
    `- Expected file count in diff: ${fx.expectedFileCount}`,
    '',
    'Re-generate via `npx ts-node scripts/setup-fixture-prs.ts --update`.',
  ].join('\n');

  if (opts.dryRun) {
    log(`[dry-run] would create draft PR for ${fx.branch} titled "${title}"`);
    return { number: -1, url: 'https://example.invalid', isDraft: true, title };
  }

  execFileSync(
    'gh',
    ['pr', 'create',
      '--repo', repo.nameWithOwner,
      '--base', 'main',
      '--head', fx.branch,
      '--draft',
      '--title', title,
      '--body', body],
    { stdio: 'inherit' },
  );

  const pr = findOpenPr(repo, fx.branch);
  if (!pr) fail(`PR creation appeared to succeed but no open PR found for ${fx.branch}`);
  return pr;
}

// --- output ------------------------------------------------------------------------

function writeTestPrsJson(repo: RepoInfo, records: FixtureRecord[]) {
  const payload = {
    generatedAt: new Date().toISOString(),
    repo: repo.nameWithOwner,
    fixtures: records,
  };
  fs.mkdirSync(path.dirname(TEST_PRS_JSON), { recursive: true });
  fs.writeFileSync(TEST_PRS_JSON, JSON.stringify(payload, null, 2) + '\n');
}

// --- helpers -----------------------------------------------------------------------

function log(msg: string) {
  console.log(`[fixtures] ${msg}`);
}
function warn(msg: string) {
  console.warn(`[fixtures] WARN: ${msg}`);
}
function fail(msg: string): never {
  console.error(`[fixtures] FATAL: ${msg}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
