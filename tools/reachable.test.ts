/**
 * The reachability check, tested against code built to be dead.
 *
 * Running it over this repo proves nothing on a day the repo is clean, which is
 * the failure mode it exists to catch wearing a different hat. These cases are
 * modelled on the two real ones: an island of mutually referencing exports, and
 * a defence sitting inside a constructor nothing constructs.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build tool, no types, deliberately not compiled
import { blocksOf, stripComments, unreachable } from './reachable.mjs';

const names = (dead: Array<{ name: string }>) => dead.map((d) => d.name).sort();

describe('unreachable', () => {
  it('says nothing about code the entry point calls', () => {
    const files = {
      'src/cli.ts': "import { run } from './core.js';\nrun();\n",
      'src/core.ts': 'export function run() {\n  return helper();\n}\nfunction helper() {\n  return 1;\n}\n',
    };
    expect(unreachable(files, ['src/cli.ts'])).toEqual([]);
  });

  it('finds an island of exports that only reference each other', () => {
    // The shape of the deleted chain layer. Every symbol here has a caller, so
    // a reference count calls all three of them used. None is reachable.
    const files = {
      'src/cli.ts': "import { live } from './core.js';\nlive();\n",
      'src/core.ts': `
export function live() {
  return 1;
}
export function scan() {
  return classify(parse());
}
export function classify(x) {
  return x;
}
export function parse() {
  return 2;
}
`,
    };
    expect(names(unreachable(files, ['src/cli.ts']))).toEqual(['classify', 'parse', 'scan']);
  });

  it('does not let a comment keep a symbol alive', () => {
    // chain.ts opened by saying "Chain is never constructed", and a reference
    // count read its own warning as three uses of Chain.
    const files = {
      'src/cli.ts': 'export function main() {\n  return 1;\n}\nmain();\n',
      'src/dead.ts': '// Chain is never constructed, see below.\nexport class Chain {\n  go() {}\n}\n',
    };
    expect(names(unreachable(files, ['src/cli.ts']))).toEqual(['Chain']);
  });

  it('does not let a test keep product code alive, because a test is not a caller', () => {
    // The test file is simply not passed in. Stated as a test because the
    // temptation to add it as a root is exactly what kept classifyOracleLog.
    const files = {
      'src/cli.ts': 'export function main() {\n  return 1;\n}\nmain();\n',
      'src/orphan.ts': 'export function decode(x) {\n  return x;\n}\n',
    };
    expect(names(unreachable(files, ['src/cli.ts']))).toEqual(['decode']);
  });

  it('does not count a recursive call as a second symbol keeping it alive', () => {
    const files = {
      'src/cli.ts': 'export function main() {\n  return 1;\n}\nmain();\n',
      'src/dead.ts': 'export function walk(n) {\n  return n <= 0 ? 0 : walk(n - 1);\n}\n',
    };
    expect(names(unreachable(files, ['src/cli.ts']))).toEqual(['walk']);
  });

  it('reaches through a chain of calls rather than only one hop', () => {
    const files = {
      'src/cli.ts': "import { a } from './core.js';\na();\n",
      'src/core.ts': 'export function a() {\n  return b();\n}\nexport function b() {\n  return c();\n}\nexport function c() {\n  return 3;\n}\n',
    };
    expect(unreachable(files, ['src/cli.ts'])).toEqual([]);
  });
});

describe('stripComments', () => {
  it('removes a block comment and a trailing line comment', () => {
    expect(stripComments('/* Chain */\nconst a = 1; // Chain\n')).not.toContain('Chain');
  });

  it('leaves the scheme in a url alone', () => {
    // The reason this is a scanner and not `replace(/\/\/.*$/gm, '')`. Every
    // source module in this repo holds an https string.
    const src = "const BASE = 'https://gamma-api.polymarket.com';\n";
    expect(stripComments(src)).toContain('BASE');
  });

  it('keeps an interpolation, which is code inside a string', () => {
    // The false positive this check produced the first time it ran with a
    // scanner: `${BASE}` was read as string text, so BASE looked unreachable
    // in two source modules at once.
    const files = {
      'src/cli.ts': "import { url } from './net.js';\nurl();\n",
      'src/net.ts': "const BASE = 'https://example.com';\nexport function url() {\n  return `${BASE}/markets`;\n}\n",
    };
    expect(unreachable(files, ['src/cli.ts'])).toEqual([]);
  });

  it('does not let an object literal inside an interpolation close it early', () => {
    const files = {
      'src/cli.ts': "import { render } from './r.js';\nrender();\n",
      'src/r.ts': 'const pad = 2;\nexport function render() {\n  return `${JSON.stringify({ a: 1 })}${pad}`;\n}\n',
    };
    expect(unreachable(files, ['src/cli.ts'])).toEqual([]);
  });

  it('leaves a quote inside a regex character class alone', () => {
    // The second false positive: `'` in /[^\s'"]+/ opened a string that ran to
    // the end of the line and took the call after it with it.
    const files = {
      'src/cli.ts': "import { scrub } from './s.js';\nscrub('x');\n",
      'src/s.ts': "export function inner(m) {\n  return m;\n}\nexport function scrub(v) {\n  return v.replace(/https?:\\/\\/[^\\s'\"]+/g, (m) => inner(m));\n}\n",
    };
    expect(unreachable(files, ['src/cli.ts'])).toEqual([]);
  });

  it('counts a name inside a string as a reference, which is the safe direction', () => {
    // Documented rather than fixed. Telling a string literal from a regex from
    // a template needs a real parser, and every attempt at precision here
    // produced a false alarm instead. A missed piece of dead code leaves the
    // check quiet; a false alarm gets the check deleted.
    const files = {
      'src/cli.ts': "export function main() {\n  return 'see Chain for details';\n}\nmain();\n",
      'src/dead.ts': 'export class Chain {\n  go() {}\n}\n',
    };
    expect(unreachable(files, ['src/cli.ts'])).toEqual([]);
  });
});

describe('blocksOf', () => {
  it('keeps module level code in its own block, since it runs on import', () => {
    const blocks = blocksOf("import { x } from './x.js';\nx();\nexport function f() {}\n");
    expect(blocks[0].name).toBe('<module>');
    expect(blocks[0].body.join('\n')).toContain('x()');
    expect(blocks.map((b: { name: string }) => b.name)).toContain('f');
  });
});
