import { describe, expect, it } from 'vitest';
import { span, summarise } from './ledger.js';
import type { EventKind, WatchEvent } from './watch.js';

function event(
  conditionId: string,
  kind: EventKind,
  at: string,
  rounds = 0,
  pool = 1_000_000,
): WatchEvent {
  return {
    at,
    kind,
    conditionId,
    slug: `slug-${conditionId}`,
    question: `question ${conditionId}`,
    rounds,
    previousRounds: rounds,
    phase: 'proposed',
    steps: ['proposed'],
    pool,
    origin: 'discovery',
  };
}

describe('summarise', () => {
  it('reports an empty log as empty rather than as zero activity', () => {
    const s = summarise([], 0);
    expect(s.events).toBe(0);
    expect(s.markets).toBe(0);
    expect(s.first).toBeUndefined();
    expect(span(s)).toBeUndefined();
  });

  it('tallies kinds and distinct markets', () => {
    const s = summarise(
      [
        event('a', 'proposed', '2026-08-01T00:00:00Z'),
        event('a', 'disputed', '2026-08-02T00:00:00Z', 1),
        event('b', 'disputed', '2026-08-03T00:00:00Z', 1),
      ],
      0,
    );

    expect(s.events).toBe(3);
    expect(s.markets).toBe(2);
    expect(s.byKind.disputed).toBe(2);
    expect(s.byKind.proposed).toBe(1);
    // Kinds that did not happen are absent, not present as zero.
    expect(s.byKind.rewritten).toBeUndefined();
  });

  it('carries the unreadable line count through rather than dropping it', () => {
    expect(summarise([event('a', 'proposed', '2026-08-01T00:00:00Z')], 4).skipped).toBe(4);
  });

  it('takes the span from the extremes, not the ends of the array', () => {
    // The log is append only but is also hand editable and concatenable. Taking
    // events[0] and events.at(-1) would produce a span running backwards on a
    // file somebody spliced.
    const s = summarise(
      [
        event('a', 'proposed', '2026-08-05T00:00:00Z'),
        event('b', 'proposed', '2026-08-01T00:00:00Z'),
        event('c', 'proposed', '2026-08-03T00:00:00Z'),
      ],
      0,
    );

    expect(s.first).toBe('2026-08-01T00:00:00Z');
    expect(s.last).toBe('2026-08-05T00:00:00Z');
    expect(span(s)).toBe(4);
  });

  it('ranks markets by how often they moved', () => {
    const s = summarise(
      [
        event('quiet', 'proposed', '2026-08-01T00:00:00Z'),
        event('loud', 'proposed', '2026-08-01T00:00:00Z'),
        event('loud', 'disputed', '2026-08-02T00:00:00Z', 1),
        event('loud', 'disputed', '2026-08-03T00:00:00Z', 2),
      ],
      0,
    );

    expect(s.busiest[0]?.conditionId).toBe('loud');
    expect(s.busiest[0]?.events).toBe(3);
    // Rounds come from the latest event, not the first one seen.
    expect(s.busiest[0]?.rounds).toBe(2);
  });

  it('takes the latest state by timestamp rather than by arrival order', () => {
    const s = summarise(
      [
        event('a', 'resolved', '2026-08-09T00:00:00Z', 2),
        event('a', 'disputed', '2026-08-01T00:00:00Z', 1),
      ],
      0,
    );

    expect(s.busiest[0]?.lastKind).toBe('resolved');
    expect(s.busiest[0]?.rounds).toBe(2);
  });

  it('lists what has not settled, and excludes what has', () => {
    const s = summarise(
      [
        event('open', 'disputed', '2026-08-02T00:00:00Z', 1),
        event('done', 'resolved', '2026-08-02T00:00:00Z', 1),
        event('landed', 'settled', '2026-08-02T00:00:00Z', 1),
      ],
      0,
    );

    expect(s.unfinished.map((m) => m.conditionId)).toEqual(['open']);
  });

  it('honours the limit on both lists', () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      event(`m${i}`, 'disputed', '2026-08-02T00:00:00Z', 1),
    );
    const s = summarise(events, 0, 5);

    expect(s.busiest).toHaveLength(5);
    expect(s.unfinished).toHaveLength(5);
    // The full count is still reported, so the list reads as a top slice.
    expect(s.markets).toBe(20);
  });
});
