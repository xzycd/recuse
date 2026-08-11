import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isEntrypoint, main, parseArgs, version } from './cli.js';

describe('parseArgs', () => {
  it('defaults to the radar', () => {
    const a = parseArgs([]);
    expect(a.command).toBe('radar');
    expect(a.json).toBe(false);
    expect(a.limit).toBe(25);
  });

  it('reads a command and its target', () => {
    const a = parseArgs(['market', 'zelenskyy-suit']);
    expect(a.command).toBe('market');
    expect(a.target).toBe('zelenskyy-suit');
  });

  it('accepts flags in any position', () => {
    const a = parseArgs(['--json', 'market', '0xabc', '--limit', '5']);
    expect(a).toMatchObject({ command: 'market', target: '0xabc', json: true, limit: 5 });
  });

  it('rejects an unknown option instead of ignoring it', () => {
    // Silently dropping a flag the user typed is how a tool answers a question
    // nobody asked. This is the same failure Gamma has, and it is not copied.
    expect(() => parseArgs(['--nope'])).toThrow(/unknown option/);
  });

  it('rejects malformed numeric flags instead of silently using a default', () => {
    expect(() => parseArgs(['--limit', 'abc'])).toThrow(/--limit needs/);
    expect(() => parseArgs(['--limit', '-1'])).toThrow(/at least 1/);
    expect(() => parseArgs(['--scan', '1.5'])).toThrow(/integer/);
    expect(() => parseArgs(['--min-pool', 'Infinity'])).toThrow(/number/);
    expect(() => parseArgs(['--scan', '10001'])).toThrow(/at most 10000/);
    expect(() => parseArgs(['--limit', '501'])).toThrow(/at most 500/);
  });

  it('rejects flags with missing values and extra positional arguments', () => {
    expect(() => parseArgs(['--limit'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--theme', '--json'])).toThrow(/needs a value/);
    expect(() => parseArgs(['market', 'one', 'two'])).toThrow(/unexpected argument/);
    expect(() => parseArgs(['queue', 'unused'])).toThrow(/unexpected argument/);
  });

  it('supports both colour spellings', () => {
    expect(parseArgs(['--no-color']).colour).toBe(false);
    expect(parseArgs(['--no-colour']).colour).toBe(false);
  });

  it('treats -h and --help alike', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['help']).help).toBe(true);
  });

  it('treats -v, --version and the version command alike', () => {
    expect(parseArgs(['-v']).version).toBe(true);
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['version']).version).toBe(true);
  });

  it('reads a theme name and the list request', () => {
    expect(parseArgs(['--theme', 'ember']).theme).toBe('ember');
    expect(parseArgs(['--theme', 'list']).theme).toBe('list');
    expect(() => parseArgs(['--theme', 'missing'])).toThrow(/unknown theme/);
  });

  it('draws the banner unless told not to', () => {
    expect(parseArgs([]).logo).toBe(true);
    expect(parseArgs(['--no-logo']).logo).toBe(false);
  });

  it('keeps the winner rebuild off the radar unless asked', () => {
    // It costs a trade-source read per row, so the radar does not pay for it
    // by default. `recuse market` does, because there it is one request.
    expect(parseArgs([]).winners).toBe(false);
    expect(parseArgs(['--winners']).winners).toBe(true);
  });

  it('takes winners as a command with a target', () => {
    const a = parseArgs(['winners', 'will-zelenskyy-wear-a-suit-before-july']);
    expect(a).toMatchObject({ command: 'winners', target: 'will-zelenskyy-wear-a-suit-before-july' });
  });

  it('rejects a winners limit the source would silently clamp', () => {
    expect(parseArgs(['winners', 'market', '--limit', '100']).limit).toBe(100);
    expect(() => parseArgs(['winners', 'market', '--limit', '101'])).toThrow(
      /--limit for winners must be at most 100/,
    );
  });
});

describe('CLI diagnostics', () => {
  it('strips terminal controls from rejected arguments', async () => {
    let written = '';
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      expect(await main(['--bad\u001b[2J'])).toBe(2);
    } finally {
      process.stderr.write = original;
    }

    expect(written).not.toContain('\u001b');
    expect(written).toContain('unknown option');
  });

  it('strips invisible direction changes from an unknown command', async () => {
    let written = '';
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written += String(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      expect(await main(['un\u202eknown'])).toBe(2);
    } finally {
      process.stderr.write = original;
    }

    expect(written).not.toContain('\u202e');
    expect(written).toContain('unknown command: unknown');
  });
});

describe('parseArgs, watch', () => {
  it('reads a subcommand and its target, not the subcommand as a market', () => {
    // Everywhere else the second positional is the market. Under watch it is
    // the action, and getting this wrong means looking up a market called "add".
    const a = parseArgs(['watch', 'add', 'zelenskyy-suit']);
    expect(a).toMatchObject({ command: 'watch', sub: 'add', target: 'zelenskyy-suit' });
  });

  it('leaves sub empty for the bare loop', () => {
    expect(parseArgs(['watch']).sub).toBeUndefined();
    expect(parseArgs(['watch', '--once']).sub).toBeUndefined();
  });

  it('still treats the second positional as a market for other commands', () => {
    expect(parseArgs(['market', 'add']).target).toBe('add');
    expect(parseArgs(['market', 'add']).sub).toBeUndefined();
  });

  it('defaults to a five minute loop with detail on', () => {
    const a = parseArgs(['watch']);
    expect(a.intervalMs).toBe(300_000);
    expect(a.once).toBe(false);
    expect(a.discover).toBe(false);
    expect(a.detail).toBe(true);
  });

  it('takes the interval in seconds', () => {
    expect(parseArgs(['watch', '--interval', '600']).intervalMs).toBe(600_000);
  });

  it('clamps a too-eager interval rather than rejecting it', () => {
    // Someone asking for five seconds wants it responsive. Giving them the
    // fastest polite rate serves that better than an error does, and disputes
    // do not move in seconds anyway.
    expect(parseArgs(['watch', '--interval', '5']).intervalMs).toBe(30_000);
    expect(() => parseArgs(['watch', '--interval', '0'])).toThrow(/at least/);
    expect(() => parseArgs(['watch', '--interval', 'soon'])).toThrow(/number/);
  });

  it('reads the filters', () => {
    const a = parseArgs(['watch', '--min-pool', '1000000', '--only', 'disputed,resolved']);
    expect(a.minPool).toBe(1_000_000);
    expect(a.only).toBe('disputed,resolved');
    expect(() => parseArgs(['watch', '--only', 'disputed,anything'])).toThrow(/unknown event kind/);
  });

  it('reads a webhook and lets detail be turned off', () => {
    const a = parseArgs(['watch', '--webhook', 'https://example.com/h', '--no-detail']);
    expect(a.webhook).toBe('https://example.com/h');
    expect(a.detail).toBe(false);
  });

  it('rejects an unknown subcommand rather than showing the watchlist', () => {
    expect(() => parseArgs(['watch', 'ad'])).toThrow(/unknown watch command/);
    expect(() => parseArgs(['watch', 'list', 'extra'])).toThrow(/unexpected argument/);
  });
});

describe('version', () => {
  it('reads the installed version rather than a copy that can drift', () => {
    // The update check compares against this. A hardcoded string here would
    // eventually tell someone they are current when they are not.
    expect(version()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
  });
});

describe('isEntrypoint', () => {
  // The whole point of these: the previous guard compared basenames, so an
  // installed `recuse` symlink pointing at `cli.js` failed it and the program
  // silently did nothing. Every one of these passed under the old guard except
  // the symlink case, which is the one that shipped.
  const real = '/pkg/dist/cli.js';
  const url = 'file:///pkg/dist/cli.js';
  const resolve = (path: string) => (path === '/usr/local/bin/recuse' ? real : path);

  it('runs when npm links the bin under a different name', () => {
    expect(isEntrypoint('/usr/local/bin/recuse', url, resolve)).toBe(true);
  });

  it('runs when node is handed the file directly', () => {
    expect(isEntrypoint(real, url, resolve)).toBe(true);
  });

  it('stays quiet when something else is the program', () => {
    expect(isEntrypoint('/pkg/node_modules/vitest/vitest.mjs', url, resolve)).toBe(false);
  });

  it('stays quiet when there is no argv[1] at all', () => {
    expect(isEntrypoint(undefined, url, resolve)).toBe(false);
  });

  it('treats an argv[1] that is not on disk as not this file', () => {
    // `node --eval` reports one. Throwing here would crash on import.
    const missing = () => {
      throw new Error('ENOENT');
    };
    expect(isEntrypoint('[eval]', url, missing)).toBe(false);
  });
});

describe('the built binary', () => {
  // The unit tests above cover the logic. This covers the thing that actually
  // broke: a real symlink, a real spawn, and stdout that has to contain
  // something. It needs dist/, which CI builds before it tests.
  const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

  it.skipIf(!existsSync(entry))('prints usage when run through a bin symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recuse-bin-'));
    try {
      const link = join(dir, 'recuse');
      symlinkSync(entry, link);
      const out = execFileSync(process.execPath, [link, '--help'], {
        encoding: 'utf8',
        env: { ...process.env, RECUSE_NO_UPDATE_CHECK: '1' },
      });
      expect(out).toContain('usage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(entry))('prints its package version through a bin symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'recuse-bin-'));
    try {
      const link = join(dir, 'recuse');
      symlinkSync(entry, link);
      const out = execFileSync(process.execPath, [link, '--version'], {
        encoding: 'utf8',
        env: { ...process.env, RECUSE_NO_UPDATE_CHECK: '1' },
      });
      expect(out.trim()).toBe(version());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(entry))('rejects a malformed wallet before any network request', () => {
    const result = spawnSync(process.execPath, [entry, 'wallet', '0x1', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, RECUSE_NO_UPDATE_CHECK: '1' },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('40 hexadecimal characters');
    expect(result.stdout).toBe('');
  });
});

describe('--version', () => {
  it('is parsed, and short', () => {
    expect(parseArgs(['--version']).version).toBe(true);
    expect(parseArgs(['-V']).version).toBe(true);
    // Distinct from -h, which is help. A CLI that answers one and errors on
    // the other is the one shape nobody expects.
    expect(parseArgs(['--help']).version).toBe(false);
  });

  const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

  it.skipIf(!existsSync(entry))('prints the number alone, with nothing around it', () => {
    // Read by a script comparing it against something. A banner, a spinner or
    // a trailing hint would all have to be stripped back off, and the version
    // is the one output here whose entire value is being exactly the number.
    const out = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' });
    expect(out.trim()).toBe(version());
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
