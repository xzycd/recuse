/**
 * The house rules from CLAUDE.md, checked rather than remembered.
 *
 * Run by CI on every push and pull request, and worth running by hand before
 * pushing. Exits non-zero and says which rule and where.
 *
 * The em dash check skips fenced code blocks, and that exclusion is the whole
 * reason this is a script instead of a grep. The rule is about prose: the table
 * renderers use `—` as a no-data glyph in a column, the README shows sample
 * output containing it, and CLAUDE.md documents the check itself. All three are
 * inside fences. A flat grep flags all of them, and a check that cries wolf
 * gets deleted, which is worse than not having it.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Prose files. Source comments are checked separately, below. */
const PROSE = ['README.md', 'DNA.md', 'CLAUDE.md', 'SECURITY.md', 'CHANGELOG.md'];

const failures = [];

/** Drop fenced code blocks, keeping line numbers intact. */
function withoutFences(text) {
  let fenced = false;
  return text.split('\n').map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  });
}

function check(file, lines, pattern, rule) {
  lines.forEach((line, i) => {
    if (pattern.test(line)) failures.push(`${file}:${i + 1}  ${rule}\n    ${line.trim()}`);
  });
}

for (const file of PROSE) {
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue;
  }

  // Fenced blocks and inline code are both stripped. Naming a character in
  // code is not prose, and both of these files legitimately quote the no-data
  // glyph while documenting it.
  const lines = withoutFences(text).map((l) => l.replace(/`[^`]*`/g, ''));

  check(file, lines, /—/, 'em dash in prose');
  check(file, lines, /\p{Extended_Pictographic}/u, 'emoji in prose');
}

// Comments and strings in source. The renderers hold the no-data glyph as a
// string literal, which is a character in a column rather than writing, so only
// comments are checked here.
const sources = execFileSync('git', ['ls-files', 'src', 'tools'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.(ts|tsx|mjs)$/.test(f));

for (const file of sources) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
    if (isComment && line.includes('—')) {
      failures.push(`${file}:${i + 1}  em dash in a comment\n    ${line.trim()}`);
    }
  });
}

// Commit trailers. The repo carries one author and no tool attribution.
const log = execFileSync('git', ['log', '--format=%B'], { cwd: ROOT, encoding: 'utf8' });
for (const line of log.split('\n')) {
  if (/^(co-authored-by|generated with|🤖)/i.test(line.trim())) {
    failures.push(`git log  attribution trailer\n    ${line.trim()}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.length} house rule violation(s)\n\n`);
  for (const f of failures) process.stderr.write(`  ${f}\n\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('house rules clean\n');
}
