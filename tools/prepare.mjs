/**
 * Build on install, so installing from git produces a working binary.
 *
 * This exists because `npm i github:xzycd/recuse` used to succeed and install
 * nothing runnable. `dist/` is gitignored, so a git clone carries no build, and
 * the `prepublishOnly` script that used to do the compiling does not run on a
 * git install at all. npm ran no build, packed the three files `files` allowed,
 * found `bin` pointing at a `dist/cli.js` that did not exist, and printed
 * "added 41 packages" with no warning. The failure had the same shape as the
 * evidence tier bug in 0.5.0: a confident success message over nothing.
 *
 * `prepare` is the lifecycle script that does run on git installs, after
 * devDependencies are available and before the tree is packed.
 *
 * It also runs on a plain `npm install` in a checkout, which is why the missing
 * compiler is handled rather than thrown. `npm install --omit=dev` has no
 * TypeScript to run and is not trying to build anything, and failing that
 * install with a stack trace would be wrong.
 */

import { chmodSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

if (!existsSync(tsc)) {
  process.stdout.write('recuse: no local typescript, skipping build\n');
  process.exit(0);
}

execFileSync(tsc, ['--project', ROOT], { stdio: 'inherit' });

// tsc writes 644. npm sets the executable bit itself when it links a `bin`, so
// an installed copy works either way, but a checkout running ./dist/cli.js does
// not, and that is the first thing anyone does after cloning.
const entry = join(ROOT, 'dist', 'cli.js');
if (existsSync(entry)) chmodSync(entry, 0o755);
