import { describe, expect, it } from 'vitest';
import { caveatsFor, concentration, leadingSide, observableSide, repeatPlayers } from './capture.js';
import type { Holder, Market, Side } from '../types.js';

function holder(address: string, side: Side, size: number, name?: string): Holder {
  return { address, side, size, value: size, name };
}

function market(prices: number[]): Market {
  return {
    conditionId: '0x1',
    slug: 's',
    question: 'q',
    volume: 0,
    liquidity: 0,
    closed: false,
    active: true,
    negRisk: false,
    resolutionSteps: [],
    tokenIds: [],
    outcomes: ['Yes', 'No'],
    outcomePrices: prices,
  };
}

describe('leadingSide', () => {
  it('reads a settled market at the extremes', () => {
    expect(leadingSide(market([1, 0]))).toEqual({ side: 'YES', settled: true });
    expect(leadingSide(market([0, 1]))).toEqual({ side: 'NO', settled: true });
  });

  it('does not call a near-certain market settled', () => {
    // 0.99 is a price. Treating it as an outcome is how a tool starts lying.
    expect(leadingSide(market([0.99, 0.01]))).toEqual({ side: 'YES', settled: false });
  });

  it('returns undefined when prices are missing', () => {
    expect(leadingSide(market([]))).toBeUndefined();
    expect(leadingSide(market([0.5]))).toBeUndefined();
  });
});

describe('observableSide', () => {
  it('measures the losing side of a settled market', () => {
    // Winners redeem for a dollar and leave the book; losers keep worthless
    // tokens. Measured live on the Zelenskyy market: NO won and had 907 tokens
    // left, while the losing YES side still held 52,137,899. Reading the winner
    // would be measuring whoever has not redeemed yet.
    expect(observableSide(market([0, 1]))).toEqual({ side: 'YES', settled: true, meaning: 'wiped' });
    expect(observableSide(market([1, 0]))).toEqual({ side: 'NO', settled: true, meaning: 'wiped' });
  });

  it('measures the leading side while a market is still open', () => {
    expect(observableSide(market([0.7, 0.3]))).toEqual({
      side: 'YES', settled: false, meaning: 'leading',
    });
  });

  it('returns undefined without prices', () => {
    expect(observableSide(market([]))).toBeUndefined();
  });
});

describe('concentration', () => {
  const holders = [
    holder('0xa', 'YES', 700),
    holder('0xb', 'YES', 200),
    holder('0xc', 'YES', 100),
    holder('0xd', 'NO', 50),
  ];

  it('measures the top holders share of a side', () => {
    const c = concentration(holders, 'YES', 'wiped', 2);
    expect(c?.topShare).toBeCloseTo(0.9);
    expect(c?.topSize).toBe(900);
    expect(c?.totalSize).toBe(1000);
    expect(c?.holderCount).toBe(3);
    expect(c?.meaning).toBe('wiped');
  });

  it('reports the real topN when fewer holders exist than asked for', () => {
    // Otherwise "top 5 hold 100%" reads as concentration when there are only 3.
    expect(concentration(holders, 'NO', 'wiped', 5)?.topN).toBe(1);
    expect(concentration(holders, 'NO', 'wiped', 5)?.topShare).toBe(1);
  });

  it('ignores the other side entirely', () => {
    expect(concentration(holders, 'YES', 'wiped', 5)?.totalSize).toBe(1000);
  });

  it('returns undefined rather than zero when a side is empty', () => {
    expect(concentration([], 'YES', 'wiped')).toBeUndefined();
  });
});

describe('repeatPlayers', () => {
  it('counts losses and appearances across markets', () => {
    const players = repeatPlayers([
      { loser: 'YES', holders: [holder('0xa', 'YES', 100), holder('0xb', 'NO', 100)] },
      { loser: 'YES', holders: [holder('0xa', 'YES', 200), holder('0xb', 'NO', 50)] },
      { loser: 'NO', holders: [holder('0xa', 'NO', 300), holder('0xb', 'YES', 10)] },
    ]);
    const a = players.find((p) => p.address === '0xa');
    const b = players.find((p) => p.address === '0xb');
    expect(a).toMatchObject({ losses: 3, appearances: 3, lossRate: 1, size: 600 });
    expect(b).toMatchObject({ losses: 0, appearances: 3, lossRate: 0 });
  });

  it('drops addresses below the appearance floor', () => {
    // A 100% rate over one market is noise and must not be shown as a rate.
    const players = repeatPlayers([{ loser: 'YES', holders: [holder('0xa', 'YES', 1)] }]);
    expect(players).toEqual([]);
  });

  it('counts an address once per market even if it holds both sides', () => {
    const players = repeatPlayers(
      [
        { loser: 'YES', holders: [holder('0xa', 'YES', 100), holder('0xa', 'NO', 100)] },
        { loser: 'YES', holders: [holder('0xa', 'YES', 100)] },
      ],
      1,
    );
    expect(players[0]?.appearances).toBe(2);
  });

  it('skips markets with no decided loser', () => {
    expect(repeatPlayers([{ holders: [holder('0xa', 'YES', 1)] }], 1)).toEqual([]);
  });

  it('keeps a display name discovered in any market', () => {
    const players = repeatPlayers(
      [
        { loser: 'YES', holders: [holder('0xa', 'YES', 1)] },
        { loser: 'YES', holders: [holder('0xa', 'YES', 1, 'kahanetzadak')] },
      ],
      1,
    );
    expect(players[0]?.name).toBe('kahanetzadak');
  });

  it('ranks by losses, then by size', () => {
    const players = repeatPlayers(
      [
        { loser: 'YES', holders: [holder('0xa', 'YES', 10), holder('0xb', 'YES', 999)] },
        { loser: 'YES', holders: [holder('0xa', 'YES', 10), holder('0xc', 'NO', 5)] },
      ],
      1,
    );
    expect(players[0]?.address).toBe('0xa');
    expect(players[1]?.address).toBe('0xb');
  });
});

describe('caveatsFor', () => {
  it('always flags a positions-only reading', () => {
    const c = caveatsFor({ tier: 'positions', holderCount: 20, holdersTruncated: false, settled: true });
    expect(c[0]).toMatch(/RECUSE_RPC_URL/);
  });

  it('always explains that a settled market hides its winners', () => {
    const c = caveatsFor({
      tier: 'positions+chain', holderCount: 20, holdersTruncated: false, settled: true,
    });
    expect(c.join(' ')).toMatch(/winners redeemed/);
  });

  it('flags a truncated holder list so shares are not read as absolute', () => {
    const c = caveatsFor({
      tier: 'positions+chain', holderCount: 100, holdersTruncated: true, settled: true,
    });
    expect(c.join(' ')).toMatch(/truncated/);
  });

  it('flags an unsettled market', () => {
    const c = caveatsFor({
      tier: 'positions+chain', holderCount: 5, holdersTruncated: false, settled: false,
    });
    expect(c.join(' ')).toMatch(/not settled/);
  });

  it('flags an empty holder list', () => {
    const c = caveatsFor({
      tier: 'positions+chain', holderCount: 0, holdersTruncated: false, settled: true,
    });
    expect(c.join(' ')).toMatch(/no holders/);
  });
});
