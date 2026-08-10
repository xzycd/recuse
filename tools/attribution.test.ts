import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build tool, no types, deliberately not compiled
import { isDisallowedAttribution } from './attribution.mjs';

const owner = 'Audangas <gjokulyte3@gmail.com>';

describe('isDisallowedAttribution', () => {
  it('allows GitHub to repeat the sole author under an existing identity', () => {
    expect(
      isDisallowedAttribution(
        `Co-authored-by: ${owner}`,
        new Set([owner, 'Audangas <94250736+xzycd@users.noreply.github.com>']),
        new Set(['Audangas']),
      ),
    ).toBe(false);
  });

  it('rejects an identity that has never authored a commit', () => {
    expect(
      isDisallowedAttribution(
        'Co-authored-by: Claude <bot@example.com>',
        new Set([owner]),
        new Set(['Audangas']),
      ),
    ).toBe(true);
  });

  it('rejects co-author trailers once the history has multiple author names', () => {
    expect(
      isDisallowedAttribution(
        `Co-authored-by: ${owner}`,
        new Set([owner]),
        new Set(['Audangas', 'Another Person']),
      ),
    ).toBe(true);
  });

  it('rejects malformed empty co-author trailers', () => {
    expect(
      isDisallowedAttribution('Co-authored-by:', new Set([owner]), new Set(['Audangas'])),
    ).toBe(true);
  });

  it('rejects tool attribution markers', () => {
    expect(
      isDisallowedAttribution('Generated with Claude Code', new Set([owner]), new Set(['Audangas'])),
    ).toBe(true);
    expect(
      isDisallowedAttribution('🤖 generated', new Set([owner]), new Set(['Audangas'])),
    ).toBe(true);
  });

  it('ignores an ordinary commit message line', () => {
    expect(
      isDisallowedAttribution('harden response parsing', new Set([owner]), new Set(['Audangas'])),
    ).toBe(false);
  });
});
