/**
 * Fixtures here are real. Every lifecycle string was pulled from Gamma while
 * planning this tool, and the round counts are what actually happened to those
 * markets. If a refactor breaks one of these, the parser is wrong, not the test.
 */

import { describe, expect, it } from 'vitest';
import {
  disputeWeight, formatSteps, normaliseStep, normaliseSteps, parseDispute, parseMarketDate,
} from './dispute.js';
import type { Market } from '../types.js';

function market(steps: string[], overrides: Partial<Market> = {}): Market {
  return {
    conditionId: '0xtest',
    slug: 'test',
    question: 'test market',
    volume: 0,
    liquidity: 0,
    closed: false,
    active: true,
    negRisk: false,
    resolutionSteps: normaliseSteps(steps),
    tokenIds: [],
    outcomes: [],
    outcomePrices: [],
    ...overrides,
  };
}

describe('normaliseStep', () => {
  it('accepts the values Gamma actually emits', () => {
    expect(normaliseStep('proposed')).toBe('proposed');
    expect(normaliseStep('disputed')).toBe('disputed');
    expect(normaliseStep('resolved')).toBe('resolved');
  });

  it('is case and whitespace insensitive', () => {
    expect(normaliseStep('  Disputed ')).toBe('disputed');
  });

  it('keeps unrecognised values rather than dropping them', () => {
    // Dropping would silently shorten the lifecycle and undercount rounds.
    expect(normaliseStep('escalated')).toBe('unknown');
    expect(normaliseStep(null)).toBe('unknown');
    expect(normaliseSteps(['proposed', 42])).toEqual(['proposed', 'unknown']);
  });

  it('treats a non-array lifecycle as empty', () => {
    expect(normaliseSteps(undefined)).toEqual([]);
    expect(normaliseSteps('proposed')).toEqual([]);
  });
});

describe('parseDispute: real markets', () => {
  it('counts zero rounds for a clean resolution', () => {
    // The common case: 53 of 100 top closed markets looked exactly like this.
    const d = parseDispute(market(['proposed', 'resolved']));
    expect(d.rounds).toBe(0);
    expect(d.contested).toBe(false);
    expect(d.phase).toBe('settled');
  });

  it('counts two rounds on the $375M MicroStrategy market', () => {
    // "MicroStrategy sells any Bitcoin by May 31, 2026?", $375,813,105 volume.
    const d = parseDispute(market(['proposed', 'disputed', 'proposed', 'disputed']));
    expect(d.rounds).toBe(2);
    expect(d.contested).toBe(true);
    expect(d.phase).toBe('in-dispute');
  });

  it('counts five rounds on the $242M Zelenskyy suit market', () => {
    // "Will Zelenskyy wear a suit before July?", the most contested market
    // in the sample, and the end-to-end fixture named in the plan.
    const steps = ['proposed', 'disputed', 'proposed', 'disputed', 'proposed',
                   'disputed', 'proposed', 'disputed', 'proposed', 'disputed'];
    const d = parseDispute(market(steps));
    expect(d.rounds).toBe(5);
    expect(d.steps).toHaveLength(10);
  });

  it('reports settled when a contested market finally lands', () => {
    const d = parseDispute(market(['proposed', 'disputed', 'proposed', 'resolved']));
    expect(d.rounds).toBe(1);
    expect(d.contested).toBe(true);
    expect(d.phase).toBe('settled');
  });

  it('reports proposed while the bond window is open', () => {
    expect(parseDispute(market(['proposed'])).phase).toBe('proposed');
  });
});

describe('parseDispute: edges', () => {
  it('calls an empty lifecycle undisputed on an open market', () => {
    const d = parseDispute(market([]));
    expect(d.phase).toBe('undisputed');
    expect(d.rounds).toBe(0);
  });

  it('calls an empty lifecycle settled on a closed market', () => {
    // 26 of 100 closed markets carried no UMA lifecycle at all.
    expect(parseDispute(market([], { closed: true })).phase).toBe('settled');
  });

  it('prefers the UMA deadline over the market end date', () => {
    const d = parseDispute(
      market(['proposed'], { umaEndDate: '2026-08-10T00:00:00Z', endDate: '2026-09-01T00:00:00Z' }),
    );
    expect(d.deadline?.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('leaves the deadline undefined rather than inventing one', () => {
    expect(parseDispute(market(['proposed'])).deadline).toBeUndefined();
    expect(parseDispute(market(['proposed'], { endDate: 'not a date' })).deadline).toBeUndefined();
  });

  it('does not let an unknown step inflate the round count', () => {
    expect(parseDispute(market(['proposed', 'escalated', 'resolved'])).rounds).toBe(0);
  });
});

describe('parseMarketDate', () => {
  it('repairs the non-ISO closedTime shape Gamma serves', () => {
    expect(parseMarketDate('2025-07-09 00:30:39+00')?.toISOString())
      .toBe('2025-07-09T00:30:39.000Z');
  });

  it('treats a timestamp without a zone as UTC', () => {
    expect(parseMarketDate('2026-08-10T12:30:00')?.toISOString())
      .toBe('2026-08-10T12:30:00.000Z');
  });

  it('accepts a calendar-only value at UTC midnight', () => {
    expect(parseMarketDate('2026-08-10')?.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('rejects ambiguous and impossible calendar dates', () => {
    expect(parseMarketDate('01/02/2026')).toBeUndefined();
    expect(parseMarketDate('2026-02-30T00:00:00Z')).toBeUndefined();
  });
});

describe('formatSteps', () => {
  it('shows direction, not just a total', () => {
    expect(formatSteps(normaliseSteps(['proposed', 'disputed', 'proposed', 'resolved'])))
      .toBe('P→D→P→R');
  });

  it('marks an empty lifecycle rather than rendering blank', () => {
    expect(formatSteps([])).toBe('—');
  });
});

describe('disputeWeight', () => {
  it('ranks a contested small market above a clean huge one', () => {
    const contested = parseDispute(market(['proposed', 'disputed']));
    const clean = parseDispute(market(['proposed', 'resolved']));
    expect(disputeWeight(contested, 1_000_000)).toBeGreaterThan(disputeWeight(clean, 300_000_000));
  });

  it('ranks more rounds above fewer', () => {
    const two = parseDispute(market(['proposed', 'disputed', 'proposed', 'disputed']));
    const one = parseDispute(market(['proposed', 'disputed']));
    expect(disputeWeight(two, 1)).toBeGreaterThan(disputeWeight(one, 1e9));
  });

  it('breaks ties on pool size', () => {
    const d = parseDispute(market(['proposed', 'disputed']));
    expect(disputeWeight(d, 10_000_000)).toBeGreaterThan(disputeWeight(d, 10_000));
  });

  it('survives a zero pool', () => {
    expect(Number.isFinite(disputeWeight(parseDispute(market([])), 0))).toBe(true);
  });
});
