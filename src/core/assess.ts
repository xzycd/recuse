/**
 * Assembling one answer from every source, and being explicit about which
 * sources actually answered.
 */

import { fetchDisplayNames, fetchHolders, sideForIndex } from '../sources/dataapi.js';
import { fetchMarketsByCondition } from '../sources/gamma.js';
import { buildLedger, payoutFromPrices, type WalletLedger } from './wallet.js';
import { chainNote } from '../sources/chain.js';
import {
  fetchIndexHead, fetchTokenPayouts, fetchTokenPositions, fetchWalletPositions,
} from '../sources/subgraph.js';
import { fetchMarketTrades, fetchWalletTrades } from '../sources/trades.js';
import { positionsForToken, positionsForWallet } from './rebuild.js';
import {
  caveatsFor, concentration, observableSide, repeatPlayers, repeatWinners, tradeConcentration,
  winningSide, type WinningOutcome,
} from './capture.js';
import { disputeWeight, parseDispute, parseMarketDate } from './dispute.js';
import type {
  Assessment, EvidenceTier, Holder, Market, Regular, RepeatPlayer, Side, Winner,
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

/**
 * Did this market close after the trade index stops?
 *
 * Returns the head time when it did, and undefined when the reading is covered
 * or when the head itself could not be read. An unknown head produces no claim
 * in either direction, because "we do not know how far the index reaches" is
 * not the same as "it reaches this market".
 */
async function beyondTradeIndex(market: Market): Promise<string | undefined> {
  const head = await fetchIndexHead().catch(() => undefined);
  if (!head?.lastTradeAt) return undefined;

  const closed = parseMarketDate(market.closedTime)
    ?? parseMarketDate(market.umaEndDate)
    ?? parseMarketDate(market.endDate);
  if (!closed) return undefined;

  return closed.getTime() > Date.parse(head.lastTradeAt) ? head.lastTradeAt : undefined;
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
  const { holderLimit = HOLDER_LIMIT, topN = 5, winnerLimit = 20 } = opts;

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
  let tradeLog: { floor: number; read: number; truncated: boolean } | undefined;

  if (opts.winners && won && winToken) {
    const scan = await fetchTokenPositions(winToken, { limit: winnerLimit });
    let positions = scan.positions;

    if (scan.failed) {
      winnersFailed = scan.failed;
    } else if (positions.length === 0) {
      // An empty answer is the ambiguous one. Only then is it worth a request
      // to find out whether the index even reaches this market.
      beyondIndex = await beyondTradeIndex(market);
    }

    // The index reached nothing here, either because it stops short of this
    // market or because the store refused. The trade log is current and covers
    // both, so a market that had no readable winning side at all now has one.
    // Tried second rather than first because where the index does answer it
    // answers in full, with no floor and no ceiling on how far back it counts.
    if (positions.length === 0 && (winnersFailed || beyondIndex)) {
      const log = await fetchMarketTrades(market.conditionId);
      const rebuilt = log.failed ? [] : positionsForToken(log.trades, winToken);

      if (rebuilt.length > 0) {
        winnersFailed = undefined;
        positions = rebuilt.slice(0, winnerLimit);
        tradeLog = {
          floor: log.floor,
          read: log.trades.length,
          truncated: log.truncated,
        };
        winnersTruncated = rebuilt.length > winnerLimit;
      } else if (log.failed && !winnersFailed) {
        winnersFailed = log.failed;
      }
    }

    if (!winnersFailed) {
      winners = positions.map((p) => ({
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

      // On the trade log path no token floor was applied: every position the
      // log produced is in the tally whatever its size. The dollar floor that
      // made the read servable is a different measurement and travels in
      // `tradeLog`, never folded into this one.
      winnerFloor = tradeLog ? 0 : scan.floor;
      winnerConc = tradeConcentration(winners, won, winnerFloor, topN);
      if (!tradeLog) winnersTruncated = scan.truncated;
    }
  } else if (opts.winners && won && !winToken) {
    winnersFailed = 'market has no usable token id';
  }

  // What was read, not what was configured. Deriving the tier from an
  // environment variable meant setting RECUSE_RPC_URL to anything at all, a
  // file: URL included, upgraded every reading to positions+chain while
  // `actors` stayed empty and no oracle request was ever made. The tier is the
  // one claim this tool makes about its own evidence, so it is now assembled
  // only from sources that answered.
  const tier: EvidenceTier = winnerConc ? 'positions+trades' : 'positions';

  const caveats = caveatsFor({
    holderCount: holders.length,
    // The endpoint groups by outcome token, so a full page on either side
    // means there is more book than we were shown.
    holdersTruncated: holders.length >= holderLimit,
    settled: observable?.settled ?? false,
    winnersFailed,
    winnerFloor,
    winnersTruncated,
    beyondIndex,
    tradeLog,
  });

  if (namesFailed) {
    caveats.push(`${namesFailed} winner names could not be looked up and show as addresses`);
  }

  // Ahead of the reading-specific caveats, because it applies to all of them.
  caveats.unshift(chainNote());
  if (holdersFailed) caveats.unshift('holder lookup failed for this market');
  if (!observable) caveats.push('no prices: cannot tell which side is which');

  return {
    market,
    dispute,
    concentration: conc,
    winnerConcentration: winnerConc,
    winners,
    tier,
    ...(beyondIndex ? { tradeIndexEndsAt: beyondIndex } : {}),
    ...(tradeLog ? { tradeLog } : {}),
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
  /**
   * Markets a winning side was actually read for, whether or not anyone
   * qualified: `marketsScored` plus the ones read and found empty. A market
   * nothing could answer is not in here, which is the difference between this
   * and the number of markets handed in.
   */
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
  /** Markets whose winning side the trade log answered instead of the index. */
  fromLog: number;
  /**
   * How many of those were past the index, as opposed to markets the store
   * refused outright.
   *
   * Two counters rather than one because `beyondIndex` minus this is the number
   * that stayed unread, and subtracting the whole of `fromLog` from it produced
   * a table claiming 22 of 18 markets were rescued.
   */
  fromLogPastIndex: number;
  /** Markets read from the log whose history was itself cut. Their rows are partial. */
  logCut: number;
  /**
   * Smallest and largest minimum trade size the log needed, in dollars.
   *
   * Deliberately not folded into `floorLow` and `floorHigh` below. Those are a
   * minimum position in tokens and these are a minimum trade in dollars, and a
   * single pair of fields carrying both would read as one measurement.
   */
  logFloorLow: number;
  logFloorHigh: number;
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
  const logFloors: number[] = [];
  let marketsFailed = 0;
  let undecided = 0;
  let empty = 0;
  let beyond = 0;
  let fromLog = 0;
  let fromLogPastIndex = 0;
  let logCut = 0;
  let seen = 0;

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

    const scan = await fetchTokenPositions(token, { limit: winnerLimit });
    const refused = scan.failed !== undefined;
    if (!refused) floors.push(scan.floor);

    let winners: Winner[] = refused ? [] : scan.positions.map((p) => ({
      address: p.address, bought: p.bought, net: p.net, spent: p.spent, netSpent: p.netSpent,
    }));
    let held = winners.filter((w) => w.net > 0);

    // Nothing from the index, which is two different situations. The store may
    // have refused, or it may have answered an empty list for a market it never
    // reached. Only the head can tell them apart, and it is only worth asking
    // when the answer was empty.
    const past = held.length === 0 && !refused ? await beyondTradeIndex(market) : undefined;
    if (past) beyond += 1;

    // Either way the log is current and can answer. Started partway up the
    // floor ladder because this is one market of dozens: the low rungs each
    // cost two requests to discover the market is too busy for them, and a
    // repeat tally is not decided by trades worth fifty dollars.
    if (held.length === 0 && (refused || past)) {
      const log = await fetchMarketTrades(market.conditionId, { minFloor: 500 });
      const rebuilt = log.failed ? [] : positionsForToken(log.trades, token);
      const top: Winner[] = rebuilt.slice(0, winnerLimit).map((p) => ({
        address: p.address, bought: p.bought, net: p.net, spent: p.spent, netSpent: p.netSpent,
      }));

      if (top.some((w) => w.net > 0)) {
        winners = top;
        held = top.filter((w) => w.net > 0);
        logFloors.push(log.floor);
        if (log.truncated) logCut += 1;
        fromLog += 1;
        if (past) fromLogPastIndex += 1;
      }
    }

    // Three kinds of nothing, and the whole point of this scan is that they are
    // counted apart. A market the store refused and the log could not rescue was
    // never read. A market past the head that the log could not rescue is
    // already counted in `beyond` and is likewise unread. Only the third is a
    // market that was read and genuinely had nobody in it.
    if (held.length === 0) {
      if (refused) marketsFailed += 1;
      else if (!past) empty += 1;
      continue;
    }

    for (const w of held) wallets.add(w.address);

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
    fromLog,
    fromLogPastIndex,
    logCut,
    logFloorLow: logFloors.length > 0 ? Math.min(...logFloors) : 0,
    logFloorHigh: logFloors.length > 0 ? Math.max(...logFloors) : 0,
    indexHead: (await fetchIndexHead().catch(() => undefined))?.lastTradeAt,
    floorLow,
    floorHigh,
    floorRaised: floors.filter((f) => f > floorLow).length,
    wallets: wallets.size,
    namesAsked: named ? asked.length : 0,
    namesFailed: named?.failed ?? 0,
  };
}

/**
 * Everything one wallet did, joined across three sources.
 *
 * The index is asked first, because where it reaches it answers in full. Where
 * it does not, and that is now most of the last seven months, the trade log
 * answers instead and the ledger says which one it stands on.
 *
 * Both routes end at Gamma for the question text, the dispute history and,
 * critically, the token-to-outcome mapping. Neither trade source carries a
 * usable outcome index, so Gamma is the only thing that knows which side a
 * token is, and every wrong index flips a win into a loss.
 */
export async function assessWallet(
  address: string,
  opts: { limit?: number; floor?: number } = {},
): Promise<WalletLedger & { floor: number; truncated: boolean }> {
  const { limit = 60 } = opts;
  const scan = await fetchWalletPositions(address, opts);

  let positions: { tokenId: string; conditionId?: string; net: number; netSpent: number; bought: number }[]
    = scan.positions;
  let floor = scan.floor;
  let truncated = scan.truncated;
  let fromLog: { read: number; truncated: boolean } | undefined;
  let readFailed = scan.failed;

  // Nothing came back, either because the index stops short of everything this
  // wallet did or because the store refused. Both look like a wallet that never
  // traded, which is exactly the answer a live wallet holding 5.8 million
  // tokens was getting.
  if (positions.length === 0) {
    const log = await fetchWalletTrades(address);
    const rebuilt = log.failed ? [] : positionsForWallet(log.trades);

    if (rebuilt.length > 0) {
      readFailed = undefined;
      positions = rebuilt.slice(0, limit);
      floor = 0;
      truncated = rebuilt.length > limit;
      fromLog = { read: log.trades.length, truncated: log.truncated };
    } else if (log.failed && !readFailed) {
      readFailed = log.failed;
    }
  }

  if (readFailed) {
    return {
      address, entries: [], won: 0, lost: 0, split: 0, exited: 0, open: 0,
      gain: 0, contestedGain: 0, contested: 0,
      caveats: [`positions could not be read: ${readFailed}`],
      floor: 0, truncated: false,
    };
  }

  // One request, for the header of the whole view. Best effort: a wallet with
  // no name is the common case and is not worth failing a ledger over.
  const named = await fetchDisplayNames([address]).catch(() => undefined);

  const payoutScan = await fetchTokenPayouts(positions.map((p) => p.tokenId));

  // Conditions from the payouts where the index knew them, and from the trades
  // themselves where it did not. Without the second half a wallet read from the
  // log would have tokens, prices and no markets to attach them to.
  const conditions = [...new Set([
    ...[...payoutScan.byToken.values()].map((p) => p.conditionId),
    ...positions.map((p) => p.conditionId).filter((c): c is string => !!c),
  ])];
  const { markets, missing } = await fetchMarketsByCondition(conditions);

  // The index has no payout for a condition resolved after its head, so the
  // closing price stands in. Only ever a fallback, and only where the chain
  // answered with nothing rather than with a resolution.
  let priced = 0;
  for (const position of positions) {
    if (payoutScan.byToken.has(position.tokenId)) continue;
    const market = position.conditionId ? markets.get(position.conditionId) : undefined;
    const fallback = market ? payoutFromPrices(market) : undefined;
    if (fallback) {
      payoutScan.byToken.set(position.tokenId, fallback);
      priced += 1;
    } else if (market) {
      // Still needs the condition, or the position drops out of the ledger
      // entirely rather than showing up as the open position it is.
      payoutScan.byToken.set(position.tokenId, { conditionId: market.conditionId });
    }
  }

  const ledger = buildLedger({
    address,
    positions,
    payouts: payoutScan.byToken,
    markets,
  });

  if (payoutScan.failed) {
    ledger.caveats.unshift(`payouts could not be read: ${payoutScan.failed}`);
  }
  if (fromLog) {
    ledger.caveats.unshift(
      `the trade index reached nothing for this wallet, so this is rebuilt from ${fromLog.read} trades in the log`,
    );
    if (fromLog.truncated) {
      ledger.caveats.push(
        `only the ${fromLog.read} most recent trades were reachable, so older positions are missing`,
      );
    }
  }
  if (priced > 0) {
    ledger.caveats.push(
      `${priced} of these settled after the chain payout index stops, and are priced from closing prices instead`,
    );
  }
  if (missing.length > 0) {
    ledger.caveats.push(`${missing.length} markets were not in Gamma and are not counted`);
  }
  if (floor > 0) {
    ledger.caveats.push(`positions under ${floor} tokens were not requested`);
  }
  if (truncated) {
    ledger.caveats.push('more positions exist than were requested, use --limit');
  }

  return {
    ...ledger,
    name: named?.byAddress.get(address.trim().toLowerCase()),
    floor,
    truncated,
  };
}
