import { describe, expect, it } from 'vitest';
import { parseArgs, version } from './cli.js';

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

  it('keeps the default when a numeric flag is not a number', () => {
    expect(parseArgs(['--limit', 'abc']).limit).toBe(25);
  });

  it('supports both colour spellings', () => {
    expect(parseArgs(['--no-color']).colour).toBe(false);
    expect(parseArgs(['--no-colour']).colour).toBe(false);
  });

  it('treats -h and --help alike', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('reads a theme name and the list request', () => {
    expect(parseArgs(['--theme', 'ember']).theme).toBe('ember');
    expect(parseArgs(['--theme', 'list']).theme).toBe('list');
  });

  it('draws the banner unless told not to', () => {
    expect(parseArgs([]).logo).toBe(true);
    expect(parseArgs(['--no-logo']).logo).toBe(false);
  });

  it('keeps the winner rebuild off the radar unless asked', () => {
    // It costs a subgraph round trip per row, so the radar does not pay for it
    // by default. `recuse market` does, because there it is one request.
    expect(parseArgs([]).winners).toBe(false);
    expect(parseArgs(['--winners']).winners).toBe(true);
  });

  it('takes winners as a command with a target', () => {
    const a = parseArgs(['winners', 'will-zelenskyy-wear-a-suit-before-july']);
    expect(a).toMatchObject({ command: 'winners', target: 'will-zelenskyy-wear-a-suit-before-july' });
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
    expect(parseArgs(['watch', '--interval', '0']).intervalMs).toBe(300_000);
    expect(parseArgs(['watch', '--interval', 'soon']).intervalMs).toBe(300_000);
  });

  it('reads the filters', () => {
    const a = parseArgs(['watch', '--min-pool', '1000000', '--only', 'disputed,resolved']);
    expect(a.minPool).toBe(1_000_000);
    expect(a.only).toBe('disputed,resolved');
  });

  it('reads a webhook and lets detail be turned off', () => {
    const a = parseArgs(['watch', '--webhook', 'https://example.com/h', '--no-detail']);
    expect(a.webhook).toBe('https://example.com/h');
    expect(a.detail).toBe(false);
  });
});

describe('version', () => {
  it('reads the installed version rather than a copy that can drift', () => {
    // The update check compares against this. A hardcoded string here would
    // eventually tell someone they are current when they are not.
    expect(version()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+/);
  });
});
