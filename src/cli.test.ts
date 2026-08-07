import { describe, expect, it } from 'vitest';
import { parseArgs } from './cli.js';

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
});
