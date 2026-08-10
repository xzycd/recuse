import { describe, expect, it } from 'vitest';
import {
  caveatsFor, concentration, leadingSide, observableSide, repeatPlayers, repeatWinners,
  sideForIndex, tradeConcentration, winningSide,
} from './capture.js';
import type { Holder, Market, Side, Winner } from '../types.js';

function winner(address: string, net: number, netSpent: number, name?: string): Winner {
  return { address, name, bought: net, net, spent: netSpent, netSpent };
}

function holder(address: string, side: Side, size: number, name?: string): Holder {
  return { address, side, size, value: size, name };
}

function market(prices: Array<number | undefined>): Market {
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

  it('requires a complete binary payout before calling a market settled', () => {
    expect(leadingSide(market([0, 0.7]))).toEqual({ side: 'NO', settled: false });
    expect(leadingSide(market([0.5, 0.5]))).toBeUndefined();
    expect(leadingSide(market([1, undefined]))).toBeUndefined();
  });

  it('uses the market labels rather than assuming outcome zero is yes', () => {
    const reversed = market([1, 0]);
    reversed.outcomes = ['No', 'Yes'];
    expect(leadingSide(reversed)).toEqual({ side: 'NO', settled: true });
  });

  it('returns undefined when prices are missing', () => {
    expect(leadingSide(market([]))).toBeUndefined();
    expect(leadingSide(market([0.5]))).toBeUndefined();
  });
});

describe('sideForIndex', () => {
  it('rejects fractional, negative and extra outcome indices', () => {
    const m = market([0.5, 0.5]);
    expect(sideForIndex(m, 0.5)).toBeUndefined();
    expect(sideForIndex(m, -1)).toBeUndefined();
    expect(sideForIndex(m, 2)).toBeUndefined();
  });

  it('does not guess yes or no on a multi-outcome market', () => {
    const m = market([0.3, 0.3, 0.4]);
    m.outcomes = ['A', 'B', 'C'];
    expect(sideForIndex(m, 0)).toBeUndefined();
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

describe('caveatsFor, on a reading the trade index never reached', () => {
  it('says the winning side was not read rather than found empty', () => {
    const out = caveatsFor({
      holderCount: 5,
      holdersTruncated: false,
      settled: true,
      beyondIndex: '2026-01-05T22:05:45.000Z',
    });
    expect(out[0]).toContain('trade index stops at 2026-01-05');
    expect(out[0]).toContain('not read rather than found empty');
  });

  it('does not describe a floor from a reading that never happened', () => {
    const out = caveatsFor({
      holderCount: 5,
      holdersTruncated: false,
      settled: true,
      beyondIndex: '2026-01-05T22:05:45.000Z',
      winnerFloor: 1000,
    });
    expect(out.some((c) => c.includes('trade index'))).toBe(true);
    expect(out.some((c) => c.includes('omits positions at or below'))).toBe(false);
  });

  it('says nothing when the reading is inside the index', () => {
    const out = caveatsFor({ holderCount: 5, holdersTruncated: false, settled: true });
    expect(out.join(' ')).not.toContain('trade index');
  });
});

describe('repeatWinners', () => {
  it('counts wins across markets and sums the arithmetic', () => {
    const regulars = repeatWinners([
      { market: 'a', winners: [winner('0xa', 100, 90), winner('0xb', 50, 40)] },
      { market: 'b', winners: [winner('0xa', 200, 150)] },
    ]);
    // 300 tokens redeeming at a dollar against 240 paid.
    expect(regulars).toEqual([
      { address: '0xa', name: undefined, wins: 2, tokens: 300, paid: 240, gain: 60, markets: ['a', 'b'] },
    ]);
  });

  it('drops a wallet that sold out before resolution', () => {
    // Bought the winning side and left. It was never paid, and counting it
    // would make this a table of people who touched the right token.
    const flipped: Winner = { address: '0xa', bought: 500, net: 0, spent: 400, netSpent: 0 };
    const regulars = repeatWinners(
      [{ market: 'a', winners: [flipped] }, { market: 'b', winners: [flipped] }],
      1,
    );
    expect(regulars).toEqual([]);
  });

  it('drops addresses below the win floor', () => {
    // Winning one contested market is what happens to most of this data.
    expect(repeatWinners([{ market: 'a', winners: [winner('0xa', 10, 5)] }])).toEqual([]);
  });

  it('counts an address once per market', () => {
    const regulars = repeatWinners(
      [{ market: 'a', winners: [winner('0xa', 10, 5), winner('0xa', 99, 1)] }],
      1,
    );
    expect(regulars[0]).toMatchObject({ wins: 1, tokens: 109, paid: 6, markets: ['a'] });
  });

  it('ranks by wins first and money second', () => {
    // A wallet that won more markets outranks one that made more on fewer,
    // because the count is the finding and the money is the context.
    const regulars = repeatWinners([
      { market: 'a', winners: [winner('0xsmall', 10, 1), winner('0xrich', 1_000_000, 1)] },
      { market: 'b', winners: [winner('0xsmall', 10, 1), winner('0xrich', 1_000_000, 1)] },
      { market: 'c', winners: [winner('0xsmall', 10, 1)] },
    ]);
    expect(regulars.map((r) => r.address)).toEqual(['0xsmall', '0xrich']);
    expect(regulars[0]?.wins).toBe(3);
  });

  it('keeps a name if any market supplied one', () => {
    const regulars = repeatWinners([
      { market: 'a', winners: [winner('0xa', 10, 1)] },
      { market: 'b', winners: [winner('0xa', 10, 1, 'debased')] },
    ]);
    expect(regulars[0]?.name).toBe('debased');
  });

  it('reports a loss honestly when a winner overpaid', () => {
    // Buying the winning side above a dollar is possible and does happen.
    // Nothing here clamps it to zero.
    const regulars = repeatWinners(
      [{ market: 'a', winners: [winner('0xa', 100, 130)] }],
      1,
    );
    expect(regulars[0]).toMatchObject({ gain: -30 });
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
    expect(players[0]).toMatchObject({ losses: 2, size: 200 });
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
  it('says nothing about the oracle, which is not its question', () => {
    const c = caveatsFor({ holderCount: 20, holdersTruncated: false, settled: true });
    expect(c.join(' ')).not.toMatch(/RECUSE_RPC_URL/);
  });

  it('always explains that a settled market hides its winners', () => {
    const c = caveatsFor({
      holderCount: 20, holdersTruncated: false, settled: true,
    });
    expect(c.join(' ')).toMatch(/winners redeemed/);
  });

  it('flags a truncated holder list so shares are not read as absolute', () => {
    const c = caveatsFor({
      holderCount: 100, holdersTruncated: true, settled: true,
    });
    expect(c.join(' ')).toMatch(/truncated/);
  });

  it('flags an unsettled market', () => {
    const c = caveatsFor({
      holderCount: 5, holdersTruncated: false, settled: false,
    });
    expect(c.join(' ')).toMatch(/not settled/);
  });

  it('flags an empty holder list', () => {
    const c = caveatsFor({
      holderCount: 0, holdersTruncated: false, settled: true,
    });
    expect(c.join(' ')).toMatch(/no holders/);
  });
});

describe('tradeConcentration', () => {
  const winners = [
    { address: '0xa'.padEnd(42, 'a'), bought: 7_132_806, net: 7_026_166, spent: 7_015_571, netSpent: 6_909_677 },
    { address: '0xb'.padEnd(42, 'b'), bought: 6_884_962, net: 6_884_962, spent: 6_751_932, netSpent: 6_751_932 },
    { address: '0xc'.padEnd(42, 'c'), bought: 4_071_379, net: 0, spent: 4_050_074, netSpent: 3_632_690 },
  ];

  it('measures on net position, not on everything ever bought', () => {
    const c = tradeConcentration(winners, 'NO', 1000, 2)!;
    // The third wallet bought four million tokens and carried none of them into
    // settlement. It was never paid, so it is not part of the winning side.
    expect(c.holderCount).toBe(2);
    expect(c.totalSize).toBeCloseTo(7_026_166 + 6_884_962, 0);
  });

  it('says the reading came from trades and that a floor was applied', () => {
    const c = tradeConcentration(winners, 'NO', 1000, 5)!;
    expect(c.basis).toBe('trades');
    expect(c.meaning).toBe('redeemed');
    expect(c.floor).toBe(1000);
  });

  it('returns nothing rather than a zero when no position survived', () => {
    expect(tradeConcentration([winners[2]!], 'NO', 1000)).toBeUndefined();
    expect(tradeConcentration([], 'NO', 1000)).toBeUndefined();
  });

  it('never reports a share above one', () => {
    const c = tradeConcentration(winners, 'NO', 1000, 50)!;
    expect(c.topShare).toBeLessThanOrEqual(1);
    expect(c.topShare).toBeCloseTo(1, 6);
  });
});

describe('winningSide', () => {
  const market = (prices: number[]) =>
    ({ outcomePrices: prices, outcomes: ['Yes', 'No'] }) as never;

  it('names the winner only once a market has actually settled', () => {
    expect(winningSide(market([0, 1]))).toBe('NO');
    expect(winningSide(market([1, 0]))).toBe('YES');
  });

  it('refuses to call a live market, however lopsided', () => {
    // 0.99 is a price. Treating it as an outcome is how a tool reports a
    // result for a market that has not resolved.
    expect(winningSide(market([0.01, 0.99]))).toBeUndefined();
  });
});

describe('caveatsFor, winning side', () => {
  it('distinguishes not read from read and empty', () => {
    const failed = caveatsFor({
      holderCount: 5, holdersTruncated: false, settled: true,
      winnersFailed: 'statement timeout',
    });
    expect(failed.some((c) => c.includes('not rebuilt'))).toBe(true);

    const read = caveatsFor({
      holderCount: 5, holdersTruncated: false, settled: true,
      winnerFloor: 1000,
    });
    expect(read.some((c) => c.includes('omits positions at or below 1000'))).toBe(true);
    expect(read.some((c) => c.includes('not rebuilt'))).toBe(false);
  });
});
