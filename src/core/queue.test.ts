import { describe, expect, it } from 'vitest';
import { queue, waited } from './queue.js';
import type { Market, ResolutionStep } from '../types.js';

function market(
  id: string,
  steps: ResolutionStep[],
  dates: Partial<Pick<Market, 'umaEndDate' | 'closedTime' | 'endDate'>> = {},
  volume = 1_000_000,
): Market {
  return {
    conditionId: `0x${id.repeat(64).slice(0, 64)}`,
    slug: `slug-${id}`,
    question: `question ${id}`,
    volume,
    liquidity: 0,
    closed: true,
    active: true,
    negRisk: false,
    resolutionSteps: steps,
    tokenIds: [],
    outcomes: ['Yes', 'No'],
    outcomePrices: [1, 0],
    ...dates,
  };
}

const NOW = new Date('2026-08-07T12:00:00.000Z');

describe('queue', () => {
  it('separates unfinished from finished and from never-started', () => {
    const scan = queue(
      [
        market('a', ['proposed']),
        market('b', ['proposed', 'disputed']),
        market('c', ['proposed', 'disputed', 'resolved']),
        market('d', []),
        market('e', []),
      ],
      NOW,
    );

    expect(scan.pending).toHaveLength(2);
    expect(scan.finished).toBe(1);
    expect(scan.noLifecycle).toBe(2);
    expect(scan.scanned).toBe(5);
  });

  it('counts a market that never reached the oracle apart from one still in it', () => {
    // These are different statements and the difference is the whole view. A
    // market with no lifecycle is not waiting on anything.
    const scan = queue([market('a', [])], NOW);
    expect(scan.pending).toHaveLength(0);
    expect(scan.noLifecycle).toBe(1);
  });

  it('takes the clock from the UMA deadline first', () => {
    const scan = queue(
      [
        market('a', ['proposed'], {
          umaEndDate: '2026-08-01T12:00:00Z',
          closedTime: '2026-07-01 12:00:00+00',
          endDate: '2026-06-01T12:00:00Z',
        }),
      ],
      NOW,
    );

    expect(scan.pending[0]?.waited).toBe(6 * 86_400_000);
  });

  it('falls back through closedTime, which Gamma does not serve as ISO', () => {
    const scan = queue([market('a', ['proposed'], { closedTime: '2026-08-05 12:00:00+00' })], NOW);
    expect(scan.pending[0]?.waited).toBe(2 * 86_400_000);
  });

  it('sorts longest wait first and puts unknown waits last', () => {
    const scan = queue(
      [
        market('a', ['proposed'], { umaEndDate: '2026-08-06T12:00:00Z' }),
        market('b', ['proposed']),
        market('c', ['proposed'], { umaEndDate: '2026-01-01T12:00:00Z' }),
      ],
      NOW,
    );

    expect(scan.pending.map((p) => p.market.slug)).toEqual(['slug-c', 'slug-a', 'slug-b']);
    expect(scan.undated).toBe(1);
  });

  it('does not sort an unknown wait as zero, which would bury it mid-table', () => {
    const scan = queue(
      [
        market('undated', ['proposed']),
        market('recent', ['proposed'], { umaEndDate: '2026-08-07T11:00:00Z' }),
      ],
      NOW,
    );
    expect(scan.pending.at(-1)?.market.slug).toBe('slug-undated');
  });

  it('reports a deadline in the future as a negative wait, not as overdue', () => {
    const scan = queue([market('a', ['proposed'], { umaEndDate: '2026-09-01T12:00:00Z' })], NOW);
    expect(scan.pending[0]?.waited).toBeLessThan(0);
    expect(waited(scan.pending[0]?.waited)).toBe('not yet due');
  });

  it('treats a reset as still in flight', () => {
    expect(queue([market('a', ['proposed', 'reset'])], NOW).pending).toHaveLength(1);
  });
});

describe('waited', () => {
  it('says unknown rather than zero when there is no clock', () => {
    expect(waited(undefined)).toBe('unknown');
  });

  it('scales to the unit a reader cares about', () => {
    expect(waited(30 * 60_000)).toBe('30m');
    expect(waited(5 * 3_600_000)).toBe('5h');
    expect(waited(10 * 86_400_000)).toBe('10d');
    expect(waited(400 * 86_400_000)).toBe('13mo');
  });
});
