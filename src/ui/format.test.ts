import { describe, expect, it } from 'vitest';
import {
  clip, count, label, meter, money, padEnd, padStart, pct, shortAddress, until, widthOf,
} from './format.js';

describe('clip', () => {
  it('marks that something was cut', () => {
    expect(clip('abcdefgh', 5)).toBe('abcd…');
    expect(clip('abc', 5)).toBe('abc');
  });

  it('counts by code point, so an astral character is never split', () => {
    // Cutting a surrogate pair in half leaves a lone surrogate, which renders
    // as a replacement box and takes a cell the column did not budget for.
    const text = 'a\u{1F600}\u{1F600}b';
    expect(widthOf(text)).toBe(4);
    expect(clip(text, 3)).toBe('a\u{1F600}…');
    expect([...clip(text, 3)]).toHaveLength(3);
  });

  it('returns nothing at zero width', () => {
    expect(clip('abc', 0)).toBe('');
  });
});

describe('padEnd and padStart', () => {
  it('produce exactly the requested number of cells', () => {
    for (const text of ['', 'a', 'abcdefghij', 'a\u{1F600}b']) {
      expect(widthOf(padEnd(text, 8))).toBe(8);
      expect(widthOf(padStart(text, 8))).toBe(8);
    }
  });

  it('pads to width even when the input has astral characters', () => {
    // String.prototype.padEnd counts UTF-16 units, so it reads two surrogate
    // pairs as four and pads only two spaces. The result is the right length
    // and the wrong width, which shifts every column to its right.
    expect(widthOf(padEnd('\u{1F600}\u{1F600}', 6))).toBe(6);
    expect(widthOf('\u{1F600}\u{1F600}'.padEnd(6))).toBe(4);
  });

  it('truncates rather than overflowing when the input is too long', () => {
    expect(widthOf(padEnd('a'.repeat(40), 10))).toBe(10);
  });
});

describe('money and count', () => {
  it('scales without inventing precision', () => {
    expect(money(242_200_000)).toBe('$242.2M');
    expect(money(1_500_000_000)).toBe('$1.5B');
    expect(money(2400)).toBe('$2K');
    expect(money(12)).toBe('$12');
  });

  it('handles a negative, which a gain column will produce', () => {
    expect(money(-1_200_000)).toBe('$-1.2M');
  });

  it('drops the currency mark on token counts', () => {
    expect(count(52_137_899)).toBe('52.1M');
    expect(count(907)).toBe('907');
  });
});

describe('pct and meter', () => {
  it('rounds a share to whole percent', () => {
    expect(pct(0.8532)).toBe('85%');
    expect(pct(0)).toBe('0%');
  });

  it('stays coarse, because the underlying share is of a truncated list', () => {
    expect(meter(0.9)).toBe('●●●');
    expect(meter(0.5)).toBe('●●○');
    expect(meter(0.1)).toBe('●○○');
    expect(meter(0)).toBe('○○○');
  });

  it('always occupies three cells', () => {
    for (const share of [0, 0.2, 0.5, 0.99, 1]) expect(widthOf(meter(share))).toBe(3);
  });
});

describe('until', () => {
  const now = new Date('2026-08-07T00:00:00Z');

  it('counts forward and backward with a sign', () => {
    expect(until(new Date('2026-08-07T02:00:00Z'), now)).toBe('2h');
    expect(until(new Date('2026-08-05T00:00:00Z'), now)).toBe('-2d');
  });

  it('has a placeholder for a market with no clock', () => {
    expect(until(undefined, now)).toBe('—');
  });
});

describe('label', () => {
  const ADDR = '0x614f8c216086a1b7eead36b89b456938406d3b8a';

  it('never lets a chosen name replace the address it is a claim about', () => {
    // The whole point. A wallet that calls itself another wallet's address, or
    // "Polymarket", still renders next to the address the row is really about.
    const out = label('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', ADDR, 30, true);
    expect(out).toMatch(/0x614f…3b8a$/);
  });

  it('keeps the full address when the column can hold one', () => {
    expect(label(undefined, ADDR, 44, false)).toBe(ADDR);
  });

  it('abbreviates rather than truncating, which would look like an id', () => {
    const out = label(undefined, ADDR, 28, true);
    expect(out).toBe('0x614f…3b8a');
    expect(out).not.toMatch(/^0x614f8c216086a1b7eead36b89b4…$/);
  });

  it('fits the name and the address inside the column budget', () => {
    for (const width of [14, 20, 28, 44]) {
      expect(widthOf(label('NewDarkShark', ADDR, width, true))).toBeLessThanOrEqual(width);
    }
  });

  it('drops the name rather than the address when there is no room', () => {
    expect(label('NewDarkShark', ADDR, 14, true)).toBe('0x614f…3b8a');
  });

  it('counts an astral name by code point, so the column does not shift', () => {
    // Same class of bug as padEnd counting UTF-16 units: a name of surrogate
    // pairs must not buy itself extra cells.
    const wide = label('𝕏𝕏𝕏𝕏𝕏𝕏', ADDR, 24, true);
    expect(widthOf(wide)).toBeLessThanOrEqual(24);
  });

  it('leaves a short address alone', () => {
    expect(shortAddress('0x1234')).toBe('0x1234');
  });
});
