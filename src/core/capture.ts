/**
 * Reading a contested market's holders.
 *
 * What this module will and will not claim matters more than the arithmetic.
 *
 * It will say: this market was disputed N times, this side won, and this share
 * of it sat in this many wallets. It will say: this address has held the
 * winning side of M contested markets out of the K we looked at.
 *
 * It will not say those wallets caused the outcome. Holding the winning side of
 * a disputed market is, on its own, evidence of nothing, since someone has to. The
 * tally is the finding; the interpretation belongs to whoever reads it.
 */

import type {
  Concentration, EvidenceTier, Holder, Market, RepeatPlayer, Side, Winner,
} from '../types.js';

/**
 * Which side a market landed on, read from its prices.
 *
 * A resolved binary market prices the winner at 1 and the loser at 0. While
 * still open, the leading side is the best available reading, so callers get
 * `settled: false` alongside it and can decide whether to use it.
 */
export function leadingSide(market: Market): { side: Side; settled: boolean } | undefined {
  const [yes, no] = [market.outcomePrices[0], market.outcomePrices[1]];
  if (yes === undefined || no === undefined) return undefined;

  // Settled markets sit at the extremes. 0.99 is not settled; 1.0 is.
  const settled = yes === 1 || no === 1 || yes === 0 || no === 0;
  return { side: yes >= no ? 'YES' : 'NO', settled };
}

/**
 * The side whose holders are actually worth measuring.
 *
 * This is not the side you would guess. Once a market settles, winners redeem
 * their tokens for a dollar each and their balances go to zero, while losers
 * keep worthless tokens forever because there is nothing to redeem them for.
 * So the current holder list of a settled market is almost entirely the losing
 * side. Measured on the Zelenskyy market, the winning side had 907 tokens left
 * against the losing side's 52,137,899.
 *
 * Reading concentration off the winning side of a settled market therefore
 * measures whoever has not got round to redeeming yet, which is noise. The
 * observable quantity is the other one: who was left holding the bag.
 */
export function observableSide(
  market: Market,
): { side: Side; settled: boolean; meaning: 'wiped' | 'leading' } | undefined {
  const leading = leadingSide(market);
  if (!leading) return undefined;

  if (!leading.settled) {
    // Nothing has been redeemed yet, so both sides are intact and the leading
    // side is the interesting one.
    return { side: leading.side, settled: false, meaning: 'leading' };
  }

  return {
    side: leading.side === 'YES' ? 'NO' : 'YES',
    settled: true,
    meaning: 'wiped',
  };
}

/**
 * How much of one side sits with its largest holders.
 *
 * `topShare` is a share of what we can see, not of what exists. The holders
 * endpoint pages, so the denominator is the holders returned. `holderCount`
 * travels with it so nobody mistakes a top-20 sample for the whole book.
 */
export function concentration(
  holders: Holder[],
  side: Side,
  meaning: Concentration['meaning'],
  topN = 5,
): Concentration | undefined {
  const onSide = holders.filter((h) => h.side === side).sort((a, b) => b.size - a.size);
  if (onSide.length === 0) return undefined;

  const totalSize = onSide.reduce((a, h) => a + h.size, 0);
  const topSize = onSide.slice(0, topN).reduce((a, h) => a + h.size, 0);

  return {
    side,
    meaning,
    basis: 'balances',
    topN: Math.min(topN, onSide.length),
    topShare: totalSize > 0 ? topSize / totalSize : 0,
    topSize,
    totalSize,
    holderCount: onSide.length,
  };
}

/**
 * The same measurement over the winning side, rebuilt from what people bought.
 *
 * Kept separate from `concentration` above rather than folded into it, because
 * the two are not the same quantity and a shared function would invite someone
 * to compare them. A balance is a position now; a cumulative buy is everything
 * ever bought. The denominator here is the sum of the buys we were served, not
 * the sum of every buy, which is why the floor travels with the result.
 *
 * `net` is the honest size for a settled market: bought minus resold, so a
 * wallet that flipped its position before resolution does not read as a winner.
 * Redemption is not an orderbook sale, so it leaves `net` alone.
 */
export function tradeConcentration(
  winners: Winner[],
  side: Side,
  floor: number,
  topN = 5,
): Concentration | undefined {
  const held = winners.filter((w) => w.net > 0).sort((a, b) => b.net - a.net);
  if (held.length === 0) return undefined;

  const totalSize = held.reduce((a, w) => a + w.net, 0);
  const topSize = held.slice(0, topN).reduce((a, w) => a + w.net, 0);

  return {
    side,
    meaning: 'redeemed',
    basis: 'trades',
    topN: Math.min(topN, held.length),
    topShare: totalSize > 0 ? topSize / totalSize : 0,
    topSize,
    totalSize,
    holderCount: held.length,
    floor,
  };
}

/** Which side won, for a settled market. Undefined while it is still live. */
export function winningSide(market: Market): Side | undefined {
  const leading = leadingSide(market);
  return leading?.settled ? leading.side : undefined;
}

/** One market's contribution to the cross-market tally. */
export interface MarketOutcome {
  holders: Holder[];
  /** The side that lost. Undefined skips the market entirely. */
  loser?: Side;
}

/**
 * Tally addresses across contested markets.
 *
 * Counts losses rather than wins, for the redemption reason above: winners are
 * invisible in current holder data and losers are fully visible. So this
 * answers "who keeps being on the wrong end of a contested resolution", which
 * is a question the data can actually support.
 *
 * `minAppearances` exists because a 100% rate over one market is noise, and
 * putting it next to a 60% rate over twenty would be actively misleading.
 * Below the floor an address is dropped rather than shown with a caveat,
 * because caveats next to a big number do not get read.
 */
export function repeatPlayers(outcomes: MarketOutcome[], minAppearances = 2): RepeatPlayer[] {
  const tally = new Map<string, RepeatPlayer>();

  for (const { holders, loser } of outcomes) {
    if (!loser) continue;

    // One entry per address per market. An address holding both sides of the
    // same market counts once, or it would inflate its own appearance count.
    const seen = new Set<string>();

    for (const h of holders) {
      if (seen.has(h.address)) continue;
      seen.add(h.address);

      const entry = tally.get(h.address) ?? {
        address: h.address,
        name: h.name,
        losses: 0,
        appearances: 0,
        lossRate: 0,
        size: 0,
      };

      entry.appearances += 1;
      if (h.side === loser) {
        entry.losses += 1;
        entry.size += h.size;
      }
      // Keep a real name if we ever see one.
      entry.name ??= h.name;

      tally.set(h.address, entry);
    }
  }

  return [...tally.values()]
    .filter((p) => p.appearances >= minAppearances)
    .map((p) => ({ ...p, lossRate: p.appearances > 0 ? p.losses / p.appearances : 0 }))
    .sort((a, b) => b.losses - a.losses || b.size - a.size);
}

/**
 * Caveats that apply to a reading, in the order they undermine it.
 *
 * Returned as data rather than printed, so every surface (TUI, JSON, alerts)
 * carries the same warnings and none of them can quietly drop one.
 */
export function caveatsFor(opts: {
  tier: EvidenceTier;
  holderCount: number;
  holdersTruncated: boolean;
  settled: boolean;
  /** Why the winning side could not be rebuilt, when it could not. */
  winnersFailed?: string;
  /** Smallest winning position requested, in tokens. */
  winnerFloor?: number;
  winnersTruncated?: boolean;
}): string[] {
  const out: string[] = [];

  if (!opts.tier.includes('chain')) {
    out.push('no chain data: proposer and disputer identities unread (set RECUSE_RPC_URL)');
  }
  if (opts.holderCount === 0) {
    out.push('no holders returned for this market');
  } else if (opts.holdersTruncated) {
    out.push(`holder list truncated at ${opts.holderCount}, shares are of what was returned`);
  }

  if (opts.settled) {
    if (opts.winnersFailed) {
      // The distinction that matters: the winning side was not read, as opposed
      // to being read and found empty. Saying nothing here would leave the
      // losing side looking like the whole market.
      out.push(`winning side not rebuilt: ${opts.winnersFailed}`);
    } else if (opts.winnerFloor) {
      out.push(
        `winning side is from trades, not balances, and omits positions under ${opts.winnerFloor} tokens`,
      );
      if (opts.winnersTruncated) {
        out.push('more winning positions exist above that floor than were requested');
      }
    } else {
      out.push('settled market: winners redeemed and left the book, only losers hold balances');
    }
  } else {
    out.push('market not settled: the leading side is a current price, not an outcome');
  }

  return out;
}
