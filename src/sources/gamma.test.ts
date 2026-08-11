import { afterEach, describe, expect, it, vi } from 'vitest';
import { distinctMarkets, fetchMarkets, matchesRequest, toMarket } from './gamma.js';

describe('toMarket', () => {
  it('decodes the fields Gamma ships as JSON inside a string', () => {
    const m = toMarket({
      conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      slug: 'x',
      question: 'q',
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.125", "0.875"]',
      clobTokenIds: '["111", "222"]',
      umaResolutionStatuses: '["proposed", "disputed"]',
    });
    expect(m.outcomes).toEqual(['Yes', 'No']);
    expect(m.outcomePrices).toEqual([0.125, 0.875]);
    expect(m.tokenIds).toEqual(['111', '222']);
    expect(m.resolutionSteps).toEqual(['proposed', 'disputed']);
  });

  it('survives a market with nothing filled in', () => {
    const m = toMarket({});
    expect(m.conditionId).toBe('');
    expect(m.resolutionSteps).toEqual([]);
    expect(m.volume).toBe(0);
  });

  it('does not let one malformed field take down the record', () => {
    const m = toMarket({ conditionId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', outcomes: '["Yes", "No"', volumeNum: '1200' });
    expect(m.outcomes).toEqual([]);
    expect(m.volume).toBe(1200);
  });

  it('treats decoded objects as malformed arrays instead of calling map on them', () => {
    const m = toMarket({
      outcomes: '{"0":"Yes"}',
      clobTokenIds: { 0: '111' },
      outcomePrices: '{"0":1}',
    });
    expect(m.outcomes).toEqual([]);
    expect(m.tokenIds).toEqual([]);
    expect(m.outcomePrices).toEqual([]);
  });

  it('preserves index alignment when one token or price is malformed', () => {
    const m = toMarket({
      outcomes: '["Yes","No"]',
      clobTokenIds: '["not-a-token","222"]',
      outcomePrices: '[null,"1"]',
    });
    expect(m.tokenIds).toEqual([undefined, '222']);
    expect(m.outcomePrices).toEqual([undefined, 1]);
  });

  it('accepts only a real address for the resolver field', () => {
    expect(toMarket({ resolvedBy: 'anything' }).resolvedBy).toBeUndefined();
    expect(toMarket({ resolvedBy: `0x${'A'.repeat(40)}` }).resolvedBy)
      .toBe(`0x${'a'.repeat(40)}`);
  });

  it('reads volume from either field name', () => {
    expect(toMarket({ volumeNum: 5 }).volume).toBe(5);
    expect(toMarket({ volume: '7' }).volume).toBe(7);
  });

  it('does not carry impossible negative amounts or out-of-range prices', () => {
    const m = toMarket({
      volumeNum: -1,
      liquidityNum: '-2',
      umaBond: '-5',
      umaReward: Number.POSITIVE_INFINITY,
      outcomePrices: '[-0.1,1.1]',
    });
    expect(m.volume).toBe(0);
    expect(m.liquidity).toBe(0);
    expect(m.umaBond).toBeUndefined();
    expect(m.umaReward).toBeUndefined();
    expect(m.outcomePrices).toEqual([undefined, undefined]);
  });

  it('refuses quantities outside the safe arithmetic range', () => {
    const m = toMarket({
      volumeNum: Number.MAX_VALUE,
      liquidityNum: Number.MAX_VALUE,
      umaBond: Number.MAX_VALUE,
      umaReward: Number.MAX_VALUE,
    });
    expect(m.volume).toBe(0);
    expect(m.liquidity).toBe(0);
    expect(m.umaBond).toBeUndefined();
    expect(m.umaReward).toBeUndefined();
  });

  it('caps embedded arrays before downstream code walks them', () => {
    const values = Array.from({ length: 1_010 }, (_, i) => String(i));
    const m = toMarket({ outcomes: JSON.stringify(values) });
    expect(m.outcomes).toHaveLength(1_000);
  });
});

describe('matchesRequest', () => {
  const market = toMarket({ conditionId: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', slug: 'zelenskyy-suit' });

  it('matches on condition id regardless of case', () => {
    expect(matchesRequest(market, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
    expect(matchesRequest(market, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
  });

  it('matches on slug', () => {
    expect(matchesRequest(market, 'zelenskyy-suit')).toBe(true);
  });

  it('rejects a market Gamma returned after silently dropping the filter', () => {
    // The real failure: asking for the $242M Zelenskyy market and being handed
    // "Xi Jinping out before 2027?" with no error anywhere in the response.
    expect(matchesRequest(market, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toBe(false);
  });
});

describe('distinctMarkets', () => {
  it('does not let a duplicate catalogue row count one market twice', () => {
    const id = `0x${'a'.repeat(64)}`;
    const older = toMarket({ conditionId: id, slug: 'old', updatedAt: '2026-01-01T00:00:00Z' });
    const newer = toMarket({ conditionId: id, slug: 'new', updatedAt: '2026-01-02T00:00:00Z' });
    expect(distinctMarkets([older, newer])).toEqual([newer]);
  });

  it('drops rows without the condition id every downstream join requires', () => {
    expect(distinctMarkets([toMarket({ slug: 'unjoinable' })])).toEqual([]);
  });
});

describe('fetchMarkets resource bounds', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('caps raw rows examined even when every record is unusable', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const limit = Number(url.searchParams.get('limit'));
      // No condition id, so none of these rows can enter the output. The raw
      // scan still has to stop at the requested budget instead of paging until
      // a hostile endpoint decides to return a short page.
      return new Response(JSON.stringify(Array.from({ length: limit }, () => ({ slug: 'bad' }))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(fetchMarkets({ limit: 150 })).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]![0])).toContain('limit=50');
  });

  it('rejects a server that ignores the requested page size', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify([{}, {}]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    await expect(fetchMarkets({ limit: 1 })).rejects.toThrow(/exceeded the requested market page size/);
  });
});
