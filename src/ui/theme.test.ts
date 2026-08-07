import { describe, expect, it } from 'vitest';
import { colourise, detectDepth, resolveTheme, THEMES, themeNames } from './theme.js';

describe('resolveTheme', () => {
  it('falls back rather than failing on a name nobody defined', () => {
    // A typo in an environment variable should not stop someone reading a
    // market, so this returns the default instead of throwing.
    expect(resolveTheme('nonsense').name).toBe('carbon');
  });

  it('is case and whitespace insensitive', () => {
    expect(resolveTheme('  EMBER ').name).toBe('ember');
  });

  it('gives every theme a full three step ramp', () => {
    for (const name of themeNames()) {
      const t = THEMES[name]!;
      expect(t.ramp).toHaveLength(3);
      for (const hex of t.ramp) expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('detectDepth', () => {
  it('honours NO_COLOR above everything else', () => {
    expect(detectDepth({ NO_COLOR: '1', COLORTERM: 'truecolor', TERM: 'xterm-256color' })).toBe(0);
  });

  it('treats an empty NO_COLOR as unset, per the convention', () => {
    expect(detectDepth({ NO_COLOR: '', COLORTERM: 'truecolor' })).toBe(24);
  });

  it('reads truecolor from COLORTERM', () => {
    expect(detectDepth({ COLORTERM: '24bit' })).toBe(24);
  });

  it('falls back to 256 and then to 16', () => {
    expect(detectDepth({ TERM: 'xterm-256color' })).toBe(256);
    expect(detectDepth({ TERM: 'xterm' })).toBe(16);
  });

  it('gives a dumb terminal and a bare environment nothing', () => {
    expect(detectDepth({ TERM: 'dumb' })).toBe(0);
    expect(detectDepth({})).toBe(0);
  });
});

describe('colourise', () => {
  it('emits nothing at depth zero, so piped output stays clean', () => {
    expect(colourise('5×', '#ff0000', 0)).toBe('5×');
  });

  it('emits the exact rgb at truecolor', () => {
    expect(colourise('x', '#ff8000', 24)).toBe('[38;2;255;128;0mx[39m');
  });

  it('closes every sequence it opens', () => {
    for (const depth of [16, 256, 24] as const) {
      const out = colourise('x', '#7de2ff', depth);
      expect(out.startsWith('[')).toBe(true);
      expect(out.endsWith('[39m')).toBe(true);
    }
  });

  it('leaves an empty string alone rather than emitting a bare escape pair', () => {
    expect(colourise('', '#ffffff', 24)).toBe('');
  });
});
