/**
 * Parsing one record out of the trade log.
 *
 * Everything here is about refusing a record rather than repairing it. A trade
 * with a missing id, a missing side or an unparseable number is one row of many
 * thousands, and dropping it costs a fraction of a tally, while coercing it
 * produces a wallet that never traded holding tokens at a price of zero.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchMarketTrades, fetchWalletTrades, toTrade } from './trades.js';

const ADDRESS = '0x950ea3d54a52dca7ec54e7a0338812450268f8e5';
const TOKEN = '76533108781962275310651165149634079251899733930834190485860627580128626747247';
const CONDITION = '0x6d0e09d0f04572d9b1adad84703458b0297bc5603b69dccbde93147ee4443246';
const OTHER_CONDITION = `0x${'a'.repeat(64)}`;
const OTHER_ADDRESS = `0x${'b'.repeat(40)}`;

const raw = (over: Record<string, unknown> = {}) => ({
  proxyWallet: ADDRESS,
  asset: TOKEN,
  conditionId: CONDITION,
  side: 'BUY',
  size: 36200,
  price: 0.001,
  timestamp: 1775694583,
  ...over,
});

describe('one trade out of the log', () => {
  it('reads the fields it needs and nothing it does not', () => {
    expect(toTrade(raw())).toEqual({
      address: ADDRESS,
      tokenId: TOKEN,
      conditionId: CONDITION,
      side: 'BUY',
      size: 36200,
      price: 0.001,
    });
  });

  it('refuses a record missing any of its three identifiers', () => {
    // Without a condition there is no route from this trade to a market, and a
    // position that cannot be attached to a market is not a position.
    expect(toTrade(raw({ proxyWallet: undefined }))).toBeUndefined();
    expect(toTrade(raw({ asset: undefined }))).toBeUndefined();
    expect(toTrade(raw({ conditionId: undefined }))).toBeUndefined();
  });

  it('refuses an absent number rather than reading it as zero', () => {
    // `Number(null)` is 0, and a fill of zero size at a price of zero sits in a
    // tally looking like a real trade that happened to be tiny.
    expect(toTrade(raw({ size: null }))).toBeUndefined();
    expect(toTrade(raw({ price: null }))).toBeUndefined();
    expect(toTrade(raw({ timestamp: null }))).toBeUndefined();
    expect(toTrade(raw({ size: 'many' }))).toBeUndefined();
    expect(toTrade(raw({ price: '   ' }))).toBeUndefined();
    expect(toTrade(raw({ size: true }))).toBeUndefined();
    expect(toTrade(null)).toBeUndefined();
  });

  it('allows a price of zero, which is a real fill', () => {
    // Distinct from an absent price. A losing side does trade at zero, and
    // refusing it would quietly drop the cheapest end of a market.
    expect(toTrade(raw({ price: 0 }))?.price).toBe(0);
    expect(toTrade(raw({ price: 1 }))?.price).toBe(1);
    expect(toTrade(raw({ price: 1.01 }))).toBeUndefined();
    expect(toTrade(raw({ timestamp: 1775694583.5 }))).toBeUndefined();
  });

  it('refuses a side it does not recognise', () => {
    // There is no safe default. Guessing BUY turns every unparsed sell into a
    // purchase and inflates the position it lands in.
    expect(toTrade(raw({ side: 'MERGE' }))).toBeUndefined();
    expect(toTrade(raw({ side: undefined }))).toBeUndefined();
    expect(toTrade(raw({ side: 'SELL' }))?.side).toBe('SELL');
  });
});

describe('the requested trade scope', () => {
  afterEach(() => vi.unstubAllGlobals());

  const serve = (rows: unknown[]) => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  };

  it('refuses a market response containing a trade from another market', async () => {
    serve([raw({ conditionId: OTHER_CONDITION })]);

    const scan = await fetchMarketTrades(CONDITION, { timeoutMs: 100 });
    expect(scan.failed).toMatch(/another market/);
    expect(scan.trades).toEqual([]);
  });

  it('refuses a wallet response containing a trade from another wallet', async () => {
    serve([raw({ proxyWallet: OTHER_ADDRESS })]);

    const scan = await fetchWalletTrades(ADDRESS, { timeoutMs: 100 });
    expect(scan.failed).toMatch(/another wallet/);
    expect(scan.trades).toEqual([]);
  });

  it('checks that the endpoint applied the requested cash floor', async () => {
    serve([raw({ size: 10, price: 0.5 })]);

    const scan = await fetchMarketTrades(CONDITION, { floor: 50, timeoutMs: 100 });
    expect(scan.failed).toMatch(/below the requested cash floor/);
  });

  it('counts malformed rows without turning a partial response into a full one', async () => {
    serve([raw(), null, raw({ price: 2 })]);

    const scan = await fetchMarketTrades(CONDITION, { timeoutMs: 100 });
    expect(scan.failed).toBeUndefined();
    expect(scan.trades).toHaveLength(1);
    expect(scan.dropped).toBe(2);
  });

  it('refuses a response in which every row is malformed', async () => {
    serve([null, raw({ price: 2 })]);

    const scan = await fetchMarketTrades(CONDITION, { timeoutMs: 100 });
    expect(scan.failed).toMatch(/no usable trades/);
    expect(scan.dropped).toBe(2);
  });

  it('refuses one token mapped to multiple markets in a wallet history', async () => {
    serve([raw(), raw({ conditionId: OTHER_CONDITION })]);

    const scan = await fetchWalletTrades(ADDRESS, { timeoutMs: 100 });
    expect(scan.failed).toMatch(/one token to multiple markets/);
  });

  it('rejects invalid floors before making a request', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    const scan = await fetchMarketTrades(CONDITION, { floor: Number.NaN });
    expect(scan.failed).toBe('invalid trade floor');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not lower a minimum above the built-in floor ladder', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request) => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetcher);

    const scan = await fetchMarketTrades(CONDITION, { minFloor: 6_000, timeoutMs: 100 });
    expect(scan.failed).toBeUndefined();
    expect(scan.floor).toBe(6_000);
    expect(String(fetcher.mock.calls[0]![0])).toContain('filterAmount=6000');
  });
});
