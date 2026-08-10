/**
 * Assembling one answer from every source, and being explicit about which
 * sources actually answered.
 */

import { fetchDisplayNames, fetchHolders } from '../sources/dataapi.js';
import { fetchMarketsByCondition } from '../sources/gamma.js';
import { buildLedger, type WalletLedger } from './wallet.js';
import { chainNote } from '../sources/chain.js';
import {
  fetchIndexHead, fetchTokenPayouts, fetchTokenPositions, fetchWalletPositions, type IndexHead,
} from '../sources/subgraph.js';
import {
  caveatsFor, concentration, observableSide, repeatPlayers, repeatWinners, tradeConcentration,
  sideForIndex, winningSide, type WinningOutcome,
} from './capture.js';
import { disputeWeight, parseDispute, parseMarketDate } from './dispute.js';
import { redactMessage, safeAddress } from './safe.js';
import type {
  Assessment, EvidenceTier, Holder, Market, Regular, RepeatPlayer, Side, TradeIndexCoverage, Winner,
} from '../types.js';

/** How many holders to request per market. The API pages beyond this. */
const HOLDER_LIMIT = 100;

export interface AssessOptions {
  holderLimit?: number;
  topN?: number;
  /**
   * Rebuild the winning side from trades. Off by default on the radar, where it
   * would add a subgraph round trip per row, and on for a single market, where
   * one extra request is worth the half of the market it recovers.
   */
  winners?: boolean;
  winnerLimit?: number;
  /**
   * Put display names to the winning wallets. One request per wallet, so it is
   * off on the radar, where it would multiply by the number of rows, and on for
   * `winners`, which is the one surface where a list of bare addresses is the
   * output rather than a column in it.
   */
  winnerNames?: boolean;
}

/** Classify whether an empty trade query is evidence of an empty winner set. */
export function classifyTradeIndexCoverage(
  market: Market,
  head: IndexHead,
): TradeIndexCoverage {
  if (head.failed) return { status: 'unknown', reason: `trade index head could not be read: ${head.failed}` };
  if (!head.lastTradeAt) return { status: 'unknown', reason: 'trade index returned no head time' };

  const closed = parseMarketDate(market.closedTime)
    ?? parseMarketDate(market.umaEndDate)
    ?? parseMarketDate(market.endDate);
  if (!closed) return { status: 'unknown', reason: 'market has no usable close time' };

  const headMs = Date.parse(head.lastTradeAt);
  if (!Number.isFinite(headMs)) return { status: 'unknown', reason: 'trade index returned an invalid head time' };

  return closed.getTime() > headMs
    ? { status: 'beyond', lastTradeAt: head.lastTradeAt }
    : { status: 'covered', lastTradeAt: head.lastTradeAt };
}

async function readTradeIndexCoverage(market: Market): Promise<TradeIndexCoverage> {
  try {
    return classifyTradeIndexCoverage(market, await fetchIndexHead());
  } catch (err) {
    return {
      status: 'unknown',
      reason: `trade index head could not be read: ${redactMessage((err as Error).message ?? String(err))}`,
    };
  }
}

/** Which CLOB token id represents a side, using the market's own labels. */
export function tokenIdForSide(market: Market, side: Side): string | undefined {
  for (let i = 0; i < market.tokenIds.length; i++) {
    if (sideForIndex(market, i) === side) return market.tokenIds[i];
  }
  return undefined;
}

/**
 * Read one market: what happened to its resolution, and who held it.
 *
 * Never throws for a missing source. A market with unreachable holders still
 * returns an assessment, with the gap recorded as a caveat. A partial answer
 * that says so is useful, and a crash is not.
 */
export async function assess(market: Market, opts: AssessOptions = {}): Promise<Assessment> {
  const holderLimit = Number.isFinite(opts.holderLimit)
    ? Math.min(500, Math.max(1, Math.floor(opts.holderLimit!)))
    : HOLDER_LIMIT;
  const topN = Number.isFinite(opts.topN) ? Math.max(1, Math.floor(opts.topN!)) : 5;
  const winnerLimit = Number.isFinite(opts.winnerLimit)
    ? Math.min(100, Math.max(1, Math.floor(opts.winnerLimit!)))
    : 20;

  const dispute = parseDispute(market);
  const observable = observableSide(market);

  let holders: Holder[] = [];
  let holdersFailed = false;
  try {
    holders = await fetchHolders(market, holderLimit);
  } catch {
    holdersFailed = true;
  }

  const conc = observable
    ? concentration(holders, observable.side, observable.meaning, topN)
    : undefined;

  // The other half of a settled market, the half redemption erased. Only asked
  // for when requested, and only when there is a decided winner to ask about.
  const won = winningSide(market);
  const winToken = won ? tokenIdForSide(market, won) : undefined;

  let winners: Winner[] | undefined;
  let winnerConc: Assessment['winnerConcentration'];
  let winnersFailed: string | undefined;
  let winnerFloor: number | undefined;
  let winnersTruncated = false;
  let namesFailed: number | undefined;
  let beyondIndex: string | undefined;
  let coverageUnknown: string | undefined;
  let tradeIndexCoverage: TradeIndexCoverage | undefined;
  let winnersDropped = 0;
  let tradesRead = false;

  if (opts.winners && won && winToken) {
    tradeIndexCoverage = await readTradeIndexCoverage(market);
    if (tradeIndexCoverage.status === 'beyond') {
      beyondIndex = tradeIndexCoverage.lastTradeAt;
    } else if (tradeIndexCoverage.status === 'unknown') {
      coverageUnknown = tradeIndexCoverage.reason;
    } else {
      const scan = await fetchTokenPositions(winToken, { limit: winnerLimit });
      if (scan.failed) {
        winnersFailed = scan.failed;
        tradeIndexCoverage = { status: 'unknown', reason: `winning-side query failed: ${scan.failed}` };
      } else {
        winnersDropped = scan.dropped;
        tradesRead = true;
        winners = scan.positions.map((p) => ({
          address: p.address, bought: p.bought, net: p.net, spent: p.spent, netSpent: p.netSpent,
        }));

        if (opts.winnerNames && winners.length > 0) {
          const named = await fetchDisplayNames(winners.map((w) => w.address));
          winners = winners.map((w) => {
            const name = named.byAddress.get(w.address);
            return name ? { ...w, name } : w;
          });
          // Distinguishes "these wallets are unnamed" from "we could not ask".
          if (named.failed > 0) namesFailed = named.failed;
        }

        winnerConc = tradeConcentration(winners, won, scan.floor, topN);
        winnerFloor = scan.floor;
        winnersTruncated = scan.truncated;
      }
    }
  } else if (opts.winners && won && !winToken) {
    winnersFailed = 'market has no usable token id';
    tradeIndexCoverage = { status: 'unknown', reason: winnersFailed };
  }

  // What was read, not what was configured. Deriving the tier from an
  // environment variable meant setting RECUSE_RPC_URL to anything at all, a
  // file: URL included, upgraded every reading to positions+chain while
  // `actors` stayed empty and no oracle request was ever made. The tier is the
  // one claim this tool makes about its own evidence, so it is now assembled
  // only from sources that answered.
  const tier: EvidenceTier = !holdersFailed && tradesRead
    ? 'positions+trades'
    : !holdersFailed
      ? 'positions'
      : tradesRead
        ? 'trades'
        : 'catalogue';

  const holderCount = observable
    ? holders.filter((h) => h.side === observable.side).length
    : holders.length;

  const caveats = caveatsFor({
    holderCount,
    // The endpoint groups by outcome token, so a full page on either side
    // means there is more book than we were shown.
    holdersTruncated: observable
      ? holderCount >= holderLimit
      : ['YES', 'NO'].some((side) => holders.filter((h) => h.side === side).length >= holderLimit),
    settled: observable?.settled ?? false,
    winnersFailed,
    winnerFloor,
    winnersTruncated,
    beyondIndex,
    coverageUnknown,
  });

  if (namesFailed) {
    caveats.push(`${namesFailed} winner names could not be looked up and show as addresses`);
  }
  if (winnersDropped > 0) {
    caveats.push(`${winnersDropped} malformed winning positions were omitted`);
  }

  // Ahead of the reading-specific caveats, because it applies to all of them.
  caveats.unshift(chainNote());
  if (holdersFailed) caveats.unshift('holder lookup failed for this market');
  if (!observable) caveats.push('no usable binary price pair: no single side can be identified');

  return {
    market,
    dispute,
    concentration: conc,
    winnerConcentration: winnerConc,
    winners,
    tier,
    ...(beyondIndex ? { tradeIndexEndsAt: beyondIndex } : {}),
    ...(tradeIndexCoverage ? { tradeIndexCoverage } : {}),
    caveats,
    pool: market.volume,
    fetchedAt: new Date().toISOString(),
  };
}

/** Read several markets, in dispute-weight order. */
export async function assessAll(
  markets: Market[],
  opts: AssessOptions = {},
  onProgress?: (done: number, total: number) => void,
): Promise<Assessment[]> {
  const out: Assessment[] = [];

  // Sequential: these endpoints are free and unmetered, and a burst of
  // parallel requests is how a user ends up rate limited by someone else's
  // infrastructure.
  for (const market of markets) {
    out.push(await assess(market, opts));
    onProgress?.(out.length, markets.length);
  }

  return out.sort(
    (a, b) => disputeWeight(b.dispute, b.pool) - disputeWeight(a.dispute, a.pool),
  );
}

/**
 * Tally addresses across a set of assessed markets.
 *
 * Needs the holders back, which `assess` does not keep. Carrying every
 * holder of every market through the assessment just so this function can have
 * them would bloat the JSON output for everyone who never calls this.
 */
export async function tallyRepeatPlayers(
  markets: Market[],
  opts: { holderLimit?: number; minAppearances?: number } = {},
  onProgress?: (done: number, total: number) => void,
): Promise<{ players: RepeatPlayer[]; marketsRead: number; marketsFailed: number }> {
  const { holderLimit = HOLDER_LIMIT, minAppearances = 2 } = opts;

  const outcomes = [];
  let marketsFailed = 0;
  let seen = 0;

  for (const market of markets) {
    const observable = observableSide(market);
    seen += 1;
    onProgress?.(seen, markets.length);
    // Only settled markets have a decided loser. A live market's leading side
    // is a price, and tallying it would count opinions as outcomes.
    if (!observable?.settled) continue;

    try {
      outcomes.push({ holders: await fetchHolders(market, holderLimit), loser: observable.side });
    } catch {
      marketsFailed += 1;
    }
  }

  return {
    players: repeatPlayers(outcomes, minAppearances),
    marketsRead: outcomes.length,
    marketsFailed,
  };
}

/** What a cross-market winner tally covered, and what it did not. */
export interface RegularScan {
  regulars: Regular[];
  /** Markets whose winning side query succeeded. */
  marketsRead: number;
  /**
   * Markets that returned at least one winning position, and the denominator
   * for `wins`.
   *
   * Not `marketsRead`. A market where the subgraph answered but no position
   * cleared the floor is one nobody can be credited with winning, so counting
   * it against every wallet understates all of them equally and invents a
   * denominator that was never on offer.
   */
  marketsScored: number;
  /** Markets the subgraph refused. Not counted as markets with no winners. */
  marketsFailed: number;
  /** Markets still live, so there is no winning side to rebuild yet. */
  undecided: number;
  /** Read, but nothing cleared the floor. Genuinely empty, and covered. */
  empty: number;
  /**
   * Markets that closed after the trade index stops, so nothing was read.
   *
   * Kept apart from `empty` because the store reports the two identically, and
   * folding them together is how two thirds of the contested set came to be
   * described as markets nobody won.
   */
  beyondIndex: number;
  /** Empty answers whose index coverage could not be established. */
  coverageUnknown: number;
  /** ISO time of the last indexed trade, when it could be read. */
  indexHead?: string;
  /** Smallest and largest floor any market needed, in tokens. */
  floorLow: number;
  floorHigh: number;
  /** Markets that needed a floor above the smallest one used. */
  floorRaised: number;
  /** Distinct winning wallets seen, before the repeat filter. */
  wallets: number;
  /**
   * How many of the ranked rows had a name looked up, from the top.
   *
   * A row past this had no request made for it, which is not the same as an
   * account with no name, and the renderer is required to tell them apart.
   */
  namesAsked: number;
  /** Names that were asked for and could not be read. */
  namesFailed: number;
  /** Malformed position rows omitted across the markets that answered. */
  positionsDropped: number;
}

/**
 * Who keeps ending up on the winning side of contested markets.
 *
 * One subgraph query per market, which is why this is its own command rather
 * than a column on the radar. `tallyRepeatPlayers` above is the cheap mirror of
 * this: losers sit in balances and cost one holder lookup, winners redeemed and
 * have to be rebuilt from trades.
 *
 * Every count that could be mistaken for a zero is returned separately. A
 * market the subgraph timed out on is not a market where nobody won, and a
 * market still trading has no winning side at all yet. Collapsing either into
 * `marketsRead` would put a confident denominator under a number that never
 * covered it.
 */
export async function tallyRegulars(
  markets: Market[],
  opts: { winnerLimit?: number; minWins?: number; nameLimit?: number } = {},
  onProgress?: (done: number, total: number) => void,
): Promise<RegularScan> {
  // The name limit matches the rows the table draws, so every visible row is a
  // row a request was made for and `(anon)` never covers for "did not ask".
  const { winnerLimit = 50, minWins = 2, nameLimit = 40 } = opts;

  const outcomes: WinningOutcome[] = [];
  const wallets = new Set<string>();
  const floors: number[] = [];
  let marketsFailed = 0;
  let undecided = 0;
  let empty = 0;
  let beyond = 0;
  let coverageUnknown = 0;
  let positionsDropped = 0;
  let seen = 0;
  let indexHead: IndexHead | undefined;

  const coverageFor = async (market: Market): Promise<TradeIndexCoverage> => {
    indexHead ??= await fetchIndexHead().catch((err: Error) => ({ failed: redactMessage(err.message) }));
    return classifyTradeIndexCoverage(market, indexHead);
  };

  for (const market of markets) {
    seen += 1;
    onProgress?.(seen, markets.length);

    // Only a settled market has a decided winner. A live market's leading side
    // is a price, and tallying it would count opinions as outcomes.
    const won = winningSide(market);
    const token = won ? tokenIdForSide(market, won) : undefined;
    if (!won || !token) {
      undecided += 1;
      continue;
    }

    const coverage = await coverageFor(market);
    if (coverage.status === 'beyond') {
      beyond += 1;
      continue;
    }
    if (coverage.status === 'unknown') {
      coverageUnknown += 1;
      continue;
    }

    const scan = await fetchTokenPositions(token, { limit: winnerLimit });
    if (scan.failed) {
      marketsFailed += 1;
      continue;
    }

    positionsDropped += scan.dropped;

    const winners: Winner[] = scan.positions.map((p) => ({
      address: p.address, bought: p.bought, net: p.net, spent: p.spent, netSpent: p.netSpent,
    }));

    const held = winners.filter((w) => w.net > 0);
    for (const w of held) wallets.add(w.address);

    // A market nobody can be credited with winning is read but not scored, and
    // it stays out of the denominator rather than counting against everyone.
    // Which of the two kinds of nothing this is decides what gets reported.
    if (held.length === 0) {
      floors.push(scan.floor);
      empty += 1;
      continue;
    }

    floors.push(scan.floor);

    // The slug is what makes a row checkable with `recuse market`. Condition id
    // is the fallback, since a market without a slug still has one of those.
    outcomes.push({ market: market.slug || market.conditionId, winners });
  }

  const regulars = repeatWinners(outcomes, minWins);

  // Names only for the rows anyone will read. This is one request per wallet,
  // so naming all 108 repeat winners of a 600 market scan would cost several
  // times what the tally did. How many were asked for travels with the result,
  // because a row nobody asked about is not a row with no name.
  const asked = regulars.slice(0, nameLimit).map((r) => r.address);
  const named = await fetchDisplayNames(asked).catch(() => undefined);

  const floorLow = floors.length > 0 ? Math.min(...floors) : 0;
  const floorHigh = floors.length > 0 ? Math.max(...floors) : 0;

  return {
    regulars: regulars.map((r) => {
      const name = named?.byAddress.get(r.address);
      return name ? { ...r, name } : r;
    }),
    marketsRead: outcomes.length + empty,
    marketsScored: outcomes.length,
    marketsFailed,
    undecided,
    empty,
    beyondIndex: beyond,
    coverageUnknown,
    indexHead: indexHead?.lastTradeAt,
    floorLow,
    floorHigh,
    floorRaised: floors.filter((f) => f > floorLow).length,
    wallets: wallets.size,
    namesAsked: named ? asked.length : 0,
    namesFailed: named?.failed ?? 0,
    positionsDropped,
  };
}

/**
 * Every position one wallet carried into settlement, joined across three sources.
 *
 * Subgraph for what they bought, subgraph again for how each condition paid out
 * on chain, and Gamma for the question text, the dispute history and, critically,
 * the token-to-outcome mapping. The subgraph's own outcome index is null, so
 * Gamma is the only source for which side a token is.
 */
export async function assessWallet(
  address: string,
  opts: { limit?: number; floor?: number } = {},
): Promise<WalletLedger & { floor: number; truncated: boolean }> {
  const who = safeAddress(address);
  if (!who) throw new Error('wallet address must be a 0x-prefixed 20-byte address');

  const scan = await fetchWalletPositions(who, opts);

  if (scan.failed) {
    return {
      address: who, entries: [], won: 0, lost: 0, split: 0, open: 0,
      gain: 0, contestedGain: 0, contested: 0,
      caveats: [`positions could not be read: ${scan.failed}`],
      floor: 0, truncated: false,
    };
  }

  // One request, for the header of the whole view. Best effort: a wallet with
  // no name is the common case and is not worth failing a ledger over.
  const [named, indexHead] = await Promise.all([
    fetchDisplayNames([who]).catch(() => undefined),
    fetchIndexHead().catch((err: Error): IndexHead => ({ failed: redactMessage(err.message) })),
  ]);

  const payoutScan = await fetchTokenPayouts(scan.positions.map((p) => p.tokenId));
  const conditions = [...new Set([...payoutScan.byToken.values()].map((p) => p.conditionId))];
  const { markets, missing, failed: catalogueFailures } = await fetchMarketsByCondition(conditions);

  const ledger = buildLedger({
    address: who,
    positions: scan.positions,
    payouts: payoutScan.byToken,
    markets,
  });

  const tradeIndex: WalletLedger['tradeIndex'] = indexHead.lastTradeAt
    ? {
      status: 'known',
      lastTradeAt: indexHead.lastTradeAt,
      ...(indexHead.block === undefined ? {} : { block: indexHead.block }),
    }
    : {
      status: 'unknown',
      reason: indexHead.failed ?? 'trade index returned no head time',
    };
  ledger.tradeIndex = tradeIndex;
  ledger.caveats.unshift(
    tradeIndex.status === 'known'
      ? `trade history ends at ${tradeIndex.lastTradeAt.slice(0, 10)}; later trades are absent`
      : `trade history recency is unknown: ${tradeIndex.reason}`,
  );

  if (payoutScan.failed) {
    ledger.caveats.unshift(`payouts could not be read: ${payoutScan.failed}`);
  }
  if (payoutScan.invalid > 0) {
    ledger.caveats.push(`${payoutScan.invalid} malformed payout records were treated as unresolved`);
  }
  if (missing.length > 0) {
    ledger.caveats.push(
      catalogueFailures > 0
        ? `${missing.length} markets could not be found or read in Gamma and are not counted`
        : `${missing.length} markets were not in Gamma and are not counted`,
    );
  }
  if (catalogueFailures > 0) {
    ledger.caveats.push(`${catalogueFailures} Gamma catalogue requests failed`);
  }
  if (scan.floor > 0) {
    ledger.caveats.push(`positions at or below ${scan.floor} tokens were not requested`);
  }
  if (scan.truncated) {
    ledger.caveats.push('more positions exist than were requested, use --limit');
  }
  if (scan.dropped > 0) {
    ledger.caveats.push(`${scan.dropped} malformed positions were omitted`);
  }

  return {
    ...ledger,
    name: named?.byAddress.get(who),
    floor: scan.floor,
    truncated: scan.truncated,
  };
}
