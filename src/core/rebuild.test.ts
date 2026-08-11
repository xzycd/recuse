/**
 * The arithmetic that replaces a stored field with a sum.
 *
 * These are the definitions the subgraph served and this module now derives, so
 * a wrong sign or a mixed-up subtraction here silently changes what every table
 * built on the trade log means. Checked against the shape of a real reading:
 * the top wallets on a market the subgraph had indexed came back within 0.2% of
 * its own numbers, in the same order.
 */

import { describe, expect, it } from 'vitest';

import { positionsForToken, positionsForWallet, type TradeLike } from './rebuild.js';

const CONDITION = '0x655e5ca101c466b6293aa15e06173b78b293221803d56e35551f708cd82eb352';
const YES = '111';
const NO = '222';

function trade(over: Partial<TradeLike> = {}): TradeLike {
  return {
    address: '0xaaa',
    tokenId: YES,
    conditionId: CONDITION,
    side: 'BUY',
    size: 100,
    price: 0.5,
    ...over,
  };
}

describe('positions rebuilt from a trade log', () => {
  it('adds buys into bought and what they cost into spent', () => {
    const p = positionsForToken(
      [trade({ size: 100, price: 0.4 }), trade({ size: 50, price: 0.6 })],
      YES,
    )[0]!;

    expect(p.bought).toBe(150);
    expect(p.spent).toBe(70);
    expect(p.net).toBe(150);
    expect(p.netSpent).toBe(70);
  });

  it('leaves bought alone when a position is sold, which is what makes it cumulative', () => {
    // The whole reason this quantity is worth having. A balance forgets a
    // position that was closed; a cumulative buy does not, and that is how a
    // wallet that redeemed and left the book stays visible at all.
    const p = positionsForToken(
      [trade({ size: 100, price: 0.4 }), trade({ side: 'SELL', size: 60, price: 0.9 })],
      YES,
    )[0]!;

    expect(p.bought).toBe(100);
    expect(p.sold).toBe(60);
    expect(p.net).toBe(40);
    expect(p.spent).toBe(40);
    // 40 paid out, 54 taken back, so the surviving 40 tokens cost less than
    // nothing. Negative is the honest answer and clamping it would invent a
    // cost that was never paid.
    expect(p.netSpent).toBe(-14);
  });

  it('keeps trades on other tokens out of the tally', () => {
    // The side is read off the token id and never off the outcome label. Two
    // markets in one scan can both call a side Yes, and the payout settles
    // against the id.
    const rows = positionsForToken(
      [trade({ tokenId: YES, size: 10 }), trade({ tokenId: NO, size: 999 })],
      YES,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.bought).toBe(10);
  });

  it('drops a wallet that only ever sold this token', () => {
    // It never held a position to be paid on, so listing it among the buyers
    // would be a claim about a purchase that did not happen.
    const rows = positionsForToken(
      [trade({ address: '0xseller', side: 'SELL', size: 500 }), trade({ address: '0xbuyer' })],
      YES,
    );

    expect(rows.map((r) => r.address)).toEqual(['0xbuyer']);
  });

  it('orders by cumulative buys, largest first', () => {
    const rows = positionsForToken(
      [
        trade({ address: '0xsmall', size: 10 }),
        trade({ address: '0xbig', size: 900 }),
        trade({ address: '0xmid', size: 100 }),
      ],
      YES,
    );

    expect(rows.map((r) => r.address)).toEqual(['0xbig', '0xmid', '0xsmall']);
  });

  it('nets a fully reversed position to exactly zero', () => {
    // Ten thousand float additions otherwise leave a wallet holding 4e-10
    // tokens, which prints as a position and counts as a winner.
    const trades: TradeLike[] = [];
    for (let i = 0; i < 1000; i++) trades.push(trade({ size: 0.1, price: 0.37 }));
    for (let i = 0; i < 1000; i++) trades.push(trade({ side: 'SELL', size: 0.1, price: 0.37 }));

    const p = positionsForWallet(trades)[0]!;
    expect(p.net).toBe(0);
    expect(p.netSpent).toBe(0);
  });

  it('drops an exited large buyer before a caller applies its row limit', () => {
    const rows = positionsForToken([
      trade({ address: '0xexited', size: 10_000 }),
      trade({ address: '0xexited', side: 'SELL', size: 10_000 }),
      trade({ address: '0xheld', size: 10 }),
    ], YES);

    expect(rows.map((row) => row.address)).toEqual(['0xheld']);
  });

  it('splits one wallet across the tokens it traded, and carries the market', () => {
    const rows = positionsForWallet([
      trade({ tokenId: YES, size: 100 }),
      trade({ tokenId: NO, size: 300, conditionId: '0xbbb' }),
    ]);

    expect(rows.map((r) => r.tokenId)).toEqual([NO, YES]);
    // The condition travels with the position because it is the only current
    // route from a wallet's trades to the markets behind them: the index maps
    // token to condition only as far back as its own head.
    expect(rows[0]!.conditionId).toBe('0xbbb');
    expect(rows[1]!.conditionId).toBe(CONDITION);
  });

  it('keeps a wallet position that nets to nothing', () => {
    // It earns nothing and it is still part of the record. Dropping it would
    // hide a market the wallet traded in and out of, and the ledger counts
    // that apart from a win and from a loss.
    const rows = positionsForWallet([
      trade({ size: 100, price: 0.2 }),
      trade({ side: 'SELL', size: 100, price: 0.8 }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.net).toBe(0);
    expect(rows[0]!.bought).toBe(100);
    expect(rows[0]!.netSpent).toBe(-60);
  });

  it('orders a wallet by what survived to settlement, not by what it bought', () => {
    const rows = positionsForWallet([
      trade({ tokenId: YES, size: 1000 }),
      trade({ tokenId: YES, side: 'SELL', size: 990 }),
      trade({ tokenId: NO, size: 100 }),
    ]);

    expect(rows.map((r) => r.tokenId)).toEqual([NO, YES]);
  });
});
