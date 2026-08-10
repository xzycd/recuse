import { describe, expect, it } from 'vitest';
import { buildLedger, indexOfToken, payoutFor, payoutFromPrices } from './wallet.js';
import type { Market } from '../types.js';

const market = (over: Partial<Market> = {}): Market =>
  ({
    conditionId: `0x${'a'.repeat(64)}`,
    slug: 'zelenskyy-suit',
    question: 'Will Zelenskyy wear a suit before July?',
    volume: 242_200_000, liquidity: 0, closed: true, active: false, negRisk: false,
    resolutionSteps: ['proposed', 'disputed', 'proposed', 'disputed'],
    tokenIds: ['1038641317', '3437958178'],
    outcomes: ['Yes', 'No'],
    outcomePrices: [0, 1],
    ...over,
  }) as Market;

describe('indexOfToken', () => {
  it('reads the index from Gamma, which is the only source that has it', () => {
    // The subgraph's own MarketData.outcomeIndex is null on every record
    // checked, and Number(null) is 0, so reading the side from there reports
    // every position as outcome 0 and flips half the wins into losses.
    expect(indexOfToken(market(), '3437958178')).toBe(1);
    expect(indexOfToken(market(), '1038641317')).toBe(0);
  });

  it('returns undefined rather than a default for a token it does not know', () => {
    expect(indexOfToken(market(), '999')).toBeUndefined();
  });
});

describe('payoutFor', () => {
  it('reports dollars per token for the winning and losing sides', () => {
    const p = { conditionId: 'x', numerators: [0, 1], denominator: 1 };
    expect(payoutFor(p, 1)).toBe(1);
    expect(payoutFor(p, 0)).toBe(0);
  });

  it('handles a split resolution honestly instead of as a double loss', () => {
    // UMA does hand these down. Reporting 50/50 as a loss on both sides would
    // be wrong on both.
    const p = { conditionId: 'x', numerators: [1, 1], denominator: 2 };
    expect(payoutFor(p, 0)).toBe(0.5);
    expect(payoutFor(p, 1)).toBe(0.5);
  });

  it('says undefined for unresolved, which is not the same as zero', () => {
    expect(payoutFor({ conditionId: 'x' }, 0)).toBeUndefined();
    expect(payoutFor({ conditionId: 'x', numerators: [], denominator: 1 }, 0)).toBeUndefined();
    expect(payoutFor(undefined, 0)).toBeUndefined();
  });

  it('does not divide by a zero or missing denominator', () => {
    expect(payoutFor({ conditionId: 'x', numerators: [1, 0], denominator: 0 }, 0)).toBeUndefined();
  });
});

describe('buildLedger', () => {
  const cond = `0x${'a'.repeat(64)}`;
  const base = {
    address: `0x${'b'.repeat(40)}`,
    markets: new Map([[cond, market()]]),
  };

  it('prices a winning position from what it actually paid out', () => {
    const ledger = buildLedger({
      ...base,
      positions: [{ tokenId: '3437958178', net: 7_026_166, netSpent: 6_909_677, bought: 7_132_806 }],
      payouts: new Map([['3437958178', { conditionId: cond, numerators: [0, 1], denominator: 1 }]]),
    });
    expect(ledger.won).toBe(1);
    expect(ledger.entries[0]!.gain).toBeCloseTo(116_489, 0);
    expect(ledger.entries[0]!.side).toBe('No');
  });

  it('prices a losing position as the whole cost, not zero', () => {
    const ledger = buildLedger({
      ...base,
      positions: [{ tokenId: '1038641317', net: 500_000, netSpent: 300_000, bought: 500_000 }],
      payouts: new Map([['1038641317', { conditionId: cond, numerators: [0, 1], denominator: 1 }]]),
    });
    expect(ledger.lost).toBe(1);
    expect(ledger.entries[0]!.gain).toBe(-300_000);
  });

  it('counts a split as neither won nor lost', () => {
    const ledger = buildLedger({
      ...base,
      positions: [{ tokenId: '1038641317', net: 100, netSpent: 40, bought: 100 }],
      payouts: new Map([['1038641317', { conditionId: cond, numerators: [1, 1], denominator: 2 }]]),
    });
    expect(ledger.split).toBe(1);
    expect(ledger.won + ledger.lost).toBe(0);
    expect(ledger.entries[0]!.gain).toBeCloseTo(10, 6);
  });

  it('leaves an unresolved position out of the totals entirely', () => {
    const ledger = buildLedger({
      ...base,
      positions: [{ tokenId: '1038641317', net: 100, netSpent: 40, bought: 100 }],
      payouts: new Map([['1038641317', { conditionId: cond }]]),
    });
    expect(ledger.open).toBe(1);
    expect(ledger.gain).toBe(0);
    expect(ledger.entries[0]!.gain).toBeUndefined();
  });

  it('reports contested markets separately, which is the point of this view', () => {
    const quiet = `0x${'c'.repeat(64)}`;
    const ledger = buildLedger({
      address: base.address,
      markets: new Map([
        [cond, market()],
        [quiet, market({ conditionId: quiet, resolutionSteps: ['proposed', 'resolved'], tokenIds: ['77', '88'] })],
      ]),
      positions: [
        { tokenId: '3437958178', net: 1000, netSpent: 900, bought: 1000 },
        { tokenId: '88', net: 1000, netSpent: 100, bought: 1000 },
      ],
      payouts: new Map([
        ['3437958178', { conditionId: cond, numerators: [0, 1], denominator: 1 }],
        ['88', { conditionId: quiet, numerators: [0, 1], denominator: 1 }],
      ]),
    });
    expect(ledger.contested).toBe(1);
    expect(ledger.contestedGain).toBeCloseTo(100, 6);
    expect(ledger.gain).toBeCloseTo(1000, 6);
    // Contested first, because that is why someone opened this here.
    expect(ledger.entries[0]!.rounds).toBe(2);
  });

  it('drops a position it cannot match and says how many', () => {
    const ledger = buildLedger({
      ...base,
      positions: [{ tokenId: '999', net: 1, netSpent: 1, bought: 1 }],
      payouts: new Map(),
    });
    expect(ledger.entries).toHaveLength(0);
    expect(ledger.caveats[0]).toContain('1 positions could not be matched');
  });
});

describe('a payout read off closing prices', () => {
  const settled = (prices: number[]) => market({ outcomePrices: prices });

  it('reads a resolved binary market as one dollar to the winner', () => {
    const p = payoutFromPrices(settled([1, 0]));
    expect(payoutFor(p, 0)).toBe(1);
    expect(payoutFor(p, 1)).toBe(0);
  });

  it('reads a split resolution as half to each, not a loss on both', () => {
    // UMA does hand these down, and the fallback has to state it as the chain
    // would rather than pick a winner.
    const p = payoutFromPrices(settled([0.5, 0.5]));
    expect(payoutFor(p, 0)).toBe(0.5);
    expect(payoutFor(p, 1)).toBe(0.5);
  });

  it('refuses an open market, where the prices are an opinion', () => {
    // This is the whole risk of pricing off Gamma. A market trading at 0.97 is
    // not a market that resolved, and treating it as one settles a position
    // that is still live.
    expect(payoutFromPrices(settled([0.97, 0.03]))).toBeUndefined();
    expect(payoutFromPrices(settled([0.6, 0.4]))).toBeUndefined();
  });

  it('refuses prices that do not divide one dollar between them', () => {
    expect(payoutFromPrices(settled([1, 1]))).toBeUndefined();
    expect(payoutFromPrices(settled([1]))).toBeUndefined();
    expect(payoutFromPrices(settled([]))).toBeUndefined();
  });
});

describe('a position closed before the market settled', () => {
  it('is neither won nor lost, and its trading profit is still counted', () => {
    // Could not happen while positions came from the index, which was asked for
    // survivors only. The trade log has no such filter, and a wallet that
    // flipped its whole position is ordinary.
    const m = market({ outcomePrices: [1, 0] });
    const ledger = buildLedger({
      address: '0xaaa',
      positions: [{ tokenId: m.tokenIds[0], bought: 1000, net: 0, netSpent: -400 }],
      payouts: new Map([[m.tokenIds[0], { conditionId: m.conditionId, numerators: [1, 0], denominator: 1 }]]),
      markets: new Map([[m.conditionId, m]]),
    });

    expect(ledger.exited).toBe(1);
    expect(ledger.won).toBe(0);
    expect(ledger.lost).toBe(0);
    // Sold for 400 more than it paid. That money moved whatever the market did
    // next, so it stays in the total.
    expect(ledger.gain).toBe(400);
  });
});
