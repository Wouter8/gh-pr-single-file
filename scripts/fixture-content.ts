/**
 * Deterministic fixture-content generators.
 *
 * Each generator writes its output into a directory and returns the list of
 * paths it touched (relative to that directory). Content is seeded from the
 * fixture name so re-runs are reproducible.
 *
 * Goals:
 *   - Produce realistic-looking diffs (added + removed lines, varied file
 *     types) without any compile/run requirement on the content.
 *   - Stay deterministic so `setup-fixture-prs.ts --update` can detect
 *     no-op runs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// --- Tiny seeded PRNG (mulberry32) -------------------------------------------------
function mulberry32(seed: number): () => number {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- Building blocks ---------------------------------------------------------------

const SAMPLE_WORDS = [
  'sphinx', 'quartz', 'matrix', 'oracle', 'meadow', 'cipher', 'forest', 'planet',
  'beacon', 'silver', 'sunset', 'castle', 'velvet', 'autumn', 'tunnel', 'breeze',
  'pebble', 'thrush', 'lattice', 'orbit', 'lagoon', 'cobalt', 'fennel', 'maple',
];

function pickWord(rand: () => number): string {
  return SAMPLE_WORDS[Math.floor(rand() * SAMPLE_WORDS.length)];
}

function makeLines(rand: () => number, count: number, indent = 0): string[] {
  const pad = ' '.repeat(indent);
  return Array.from({ length: count }, () => {
    const n = 4 + Math.floor(rand() * 6);
    const words = Array.from({ length: n }, () => pickWord(rand)).join(' ');
    return `${pad}// ${words}`;
  });
}

function pyFile(name: string, rand: () => number): string {
  const lines: string[] = [];
  lines.push(`"""${name} — fixture module (auto-generated)."""`);
  lines.push('');
  lines.push('from __future__ import annotations');
  lines.push('');
  const fnCount = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < fnCount; i++) {
    const fnName = `${pickWord(rand)}_${pickWord(rand)}`;
    lines.push(`def ${fnName}(value: int) -> int:`);
    lines.push(`    """${pickWord(rand)} ${pickWord(rand)} ${pickWord(rand)}."""`);
    const body = 2 + Math.floor(rand() * 4);
    for (let j = 0; j < body; j++) {
      lines.push(`    value = value * ${1 + Math.floor(rand() * 9)} + ${Math.floor(rand() * 100)}`);
    }
    lines.push('    return value');
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

function tsFile(name: string, rand: () => number): string {
  const lines: string[] = [];
  lines.push(`// ${name} — fixture module (auto-generated)`);
  lines.push('');
  const exportCount = 1 + Math.floor(rand() * 3);
  for (let i = 0; i < exportCount; i++) {
    const fnName = `${pickWord(rand)}${capitalize(pickWord(rand))}`;
    lines.push(`export function ${fnName}(input: number): number {`);
    const body = 2 + Math.floor(rand() * 4);
    for (let j = 0; j < body; j++) {
      lines.push(`  input = input * ${1 + Math.floor(rand() * 9)} + ${Math.floor(rand() * 100)};`);
    }
    lines.push('  return input;');
    lines.push('}');
    lines.push('');
  }
  return lines.join('\n');
}

function mdFile(name: string, rand: () => number): string {
  const out: string[] = [];
  out.push(`# ${capitalize(name.replace(/[-_]/g, ' '))}`);
  out.push('');
  const paraCount = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < paraCount; i++) {
    out.push(makeLines(rand, 1).map(l => l.replace(/^\/\/ /, '')).join('') + '.');
    out.push('');
  }
  return out.join('\n');
}

function jsonFile(rand: () => number): string {
  const obj: Record<string, unknown> = {};
  const keys = 3 + Math.floor(rand() * 5);
  for (let i = 0; i < keys; i++) {
    obj[pickWord(rand)] = Math.floor(rand() * 1000);
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// --- Fixture generators ------------------------------------------------------------

export function generateSmall(dir: string): string[] {
  const rand = mulberry32(seedFromString('small-pr'));
  const root = path.join(dir, '__fixtures__/small-pr');
  fs.mkdirSync(root, { recursive: true });

  const written: string[] = [];
  const files: Array<[string, string]> = [
    ['__fixtures__/small-pr/alpha.py', pyFile('alpha', rand)],
    ['__fixtures__/small-pr/beta.ts', tsFile('beta', rand)],
    ['__fixtures__/small-pr/notes.md', mdFile('Notes about alpha and beta', rand)],
  ];
  for (const [rel, content] of files) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written.push(rel);
  }
  return written;
}

export function generateMedium(dir: string): string[] {
  const rand = mulberry32(seedFromString('medium-pr'));
  const written: string[] = [];
  const exts = ['py', 'ts', 'md', 'json'] as const;
  for (let i = 0; i < 10; i++) {
    const ext = exts[i % exts.length];
    const baseName = `${pickWord(rand)}_${pickWord(rand)}_${i}`;
    const rel = `__fixtures__/medium-pr/${baseName}.${ext}`;
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let content: string;
    switch (ext) {
      case 'py': content = pyFile(baseName, rand); break;
      case 'ts': content = tsFile(baseName, rand); break;
      case 'md': content = mdFile(baseName, rand); break;
      case 'json': content = jsonFile(rand); break;
    }
    fs.writeFileSync(abs, content);
    written.push(rel);
  }
  return written;
}

export function generateLarge(dir: string): string[] {
  const rand = mulberry32(seedFromString('large-pr'));
  const written: string[] = [];
  const exts = ['py', 'ts', 'md', 'json'] as const;
  for (let i = 0; i < 65; i++) {
    const ext = exts[i % exts.length];
    const baseName = `${pickWord(rand)}_${i.toString().padStart(3, '0')}`;
    const rel = `__fixtures__/large-pr/${baseName}.${ext}`;
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    let content: string;
    switch (ext) {
      case 'py': content = pyFile(baseName, rand); break;
      case 'ts': content = tsFile(baseName, rand); break;
      case 'md': content = mdFile(baseName, rand); break;
      case 'json': content = jsonFile(rand); break;
    }
    fs.writeFileSync(abs, content);
    written.push(rel);
  }
  return written;
}

/**
 * Edge-cases generator. Returns files-written; deletions/renames are signalled
 * via a separate manifest the caller applies.
 */
export interface EdgeCasesPlan {
  written: string[];
  deletes: string[];   // paths (relative to repo) to delete on the fixture branch
  renames: Array<{ from: string; to: string }>;
}

export function generateEdgeCases(dir: string): EdgeCasesPlan {
  const rand = mulberry32(seedFromString('edge-cases-pr'));
  const written: string[] = [];

  // Modified file (depends on a base file under __fixtures__/edge-cases/)
  const modPath = '__fixtures__/edge-cases/modified.txt';
  const modAbs = path.join(dir, modPath);
  fs.mkdirSync(path.dirname(modAbs), { recursive: true });
  fs.writeFileSync(modAbs, [
    '# fixture: modified.txt',
    '',
    'this line existed before the fixture branch.',
    'this line was added by the fixture branch.',
    '',
  ].join('\n'));
  written.push(modPath);

  // Binary file: a tiny valid PNG (1x1 transparent).
  const binPath = '__fixtures__/edge-cases/pixel.png';
  const binAbs = path.join(dir, binPath);
  fs.mkdirSync(path.dirname(binAbs), { recursive: true });
  // Pre-generated 1x1 transparent PNG bytes. Hard-coded so the diff is stable.
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154' +
    '789c63000100000005000100' +
    '0d0a2db40000000049454e44ae426082',
    'hex',
  );
  fs.writeFileSync(binAbs, png);
  written.push(binPath);

  // No newline at EOF
  const nonlPath = '__fixtures__/edge-cases/no_eol.txt';
  const nonlAbs = path.join(dir, nonlPath);
  fs.mkdirSync(path.dirname(nonlAbs), { recursive: true });
  fs.writeFileSync(nonlAbs, 'first line\nsecond line\nlast line without newline');
  written.push(nonlPath);

  // Very long single line (~5000 chars)
  const longPath = '__fixtures__/edge-cases/long_line.txt';
  const longAbs = path.join(dir, longPath);
  fs.mkdirSync(path.dirname(longAbs), { recursive: true });
  const longLine = Array.from({ length: 500 }, () => pickWord(rand)).join(' ');
  fs.writeFileSync(longAbs, longLine + '\n');
  written.push(longPath);

  // Renames are applied by the caller via `git mv`. We deliberately do NOT
  // pre-create the destination here — that would make `git mv` refuse. The
  // resulting diff is a pure rename (100% similarity), which is a valid edge
  // case in its own right.
  const renameTargetPath = '__fixtures__/edge-cases/renamed_target.txt';

  return {
    written,
    deletes: ['__fixtures__/edge-cases/to_delete.txt'],
    renames: [{ from: '__fixtures__/edge-cases/to_rename.txt', to: renameTargetPath }],
  };
}

/**
 * Files we need to exist on `main` *before* fixture branches modify or
 * delete them. The setup script ensures these are committed to main on
 * first run.
 */
export const MAIN_BASE_FILES: Array<[string, string]> = [
  [
    '__fixtures__/edge-cases/modified.txt',
    [
      '# fixture: modified.txt',
      '',
      'this line existed before the fixture branch.',
      '',
    ].join('\n'),
  ],
  [
    '__fixtures__/edge-cases/to_delete.txt',
    'this file exists only so that fixtures/edge-cases-pr can show a deletion in its diff.\n',
  ],
  [
    '__fixtures__/edge-cases/to_rename.txt',
    'this file is renamed to renamed_target.txt on fixtures/edge-cases-pr.\n',
  ],
  [
    '__fixtures__/README.md',
    [
      '# `__fixtures__/` — test scaffolding',
      '',
      'This directory exists to support the userscript test suite. Files',
      'here are referenced by `fixtures/*` PRs (deleted, renamed, modified',
      'across branches). **Do not delete or reorganise these files** —',
      'doing so will break the test fixtures.',
      '',
      'See `scripts/setup-fixture-prs.ts` for how the contents are produced.',
      '',
    ].join('\n'),
  ],
];
