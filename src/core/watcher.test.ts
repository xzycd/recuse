import { describe, expect, it } from 'vitest';
import { baselineAfterPass } from './watcher.js';

const NOW = new Date('2026-08-10T00:00:00.000Z');

describe('baselineAfterPass', () => {
  it('does not establish a baseline when every source failed', () => {
    expect(baselineAfterPass(undefined, false, NOW)).toEqual({ established: false });
  });

  it('establishes one after a pass that actually answered', () => {
    expect(baselineAfterPass(undefined, true, NOW)).toEqual({
      baselineAt: NOW.toISOString(),
      established: true,
    });
  });

  it('preserves the original baseline on later passes', () => {
    expect(baselineAfterPass('2026-08-01T00:00:00.000Z', false, NOW)).toEqual({
      baselineAt: '2026-08-01T00:00:00.000Z',
      established: false,
    });
  });
});
