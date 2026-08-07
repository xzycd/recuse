import { describe, expect, it } from 'vitest';
import { movementRank, recall, recallNote } from './recall.js';
import { snapshot } from './watch.js';
import type { Assessment, Market, ResolutionStep } from '../types.js';

function market(id: string, steps: ResolutionStep[], prices: number[] = [0.6, 0.4]): Market {
  return {
    conditionId: id,
    slug: `slug-${id.slice(-4)}`,
    question: `question ${id.slice(-4)}`,
    volume: 1_000_000,
    liquidity: 0,
    closed: false,
    active: true,
    negRisk: false,
    resolutionSteps: steps,
    tokenIds: ['1', '2'],
    outcomes: ['Yes', 'No'],
    outcomePrices: prices,
  };
}

function assessment(m: Market): Assessment {
  return {
    market: m,
    dispute: {
      conditionId: m.conditionId,
      rounds: m.resolutionSteps.filter((s) => s === 'disputed').length,
      phase: 'proposed',
      contested: m.resolutionSteps.includes('disputed'),
      steps: m.resolutionSteps,
    },
    actors: [],
    conflicts: [],
    tier: 'positions',
    caveats: [],
    pool: m.volume,
    fetchedAt: '',
  };
}

const id = (n: string) => `0x${n.repeat(64).slice(0, 64)}`;
const AT = new Date('2026-08-07T12:00:00.000Z');

describe('recall, first run', () => {
  const a = assessment(market(id('a'), ['proposed']));

  it('reports nothing, the same rule the watcher runs on', () => {
    const r = recall([a], { markets: {} }, AT);
    expect(r.baseline).toBe(true);
    expect(r.moved).toBe(0);
    expect(r.unseen).toBe(0);
    expect(r.movement.get(a.market.conditionId)).toBe('steady');
  });

  it('says what it recorded rather than claiming nothing happened', () => {
    const note = recallNote(recall([a], { markets: {} }, AT), 25);
    expect(note).toMatch(/first reading/);
    expect(note).toMatch(/25 markets recorded/);
    expect(note).not.toMatch(/nothing moved/);
  });
});

describe('recall, against a baseline', () => {
  const before = (m: Market) => ({
    baselineAt: '2026-08-06T09:30:00.000Z',
    markets: { [m.conditionId]: snapshot(m, new Date('2026-08-06T09:30:00.000Z')) },
  });

  it('sees a lifecycle that grew', () => {
    const was = market(id('b'), ['proposed']);
    const now = assessment(market(id('b'), ['proposed', 'disputed']));

    const r = recall([now], before(was), AT);
    expect(r.moved).toBe(1);
    expect(r.compared).toBe(1);
    expect(r.movement.get(id('b'))).toBe('moved');
  });

  it('keeps a rewritten history apart from a market that merely moved', () => {
    const was = market(id('c'), ['proposed', 'disputed', 'resolved']);
    const now = assessment(market(id('c'), ['proposed', 'resolved']));

    const r = recall([now], before(was), AT);
    expect(r.movement.get(id('c'))).toBe('rewritten');
    expect(r.rewritten).toBe(1);
    expect(r.moved).toBe(0);
  });

  it('calls an unchanged market steady', () => {
    const was = market(id('d'), ['proposed']);
    const r = recall([assessment(market(id('d'), ['proposed']))], before(was), AT);
    expect(r.movement.get(id('d'))).toBe('steady');
    expect(r.moved).toBe(0);
    expect(r.compared).toBe(1);
  });

  it('does not call a market it has no baseline for a move', () => {
    // The radar only snapshots the rows it assessed, so a market that fell out
    // of the ranking and came back has no baseline. Reporting that as a move
    // would manufacture news out of a change in the sort order.
    const was = market(id('e'), ['proposed']);
    const fresh = assessment(market(id('f'), ['proposed', 'disputed']));

    const r = recall([fresh], before(was), AT);
    expect(r.movement.get(id('f'))).toBe('unseen');
    expect(r.unseen).toBe(1);
    expect(r.moved).toBe(0);
    expect(r.compared).toBe(0);
  });
});

describe('recallNote', () => {
  const state = { baselineAt: '2026-08-06T09:30:00.000Z', markets: {} };

  it('never prints a count without the ground it covered', () => {
    const was = market(id('b'), ['proposed']);
    const r = recall([assessment(market(id('b'), ['proposed', 'disputed']))], {
      ...state,
      markets: { [id('b')]: snapshot(was, AT) },
    }, AT);

    const note = recallNote(r, 1) ?? '';
    expect(note).toMatch(/1 moved/);
    expect(note).toMatch(/of 1 compared/);
  });

  it('says nothing moved over ground it actually covered', () => {
    const was = market(id('d'), ['proposed']);
    const r = recall([assessment(market(id('d'), ['proposed']))], {
      ...state,
      markets: { [id('d')]: snapshot(was, AT) },
    }, AT);

    expect(recallNote(r, 1)).toMatch(/nothing moved in 1 markets/);
  });
});

describe('movementRank', () => {
  it('puts a rewritten record above a market that only moved', () => {
    expect(movementRank('rewritten')).toBeGreaterThan(movementRank('moved'));
    expect(movementRank('moved')).toBeGreaterThan(movementRank('unseen'));
    expect(movementRank('unseen')).toBeGreaterThan(movementRank('steady'));
    expect(movementRank(undefined)).toBe(0);
  });
});
