import { describe, expect, it } from 'vitest';
import { filterAssessments, nextSort, sortAssessments, SORTS, viewport } from './rank.js';
import type { Assessment } from '../types.js';

const a = (
  question: string, rounds: number, pool: number, wiped?: number, deadline?: string,
): Assessment =>
  ({
    market: { question, slug: question.toLowerCase().replace(/\W+/g, '-'), conditionId: question },
    dispute: {
      rounds, contested: rounds > 0, phase: 'settled',
      steps: Array.from({ length: rounds }, () => 'disputed'),
      deadline: deadline ? new Date(deadline) : undefined,
    },
    concentration: wiped === undefined ? undefined : { meaning: 'wiped', totalSize: wiped },
    pool, caveats: [], actors: [], conflicts: [], tier: 'positions', fetchedAt: '',
  }) as unknown as Assessment;

const list = [
  a('Iran ceasefire', 3, 200_000_000, 108_600_000, '2026-09-01'),
  a('Zelenskyy suit', 5, 242_000_000, 52_100_000, '2026-08-10'),
  a('MicroStrategy bitcoin', 2, 375_800_000, 96_600_000),
];

describe('sortAssessments', () => {
  it('puts rounds above money by default', () => {
    // A $376M market nobody argued about is less interesting here than a $242M
    // one that went five rounds. A tool sorted by volume is just a list of big
    // markets, which everybody already has.
    expect(sortAssessments(list, 'rounds')[0]!.market.question).toBe('Zelenskyy suit');
  });

  it('sorts by money when asked', () => {
    expect(sortAssessments(list, 'pool')[0]!.market.question).toBe('MicroStrategy bitcoin');
  });

  it('sorts by how much was wiped out', () => {
    expect(sortAssessments(list, 'wiped')[0]!.market.question).toBe('Iran ceasefire');
  });

  it('sinks markets with no clock to the bottom rather than treating them as ancient', () => {
    const sorted = sortAssessments(list, 'ends');
    expect(sorted[0]!.market.question).toBe('Zelenskyy suit');
    expect(sorted[2]!.market.question).toBe('MicroStrategy bitcoin');
  });

  it('leaves the caller array untouched', () => {
    const before = list.map((x) => x.market.question);
    sortAssessments(list, 'pool');
    expect(list.map((x) => x.market.question)).toEqual(before);
  });
});

describe('nextSort', () => {
  it('cycles through every mode and returns to the start', () => {
    let mode = SORTS[0];
    for (let i = 0; i < SORTS.length; i++) mode = nextSort(mode);
    expect(mode).toBe(SORTS[0]);
  });
});

describe('filterAssessments', () => {
  it('matches the question, case insensitively', () => {
    expect(filterAssessments(list, 'iran')).toHaveLength(1);
    expect(filterAssessments(list, 'IRAN')).toHaveLength(1);
  });

  it('matches the slug too, so a pasted url fragment works', () => {
    expect(filterAssessments(list, 'zelenskyy-suit')).toHaveLength(1);
  });

  it('narrows on every term, because that is what a second word is for', () => {
    expect(filterAssessments(list, 'bitcoin microstrategy')).toHaveLength(1);
    expect(filterAssessments(list, 'bitcoin iran')).toHaveLength(0);
  });

  it('returns everything for an empty or whitespace query', () => {
    expect(filterAssessments(list, '')).toHaveLength(3);
    expect(filterAssessments(list, '   ')).toHaveLength(3);
  });
});

describe('viewport', () => {
  it('shows everything when it fits', () => {
    expect(viewport(5, 0, 10)).toEqual({ start: 0, end: 5 });
  });

  it('keeps a row of context ahead of the cursor', () => {
    // Without the margin the selection sticks to the edge of the window and
    // scrolling feels like it is fighting you.
    const { start, end } = viewport(100, 50, 10);
    expect(start).toBeLessThan(50);
    expect(end).toBeGreaterThan(50);
    expect(end - start).toBe(10);
  });

  it('clamps at both ends instead of scrolling past them', () => {
    expect(viewport(100, 0, 10)).toEqual({ start: 0, end: 10 });
    expect(viewport(100, 99, 10)).toEqual({ start: 90, end: 100 });
  });

  it('always returns a window of exactly the requested height when it can', () => {
    for (const cursor of [0, 1, 5, 40, 98, 99]) {
      const { start, end } = viewport(100, cursor, 12);
      expect(end - start).toBe(12);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(100);
    }
  });

  it('survives an empty list', () => {
    expect(viewport(0, 0, 10)).toEqual({ start: 0, end: 0 });
  });
});
