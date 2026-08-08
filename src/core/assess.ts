/**
 * Assembling one answer from every source, and being explicit about which
 * sources actually answered.
 */

import { fetchDisplayNames, fetchHolders, sideForIndex } from '../sources/dataapi.js';
import { fetchMarketsByCondition } from '../sources/gamma.js';
import { buildLedger, type WalletLedger } from './wallet.js';
import { chainNote } from '../sources/chain.js';
import { fetchTokenPayouts, fetchTokenPositions, fetchWalletPositions } from '../sources/subgraph.js';
import {
  caveatsFor, concentration, observableSide, repeatPlayers, tradeConcentration, winningSide,
} from './capture.js';
import { disputeWeight, parseDispute } from './dispute.js';
import type {
  Assessment, EvidenceTier, Holder, Market, RepeatPlayer, Side, Winner,
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

  if (opts.winners && won && winToken) {
    const scan = await fetchTokenPositions(winToken, { limit: winnerLimit });
    if (scan.failed) {
      winnersFailed = scan.failed;
    } else {
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

/**
 * Everything one wallet did, joined across three sources.
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
  const scan = await fetchWalletPositions(address, opts);

  if (scan.failed) {
    return {
      address, entries: [], won: 0, lost: 0, split: 0, open: 0,
      gain: 0, contestedGain: 0, contested: 0,
      caveats: [`positions could not be read: ${scan.failed}`],
      floor: 0, truncated: false,
    };
  }

  // One request, for the header of the whole view. Best effort: a wallet with
  // no name is the common case and is not worth failing a ledger over.
  const named = await fetchDisplayNames([address]).catch(() => undefined);

  const payoutScan = await fetchTokenPayouts(scan.positions.map((p) => p.tokenId));
  const conditions = [...new Set([...payoutScan.byToken.values()].map((p) => p.conditionId))];
  const { markets, missing } = await fetchMarketsByCondition(conditions);

  const ledger = buildLedger({
    address,
    positions: scan.positions,
    payouts: payoutScan.byToken,
    markets,
  });

  if (payoutScan.failed) {
    ledger.caveats.unshift(`payouts could not be read: ${payoutScan.failed}`);
  }
  if (missing.length > 0) {
    ledger.caveats.push(`${missing.length} markets were not in Gamma and are not counted`);
  }
  if (scan.floor > 0) {
    ledger.caveats.push(`positions under ${scan.floor} tokens were not requested`);
  }
  if (scan.truncated) {
    ledger.caveats.push('more positions exist than were requested, use --limit');
  }

  return {
    ...ledger,
    name: named?.byAddress.get(address.trim().toLowerCase()),
    floor: scan.floor,
    truncated: scan.truncated,
  };
}
