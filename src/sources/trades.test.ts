/**
 * Parsing one record out of the trade log.
 *
 * Everything here is about refusing a record rather than repairing it. A trade
 * with a missing id, a missing side or an unparseable number is one row of many
 * thousands, and dropping it costs a fraction of a tally, while coercing it
 * produces a wallet that never traded holding tokens at a price of zero.
 */

import { describe, expect, it } from 'vitest';

import { REACHABLE, toTrade } from './trades.js';

const ADDRESS = '0x950ea3d54a52dca7ec54e7a0338812450268f8e5';
const TOKEN = '76533108781962275310651165149634079251899733930834190485860627580128626747247';
const CONDITION = '0x6d0e09d0f04572d9b1adad84703458b0297bc5603b69dccbde93147ee4443246';

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
      at: 1775694583,
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
  });

  it('allows a price of zero, which is a real fill', () => {
    // Distinct from an absent price. A losing side does trade at zero, and
    // refusing it would quietly drop the cheapest end of a market.
    expect(toTrade(raw({ price: 0 }))?.price).toBe(0);
  });

  it('refuses a side it does not recognise', () => {
    // There is no safe default. Guessing BUY turns every unparsed sell into a
    // purchase and inflates the position it lands in.
    expect(toTrade(raw({ side: 'MERGE' }))).toBeUndefined();
    expect(toTrade(raw({ side: undefined }))).toBeUndefined();
    expect(toTrade(raw({ side: 'SELL' }))?.side).toBe('SELL');
  });

  it('keeps a chosen name and drops the generated one', () => {
    // The fallback is the account's own address with a timestamp glued on,
    // which is the absence of a name rather than a name.
    expect(toTrade(raw({ name: 'debased' }))?.name).toBe('debased');
    expect(toTrade(raw({ name: `${ADDRESS}-1775665943343` }))?.name).toBeUndefined();
    expect(toTrade(raw({ name: '   ' }))?.name).toBeUndefined();
  });

  it('strips what a terminal would act on out of a name', () => {
    // Chosen freely by the account and printed next to claims about that same
    // account, so this is the most hostile field the module reads.
    const name = toTrade(raw({ name: 'clean[2Jname' }))?.name;
    expect(name).not.toContain('');
  });

  it('states how far the endpoint can be paged, because it is a hard ceiling', () => {
    // One page at offset zero and one at the largest offset the endpoint will
    // accept. Past that it answers with an error object and HTTP 200, so a
    // reader that did not know the number would take the refusal for the end
    // of the data.
    expect(REACHABLE).toBe(20_000);
  });
});
