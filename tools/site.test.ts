/**
 * The site is a second render target, so it needs its own escaping.
 *
 * `core/safe.ts` strips what a *terminal* acts on, at ingest. A browser acts on
 * a different set entirely: `<` is inert on a terminal and is markup here. So
 * neither pass replaces the other, and these tests exist because a market
 * question and a display name are both attacker-controlled text that end up
 * inside HTML on a page making claims about the account that chose them.
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build tool, no types, deliberately not compiled
import { esc, pageName } from './site.mjs';

describe('esc', () => {
  it('neutralises a script tag in a market question', () => {
    const out = esc('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('closes off an attribute break out', () => {
    // A display name is interpolated into content and into meta tags, so both
    // quote styles have to go.
    expect(esc('" onload="alert(1)')).toBe('&quot; onload=&quot;alert(1)');
    expect(esc("' onload='alert(1)")).toBe('&#39; onload=&#39;alert(1)');
  });

  it('escapes the ampersand first, so nothing is double decoded', () => {
    expect(esc('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('renders empty for absent values rather than the string undefined', () => {
    expect(esc(undefined)).toBe('');
    expect(esc(null)).toBe('');
  });

  it('leaves ordinary market text alone', () => {
    expect(esc('Will Zelenskyy wear a suit before July?')).toBe(
      'Will Zelenskyy wear a suit before July?',
    );
  });
});

describe('pageName', () => {
  const market = (slug: string, conditionId = '0xabc') => ({ market: { slug, conditionId } });

  it('builds a flat filename from the slug', () => {
    expect(pageName(market('will-zelenskyy-wear-a-suit'))).toBe('will-zelenskyy-wear-a-suit.html');
  });

  it('cannot escape the output directory', () => {
    // A slug is remote text. Path separators and dots are the whole risk here,
    // since this value becomes a filename the generator writes to.
    expect(pageName(market('../../etc/passwd'))).not.toContain('..');
    expect(pageName(market('../../etc/passwd'))).not.toContain('/');
    expect(pageName(market('a/b/c'))).toBe('a-b-c.html');
  });

  it('strips anything that is not url safe, and does not leave a trailing hyphen', () => {
    expect(pageName(market('Foo Bar!! <b>'))).toBe('foo-bar-b.html');
  });

  it('falls back to the condition id when there is no slug', () => {
    expect(pageName(market('', '0xdeadbeef'))).toBe('0xdeadbeef.html');
  });

  it('never returns a bare extension', () => {
    expect(pageName(market('', '!!!'))).toBe('market.html');
  });
});
