import { describe, expect, it } from 'vitest';
import {
  caveatsFor, concentration, leadingSide, observableSide, repeatPlayers, tradeConcentration,
  winningSide,
} from './capture.js';
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
    expect(read.some((c) => c.includes('omits positions under 1000'))).toBe(true);
    expect(read.some((c) => c.includes('not rebuilt'))).toBe(false);
  });
});
