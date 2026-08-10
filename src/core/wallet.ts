/**
 * One wallet's record across the markets it traded.
 *
 * Pure. Given positions from the subgraph, payouts from the chain, and markets
 * from Gamma, this works out which side each position was on and what it made.
 *
 * The trap that shaped this module: the subgraph's `MarketData.outcomeIndex` is
 * null on every record checked, and `Number(null)` is 0, so reading the side
 * from it silently reports every position as outcome 0. It reads as working
 * code and produces a full table of confident wrong answers, which is the exact
 * failure this project exists to catch. The index therefore comes from Gamma's
 * `clobTokenIds`, which is index-aligned with `outcomes`, and a token that is
 * not in that array is dropped rather than guessed at.
 *
 * The second thing worth stating: a settled position pays `numerator /
 * denominator` dollars per token, not one dollar. UMA does resolve markets
 * 50/50, and treating that as a loss on both sides would be wrong on both.
 */

import { parseDispute } from './dispute.js';
import type { Market, ResolutionStep } from '../types.js';

/** What one wallet did in one market. */
export interface WalletEntry {
  conditionId: string;
  slug: string;
  question: string;
  /** The outcome label as the market names it: Yes, No, Ravens. */
  side: string;
  outcomeIndex: number;
  rounds: number;
  steps: ResolutionStep[];
  /** Tokens carried into settlement: bought minus resold. */
  net: number;
  /** USD paid for them, net of anything sold back. */
  cost: number;
  /** USD the position paid out. Zero on a loser, net on a winner, in between on a split. */
  proceeds: number;
  /** proceeds minus cost. Undefined while the market is unresolved. */
  gain?: number;
  /** Dollars per token this side settled at, in [0, 1]. Undefined if unresolved. */
  payout?: number;
  resolved: boolean;
}

export interface WalletLedger {
  address: string;
  /**
   * Polymarket display name, when the account made one public. Absent means no
   * name, or a lookup that did not answer, and never distinguishes them.
   */
  name?: string;
  entries: WalletEntry[];
  /** Resolved positions only. An open position has no result to count. */
  won: number;
  lost: number;
  split: number;
  /**
   * Resolved markets the wallet had traded out of before settlement, so it was
   * paid nothing and lost nothing on the outcome. Their trading profit is still
   * in `gain`, because that money moved.
   */
  exited: number;
  open: number;
  /** Net USD across resolved positions. */
  gain: number;
  /** Net USD across resolved positions in markets that were disputed. */
  contestedGain: number;
  contested: number;
  caveats: string[];
}

export interface PayoutLike {
  conditionId: string;
  numerators?: number[];
  denominator?: number;
}

/**
 * The payout a settled market implies, read off Gamma's closing prices.
 *
 * Second best and used only as such. The chain payout is authoritative: it
 * survives a market being delisted and it states a split resolution as what it
 * is. But the subgraph that serves it stops at the same head its trades do, so
 * a condition resolved this year comes back with no payout and no error, and a
 * ledger built on that prices every recent position at nothing.
 *
 * Refuses rather than guesses in three places. An open market has live prices
 * and no payout at all. A price that does not land on a half is not a
 * resolution, whatever it looks like. And prices that sum to something other
 * than one are not a payout either, since the two sides of a resolved binary
 * market always divide exactly one dollar between them.
 */
export function payoutFromPrices(market: Market): PayoutLike | undefined {
  const prices = market.outcomePrices;
  if (prices.length < 2 || prices.some((p) => !Number.isFinite(p))) return undefined;

  const total = prices.reduce((a, p) => a + p, 0);
  if (Math.abs(total - 1) > 1e-6) return undefined;

  // Doubled, so 1 and 0 become 2 and 0 and a 50/50 becomes 1 and 1, over a
  // denominator of 2. Anything landing between those is not a resolution.
  const numerators = prices.map((p) => p * 2);
  if (numerators.some((n) => Math.abs(n - Math.round(n)) > 1e-6)) return undefined;

  return {
    conditionId: market.conditionId,
    numerators: numerators.map((n) => Math.round(n)),
    denominator: 2,
  };
}

export interface LedgerInput {
  address: string;
  positions: { tokenId: string; net: number; netSpent: number; bought: number }[];
  /** Token id to its condition and payout. */
  payouts: Map<string, PayoutLike>;
  /** Condition id to the Gamma record. */
  markets: Map<string, Market>;
}

/**
 * Which outcome index a token represents, from Gamma and only from Gamma.
 *
 * Returns undefined rather than a default. There is no safe default here: every
 * wrong index flips a win into a loss.
 */
export function indexOfToken(market: Market, tokenId: string): number | undefined {
  const index = market.tokenIds.indexOf(tokenId);
  return index >= 0 ? index : undefined;
}

/**
 * Dollars per token this outcome settled at.
 *
 * Undefined means unresolved, which is different from zero. Coercing an absent
 * payout to zero reports every open position as a total loss.
 */
export function payoutFor(payout: PayoutLike | undefined, index: number): number | undefined {
  const nums = payout?.numerators;
  const den = payout?.denominator;
  if (!nums || nums.length === 0 || !den || den <= 0) return undefined;

  const numerator = nums[index];
  if (numerator === undefined || !Number.isFinite(numerator)) return undefined;

  return numerator / den;
}

export function buildLedger(input: LedgerInput): WalletLedger {
  const entries: WalletEntry[] = [];
  const caveats: string[] = [];
  let unmatched = 0;

  for (const position of input.positions) {
    const payout = input.payouts.get(position.tokenId);
    const market = payout ? input.markets.get(payout.conditionId) : undefined;

    if (!market) {
      unmatched += 1;
      continue;
    }

    const index = indexOfToken(market, position.tokenId);
    if (index === undefined) {
      // The token belongs to this condition but is not in the market's token
      // list, which happens on multi-outcome markets Gamma splits differently.
      // Dropped, because a guessed index would flip wins into losses.
      unmatched += 1;
      continue;
    }

    const fraction = payoutFor(payout, index);
    const dispute = parseDispute(market);
    const proceeds = fraction === undefined ? 0 : position.net * fraction;

    entries.push({
      conditionId: market.conditionId,
      slug: market.slug,
      question: market.question,
      side: market.outcomes[index] ?? `#${index}`,
      outcomeIndex: index,
      rounds: dispute.rounds,
      steps: dispute.steps,
      net: position.net,
      cost: position.netSpent,
      proceeds,
      gain: fraction === undefined ? undefined : proceeds - position.netSpent,
      payout: fraction,
      resolved: fraction !== undefined,
    });
  }

  // Contested first, then by how much moved. Someone reading this wants the
  // disputed markets at the top; that is the whole reason they opened it here
  // rather than in a generic wallet tracker.
  entries.sort(
    (a, b) => b.rounds - a.rounds || Math.abs(b.gain ?? 0) - Math.abs(a.gain ?? 0) || b.net - a.net,
  );

  let won = 0;
  let lost = 0;
  let split = 0;
  let exited = 0;
  let open = 0;
  let gain = 0;
  let contestedGain = 0;
  let contested = 0;

  for (const entry of entries) {
    if (!entry.resolved) {
      open += 1;
      continue;
    }
    // Nothing was still held when this settled, so it was neither won nor lost.
    // The gain is real and stays in the total, because the position was traded
    // out at a price and that money moved. Counting it as a win would say the
    // wallet was paid a dollar a token on something it no longer owned.
    //
    // This case could not arise while positions came from the index, which was
    // asked for `netQuantity_gt` and so only ever returned survivors. The trade
    // log has no such filter and a wallet that flipped a position in full is
    // ordinary, which is how the distinction turned up at all.
    if (entry.net <= 0) exited += 1;
    else if (entry.payout === 1) won += 1;
    else if (entry.payout === 0) lost += 1;
    else split += 1;

    gain += entry.gain ?? 0;
    if (entry.rounds > 0) {
      contested += 1;
      contestedGain += entry.gain ?? 0;
    }
  }

  if (unmatched > 0) {
    caveats.push(`${unmatched} positions could not be matched to a market and are not counted`);
  }

  return {
    address: input.address,
    entries,
    won,
    lost,
    split,
    exited,
    open,
    gain,
    contestedGain,
    contested,
    caveats,
  };
}
