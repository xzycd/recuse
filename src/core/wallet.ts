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
  let open = 0;
  let gain = 0;
  let contestedGain = 0;
  let contested = 0;

  for (const entry of entries) {
    if (!entry.resolved) {
      open += 1;
      continue;
    }
    if (entry.payout === 1) won += 1;
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
    open,
    gain,
    contestedGain,
    contested,
    caveats,
  };
}
