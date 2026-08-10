/**
 * Polymarket's data API, read as a trade log rather than as a balance sheet.
 *
 * This exists because the orderbook subgraph stopped. Its last indexed trade is
 * seven months behind the chain and it answers a market it never reached with
 * an empty list and HTTP 200, so 25 of 38 contested markets in a 600 market
 * scan had no readable winning side at all. `core/assess.ts` learned to say so
 * in 0.7.0. This is the module that answers instead.
 *
 * Two things about this endpoint decide the shape of everything below.
 *
 * **`takerOnly` defaults to true.** The default view is one side of each fill,
 * so a market that returns 11,135 trades returns 20,000 with `takerOnly=false`,
 * and the wallets in it were short by up to 40%. Nothing about that is visible
 * in the response: HTTP 200, a plausible history, half the volume missing. The
 * flag is set explicitly on every request here and there is no option to unset
 * it, because a caller who forgot would get a confident wrong answer.
 *
 * **Paging stops at offset 10,000.** Past that the endpoint replies `max
 * historical trades offset of 10000 exceeded`, so with a page size of 10,000
 * the reachable window is the 20,000 most recent trades and no more. That is
 * not enough for a busy market: 28 of those 38 have more. The way through is
 * `filterType=CASH`, a minimum trade size in dollars, which is the same bargain
 * `fetchTokenPositions` already strikes with the subgraph. Measured against a
 * market the subgraph did index, a $50 floor cut 20,000+ trades to 16,074, and
 * the rebuilt winning side matched the subgraph's within 0.2% on every wallet
 * of the top six, in the same order. The floor that worked travels back with
 * the data, because it is a fact about the reading.
 */

import { getJson } from './http.js';
import { redactMessage, safeAddress, safeHash, safeText, safeTokenId } from '../core/safe.js';

const BASE = 'https://data-api.polymarket.com';

/** Largest page the endpoint will serve. Asking for more returns this many. */
const PAGE = 10_000;

/**
 * Largest offset the endpoint will accept. Past it the reply is an error object
 * with HTTP 200, so the ceiling is detected rather than discovered as a gap.
 */
const MAX_OFFSET = 10_000;

/**
 * Trades reachable in total: one page at offset 0, one at the ceiling, so
 * 20,000. Not exported, because nothing outside needs the number. What a caller
 * needs is `truncated` and the count actually read, which is the real figure
 * rather than the theoretical one.
 */
const REACHABLE = PAGE + MAX_OFFSET;

/**
 * Minimum trade size in dollars to try, in order.
 *
 * Zero first, because a market small enough to read whole should be read whole.
 * Each rung is only used when the one below it hit the ceiling, and the rung
 * that fits is the one reported.
 */
const FLOOR_LADDER = [0, 50, 500, 5_000];

/** One fill, as this endpoint reports it. */
export interface Trade {
  address: string;
  /** The outcome token bought or sold. Never inferred from the outcome text. */
  tokenId: string;
  /**
   * The market the token belongs to.
   *
   * Carried because it is the only current way to get from a wallet's trades to
   * the markets behind them. The subgraph's token to condition mapping stops at
   * the same head its trades do, so a token traded this year resolves to
   * nothing there, with no error to show for it.
   */
  conditionId: string;
  side: 'BUY' | 'SELL';
  /** Tokens moved. */
  size: number;
  /** Dollars per token, so `size * price` is what changed hands. */
  price: number;
  /** Unix seconds. */
  at: number;
  /** The name the account chose, when it chose one. */
  name?: string;
}

export interface TradeScan {
  trades: Trade[];
  /**
   * Trades worth less than this many dollars were not requested. Zero means
   * every trade was, which is the only case where the read is the whole book.
   */
  floor: number;
  /**
   * True when the read hit the paging ceiling, so these are the most recent
   * `REACHABLE` trades of a market that has more. A cumulative total built on a
   * truncated read is not a cumulative total, and callers are expected to say
   * so rather than to quietly present one.
   */
  truncated: boolean;
  /** Unix seconds of the newest and oldest trade actually read. */
  newestAt?: number;
  oldestAt?: number;
  /** Set when nothing could be read. Never an empty list standing in for a zero. */
  failed?: string;
}

interface RawTrade {
  proxyWallet?: unknown;
  side?: unknown;
  asset?: unknown;
  conditionId?: unknown;
  size?: unknown;
  price?: unknown;
  timestamp?: unknown;
  name?: unknown;
  pseudonym?: unknown;
}

/**
 * A generated pseudonym is the absence of a name, not a name.
 *
 * Same rule as `dataapi.ts`, and the same reason: the fallback is the account's
 * own address with a timestamp glued on, and printing that as a chosen name
 * puts an identifier where a person should be. Kept here rather than shared
 * because the two endpoints spell the fields differently and a shared helper
 * would have to guess which.
 */
function chosenName(raw: RawTrade, address: string): string | undefined {
  const name = safeText(raw.name, 40).trim();
  if (!name) return undefined;
  if (name.toLowerCase().startsWith(address.slice(0, 10).toLowerCase())) return undefined;
  return name;
}

/**
 * A number that was actually served, or nothing.
 *
 * `Number(null)` is 0 and `Number('')` is 0, so the absence has to be caught
 * before the coercion rather than after it. A range check catches that for
 * size and timestamp, where zero is not a legal value, and misses it entirely
 * for price, where zero is: the losing side of a settled market really does
 * trade at zero, and an absent price would have passed as one.
 */
function served(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** One raw record to a trade, or nothing. A record missing an id is dropped. */
export function toTrade(raw: RawTrade): Trade | undefined {
  const address = safeAddress(raw.proxyWallet);
  const tokenId = safeTokenId(raw.asset);
  const conditionId = safeHash(raw.conditionId);
  if (!address || !tokenId || !conditionId) return undefined;

  const size = served(raw.size);
  const price = served(raw.price);
  const at = served(raw.timestamp);
  if (size === undefined || size <= 0) return undefined;
  if (price === undefined || price < 0) return undefined;
  if (at === undefined || at <= 0) return undefined;

  const side = raw.side === 'BUY' ? 'BUY' : raw.side === 'SELL' ? 'SELL' : undefined;
  if (!side) return undefined;

  const name = chosenName(raw, address);
  return { address, tokenId, conditionId, side, size, price, at, ...(name ? { name } : {}) };
}

/**
 * Page one query to the ceiling.
 *
 * The endpoint answers an over-large offset with a JSON object rather than a
 * list, which is why the shape is checked on every page: a body that is not an
 * array is a refusal wearing HTTP 200, and treating it as the end of the data
 * would silently shorten the read.
 */
async function page(query: string, timeoutMs: number): Promise<{ rows: RawTrade[]; hitCeiling: boolean }> {
  const rows: RawTrade[] = [];

  for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE) {
    const url = `${BASE}/trades?${query}&takerOnly=false&limit=${PAGE}&offset=${offset}`;
    const body = await getJson<unknown>(url, { timeoutMs });
    if (!Array.isArray(body)) throw new Error('trades endpoint returned no list');

    rows.push(...(body as RawTrade[]));
    if (body.length < PAGE) return { rows, hitCeiling: false };
  }

  // Every page filled, so the read stopped at the ceiling rather than at the
  // end of the market. The caller has to be told, because the difference is
  // between a cumulative total and the most recent slice of one.
  return { rows, hitCeiling: rows.length >= REACHABLE };
}

function scanFrom(rows: RawTrade[], floor: number, truncated: boolean): TradeScan {
  const trades = rows.map(toTrade).filter((t): t is Trade => t !== undefined);
  const times = trades.map((t) => t.at);

  return {
    trades,
    floor,
    truncated,
    ...(times.length > 0
      ? { newestAt: Math.max(...times), oldestAt: Math.min(...times) }
      : {}),
  };
}

/**
 * Every trade on one market, largest cash first when a floor is in play.
 *
 * Escalates the floor rather than returning a truncated read, because the top
 * of a market read whole above $50 is a true statement and the most recent
 * 20,000 fills of a market with 200,000 is not. Only the last rung can come
 * back truncated, and it says so.
 */
export async function fetchMarketTrades(
  conditionId: string,
  opts: { floor?: number; minFloor?: number; timeoutMs?: number } = {},
): Promise<TradeScan> {
  const condition = safeHash(conditionId);
  if (!condition) {
    return { trades: [], floor: 0, truncated: false, failed: 'malformed condition id' };
  }

  // `minFloor` starts the ladder partway up rather than pinning it, which is
  // what a caller reading dozens of markets wants: the low rungs cost two
  // requests each to discover a market too busy for them, and a cross-market
  // tally is not going to be decided by trades worth fifty dollars anyway.
  // `floor` still pins it to exactly one rung, for a caller that wants the
  // reading on stated terms rather than the best terms available.
  const ladder = opts.floor !== undefined
    ? [opts.floor]
    : FLOOR_LADDER.filter((f) => f >= (opts.minFloor ?? 0));
  // A `minFloor` above every rung leaves nothing to try, so the top rung
  // stands in rather than the read silently returning no trades.
  if (ladder.length === 0) ladder.push(FLOOR_LADDER[FLOOR_LADDER.length - 1] ?? 0);
  const timeoutMs = opts.timeoutMs ?? 30_000;

  for (const floor of ladder) {
    const filter = floor > 0 ? `&filterType=CASH&filterAmount=${floor}` : '';

    try {
      const { rows, hitCeiling } = await page(`market=${condition}${filter}`, timeoutMs);
      const last = floor === ladder[ladder.length - 1];
      if (!hitCeiling || last) return scanFrom(rows, floor, hitCeiling);
    } catch (err) {
      return {
        trades: [], floor: 0, truncated: false,
        failed: redactMessage((err as Error).message ?? String(err)).slice(0, 160),
      };
    }
  }

  // Unreachable: the loop returns on the last rung either way. Present so the
  // signature does not depend on that being true forever.
  return { trades: [], floor: 0, truncated: false, failed: 'trades could not be read' };
}

/**
 * Every trade one wallet made.
 *
 * No floor ladder. A wallet busy enough to pass 20,000 trades is rare, and
 * dropping its small positions to fit would quietly change what its record
 * says, which is worse for a ledger than admitting the read was cut.
 */
export async function fetchWalletTrades(
  address: string,
  opts: { timeoutMs?: number } = {},
): Promise<TradeScan> {
  const who = safeAddress(address);
  if (!who) return { trades: [], floor: 0, truncated: false, failed: 'malformed address' };

  try {
    const { rows, hitCeiling } = await page(`user=${who}`, opts.timeoutMs ?? 30_000);
    return scanFrom(rows, 0, hitCeiling);
  } catch (err) {
    return {
      trades: [], floor: 0, truncated: false,
      failed: redactMessage((err as Error).message ?? String(err)).slice(0, 160),
    };
  }
}
