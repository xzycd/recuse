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
 *
 * The reachability check further down follows the same principle for the same
 * reason. It walks from the entry point rather than counting references, and it
 * reports nothing on a clean tree.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDisallowedAttribution } from './attribution.mjs';
import { unreachable } from './reachable.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Prose files. Source comments are checked separately, below. */
const PROSE = [
  'README.md',
  'DNA.md',
  'CLAUDE.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'RELEASING.md',
];

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
    // Backticks stripped here for the same reason they are in prose: a comment
    // naming the glyph while explaining this rule is not writing with it. This
    // file was the first thing the check failed on, which is the correct
    // instinct applied one level too broadly.
    if (isComment && line.replace(/`[^`]*`/g, '').includes('—')) {
      failures.push(`${file}:${i + 1}  em dash in a comment\n    ${line.trim()}`);
    }
  });
}

// Release metadata has drifted before. Keep the package, lock and changelog on
// one version so a tag cannot build a tarball carrying a different number.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const lockedVersion = lock.packages?.['']?.version;
if (pkg.version !== lockedVersion) {
  failures.push(
    `package-lock.json  root version ${lockedVersion ?? 'missing'} does not match ${pkg.version}`,
  );
}
const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## ${pkg.version},`)) {
  failures.push(`CHANGELOG.md  no release heading for package version ${pkg.version}`);
}
const server = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
const npmPackage = server.packages?.find((entry) => entry.registryType === 'npm');
if (server.name !== pkg.mcpName) {
  failures.push(`server.json  name ${server.name ?? 'missing'} does not match ${pkg.mcpName}`);
}
if (server.version !== pkg.version || npmPackage?.version !== pkg.version) {
  failures.push(`server.json  version does not match package version ${pkg.version}`);
}
if (npmPackage?.identifier !== pkg.name) {
  failures.push(`server.json  npm package does not match ${pkg.name}`);
}

/*
 * Code nothing can reach, which is the rule this repo has broken most often.
 *
 * `safeEndpoint` sat in a constructor nothing constructed and read as a working
 * defence for weeks. The evidence tier claimed oracle data from a file that had
 * never been wired in. Both survived review, both survived a grep, and the
 * lesson written down after the first one, grep for call sites and not for
 * definitions, did not prevent the second, because remembering to grep is not a
 * check. This is.
 *
 * The analysis is in `reachable.mjs` so it can be tested against files built to
 * be dead, rather than only against this repo on a day it happens to be clean.
 */

/**
 * Where execution starts.
 *
 * Test files are deliberately not roots and not scanned. A symbol only a test
 * can reach is a symbol the program cannot, and that is the case worth
 * reporting rather than the case to excuse. Three passing tests were the reason
 * the dead chain layer looked maintained.
 */
const ROOTS = ['src/cli.ts'];

const sourceFiles = execFileSync('git', ['ls-files', 'src'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n')
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

const sourceText = Object.fromEntries(
  sourceFiles.map((f) => [f, readFileSync(join(ROOT, f), 'utf8')]),
);

for (const { file, name } of unreachable(sourceText, ROOTS)) {
  failures.push(
    `${file}  ${name} is not reachable from ${ROOTS.join(' or ')}\n` +
      '    finish it, wire it up, or delete it. git keeps whatever you delete.',
  );
}

// Commit trailers. The repo carries one author and no tool attribution.
// GitHub squash merges can repeat that author's other verified identity as a
// co-author. That is redundant metadata, not a second author, so accept it only
// when the exact identity already authored a commit and every author name in the
// history is the same.
const knownAuthors = new Set(
  execFileSync('git', ['log', '--format=%an <%ae>'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
);
const authorNames = new Set(
  execFileSync('git', ['log', '--format=%an'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean),
);
const log = execFileSync('git', ['log', '--format=%B'], { cwd: ROOT, encoding: 'utf8' });
for (const line of log.split('\n')) {
  if (isDisallowedAttribution(line, knownAuthors, authorNames)) {
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
