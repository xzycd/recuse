import { describe, expect, it } from 'vitest';
import { compare, compareSteps, passesFilters, snapshot } from './watch.js';
import type { Market, ResolutionStep } from '../types.js';
import type { Seen, WatchEvent } from './watch.js';

const NOW = new Date('2026-08-07T09:30:00Z');

function market(overrides: Partial<Market> = {}): Market {
  return {
    conditionId: `0x${'a'.repeat(64)}`,
    slug: 'zelenskyy-suit',
    question: 'Will Zelenskyy wear a suit before July?',
    volume: 242_200_000,
    liquidity: 0,
    closed: false,
    active: true,
    negRisk: false,
    resolutionSteps: [],
    tokenIds: [],
    outcomes: ['Yes', 'No'],
    outcomePrices: [0.4, 0.6],
    ...overrides,
  };
}

const seenWith = (steps: ResolutionStep[], settled = false): Seen =>
  snapshot(market({ resolutionSteps: steps, outcomePrices: settled ? [0, 1] : [0.4, 0.6] }), NOW);

const opts = { origin: 'watchlist' as const, baselineDone: true, now: NOW };

describe('compareSteps', () => {
  it('reports nothing when the lifecycle is identical', () => {
    expect(compareSteps(['proposed'], ['proposed'])).toEqual({ kind: 'unchanged' });
  });

  it('reports only what was appended', () => {
    expect(compareSteps(['proposed'], ['proposed', 'disputed'])).toEqual({
      kind: 'appended',
      steps: ['disputed'],
    });
  });

  it('treats an empty history growing as an append', () => {
    expect(compareSteps([], ['proposed', 'disputed'])).toEqual({
      kind: 'appended',
      steps: ['proposed', 'disputed'],
    });
  });

  it('calls a changed prefix rewritten rather than quietly re-baselining', () => {
    // Gamma editing settled history under us is itself the news, and silently
    // accepting the new version is how a watcher stops being worth running.
    expect(compareSteps(['proposed', 'disputed'], ['proposed', 'resolved'])).toEqual({
      kind: 'rewritten',
    });
  });

  it('calls a shortened history rewritten', () => {
    expect(compareSteps(['proposed', 'disputed'], ['proposed'])).toEqual({ kind: 'rewritten' });
  });
});

describe('compare, first sight', () => {
  it('reports nothing on the very first pass, however contested', () => {
    // Firing on everything the first time it runs is how a tool teaches someone
    // to ignore it. The first pass is a baseline and says so elsewhere.
    const { events, next } = compare(undefined, market({ resolutionSteps: ['proposed', 'disputed'] }), {
      ...opts,
      baselineDone: false,
    });
    expect(events).toEqual([]);
    expect(next.steps).toEqual(['proposed', 'disputed']);
  });

  it('reports a contested market entering the scan after the baseline exists', () => {
    const { events } = compare(undefined, market({ resolutionSteps: ['proposed', 'disputed'] }), opts);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'appeared', rounds: 1, previousRounds: 0 });
  });

  it('stays quiet about a market that appears with no dispute at all', () => {
    const { events } = compare(undefined, market({ resolutionSteps: ['proposed'] }), opts);
    expect(events).toEqual([]);
  });
});

describe('compare, changes', () => {
  it('reports nothing when nothing moved', () => {
    const before = seenWith(['proposed', 'disputed']);
    const { events } = compare(before, market({ resolutionSteps: ['proposed', 'disputed'] }), opts);
    expect(events).toEqual([]);
  });

  it('reports a new dispute with the round count as of that step', () => {
    const before = seenWith(['proposed', 'disputed', 'proposed']);
    const { events } = compare(
      before,
      market({ resolutionSteps: ['proposed', 'disputed', 'proposed', 'disputed'] }),
      opts,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'disputed', rounds: 2, previousRounds: 1 });
  });

  it('emits one event per appended step, in order, not one collapsed event', () => {
    // Collapsing three steps into one would lose which of them was the dispute,
    // and the dispute is the only one anyone is waiting for.
    const before = seenWith(['proposed']);
    const { events } = compare(
      before,
      market({ resolutionSteps: ['proposed', 'disputed', 'proposed', 'resolved'] }),
      opts,
    );
    expect(events.map((e) => e.kind)).toEqual(['disputed', 'proposed', 'resolved']);
    expect(events.map((e) => e.rounds)).toEqual([1, 1, 1]);
  });

  it('counts each dispute as it passes when several land at once', () => {
    const before = seenWith([]);
    const { events } = compare(
      before,
      market({ resolutionSteps: ['proposed', 'disputed', 'proposed', 'disputed'] }),
      opts,
    );
    const disputes = events.filter((e) => e.kind === 'disputed');
    expect(disputes.map((e) => e.rounds)).toEqual([1, 2]);
  });

  it('does not report an unknown step as an event', () => {
    const before = seenWith(['proposed']);
    const { events } = compare(
      before,
      market({ resolutionSteps: ['proposed', 'unknown'] }),
      opts,
    );
    expect(events).toEqual([]);
  });

  it('reports a rewritten lifecycle', () => {
    const before = seenWith(['proposed', 'disputed']);
    const { events } = compare(before, market({ resolutionSteps: ['proposed', 'resolved'] }), opts);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('rewritten');
  });

  it('reports a settlement that arrives as a price change with no new step', () => {
    // Gamma does not always append `resolved` when a market lands. Without this
    // a settlement on a watched market would pass in silence.
    const before = seenWith(['proposed', 'disputed'], false);
    const { events } = compare(
      before,
      market({ resolutionSteps: ['proposed', 'disputed'], outcomePrices: [0, 1] }),
      opts,
    );
    expect(events.map((e) => e.kind)).toEqual(['settled']);
  });

  it('does not report the same settlement twice', () => {
    const before = seenWith(['proposed', 'disputed'], true);
    const { events } = compare(
      before,
      market({ resolutionSteps: ['proposed', 'disputed'], outcomePrices: [0, 1] }),
      opts,
    );
    expect(events).toEqual([]);
  });

  it('carries the terms a reader needs to act, not just the kind', () => {
    const before = seenWith(['proposed']);
    const { events } = compare(
      before,
      market({ resolutionSteps: ['proposed', 'disputed'] }),
      opts,
    );
    expect(events[0]).toMatchObject({
      question: 'Will Zelenskyy wear a suit before July?',
      slug: 'zelenskyy-suit',
      pool: 242_200_000,
      origin: 'watchlist',
      at: NOW.toISOString(),
    });
  });
});

describe('passesFilters', () => {
  const event = { kind: 'disputed', pool: 1_000_000 } as WatchEvent;

  it('drops anything under the pool floor', () => {
    expect(passesFilters(event, { minPool: 2_000_000 })).toBe(false);
    expect(passesFilters(event, { minPool: 500_000 })).toBe(true);
  });

  it('keeps only the requested kinds', () => {
    expect(passesFilters(event, { kinds: new Set(['resolved']) })).toBe(false);
    expect(passesFilters(event, { kinds: new Set(['disputed']) })).toBe(true);
  });

  it('passes everything when nothing was asked for', () => {
    expect(passesFilters(event, {})).toBe(true);
  });
});
