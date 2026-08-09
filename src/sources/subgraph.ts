/**
 * Goldsky's orderbook subgraph: what people bought, as opposed to what they
 * still hold.
 *
 * This exists to answer the question the holders endpoint structurally cannot.
 * When a market settles, the winning side redeems for a dollar a token and
 * their balances go to zero, so a settled market's holder list is almost
 * entirely losers. Measured on the Zelenskyy market:
 *
 *   winning side, current balances   907 tokens across 36 wallets
 *   winning side, cumulative buys    71,435,381 tokens across the top 20
 *
 * The largest winner bought 7.1 million tokens and does not appear in the
 * holder list at all. `quantityBought` is cumulative and nothing erases it, so
 * this is the only free source that can see them.
 *
 * The two numbers are not interchangeable and the code never mixes them. A
 * balance is a position now. A cumulative buy is everything that was ever
 * bought, including anything sold again before resolution, which is why
 * `netQuantity` travels alongside it.
 */

import { redactMessage, safeAddress, safeHash, safeTokenId } from '../core/safe.js';
import { HttpError, readJsonCapped } from './http.js';

const ENDPOINT =
  'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket-orderbook-resync/prod/gn';

/** Positions are stored in 6 decimal fixed point, the same as USDC. */
const UNIT = 1_000_000;

/**
 * Minimum position size to ask for, in whole tokens.
 *
 * This is not a display preference, it is what makes the query servable. The
 * store times out on `where market = X order by quantityBought desc` across the
 * whole set often enough to matter; adding a lower bound gives the planner an
 * index to start from and the same query returns in about 300ms. The floor is
 * reported back to the caller so the reading is never described as the whole
 * book when it is the top of one.
 */
const DEFAULT_FLOOR = 1_000;

/** Floors to try in order when the store times out. Higher is cheaper to serve. */
const FLOOR_LADDER = [DEFAULT_FLOOR, 10_000, 100_000];

export interface TokenPosition {
  address: string;
  /** Everything ever bought, in tokens. Redemption does not touch this. */
  bought: number;
  /** Everything sold back on the orderbook, in tokens. */
  sold: number;
  /**
   * bought minus sold, in tokens. Redemption is not an orderbook sale, so for a
   * settled market this is the position held when trading stopped, which is the
   * number that decides who was paid.
   */
  net: number;
  /** USD paid, cumulative. */
  spent: number;
  /**
   * USD paid minus USD received back, checked against the raw fields to be
   * exactly `valueBought - valueSold`. This is the cost basis of `net`, so for
   * a settled market the profit is `net - netSpent` and is arithmetic rather
   * than an estimate: every held token on the winning side redeems for one
   * dollar.
   */
  netSpent: number;
}

export interface PositionScan {
  positions: TokenPosition[];
  /** Positions below this many tokens were not requested. */
  floor: number;
  /** True when the page filled, so there are more positions above the floor. */
  truncated: boolean;
  /** Set when nothing could be read. Never an empty list presented as a zero. */
  failed?: string;
}

interface RawPosition {
  user?: { id?: string };
  quantityBought?: string;
  quantitySold?: string;
  netQuantity?: string;
  valueBought?: string;
  netValue?: string;
}

/** Fixed point to a plain number. Positions are far below Number's integer limit. */
function fromUnits(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n / UNIT : 0;
}

export function toPosition(raw: RawPosition): TokenPosition | undefined {
  const address = safeAddress(raw.user?.id);
  if (!address) return undefined;

  const bought = fromUnits(raw.quantityBought);
  if (bought <= 0) return undefined;

  return {
    address,
    bought,
    sold: fromUnits(raw.quantitySold),
    net: fromUnits(raw.netQuantity),
    spent: fromUnits(raw.valueBought),
    netSpent: fromUnits(raw.netValue),
  };
}

async function query<T>(body: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!res.ok) throw new HttpError(`${res.status} ${res.statusText}`, res.status, ENDPOINT);

    const json = await readJsonCapped<{ data?: T; errors?: { message?: string }[] }>(res);
    // A GraphQL error arrives with HTTP 200 and a null data field. Treating that
    // as an empty result is exactly the confident zero this project exists to
    // avoid, so it is raised instead.
    if (json.errors?.length) {
      throw new Error(json.errors[0]?.message ?? 'subgraph returned an error');
    }
    if (!json.data) throw new Error('subgraph returned no data');

    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The largest buyers of one outcome token.
 *
 * Escalates the floor rather than giving up when the store times out, because a
 * reading of the top 20 positions above 10,000 tokens is worth having and a
 * reading of nothing is not. Whatever floor succeeded comes back with the data.
 */
export async function fetchTokenPositions(
  tokenId: string,
  opts: { limit?: number; floor?: number; timeoutMs?: number } = {},
): Promise<PositionScan> {
  const { limit = 20, timeoutMs = 20_000 } = opts;

  const token = safeTokenId(tokenId);
  if (!token) return { positions: [], floor: 0, truncated: false, failed: 'malformed token id' };

  const ladder = opts.floor === undefined ? FLOOR_LADDER : [opts.floor];
  let lastError = 'subgraph did not answer';

  for (const floor of ladder) {
    const units = (BigInt(Math.max(0, Math.floor(floor))) * BigInt(UNIT)).toString();
    // The token id and the floor are both validated numerics by this point, so
    // there is nothing here a caller could inject a clause through.
    const gql = `{ marketPositions(where: {market: "${token}", quantityBought_gt: "${units}"}, orderBy: quantityBought, orderDirection: desc, first: ${Math.min(Math.max(1, Math.floor(limit)), 100)}) { user { id } quantityBought quantitySold netQuantity valueBought netValue } }`;

    try {
      const data = await query<{ marketPositions?: RawPosition[] }>(
        JSON.stringify({ query: gql }),
        timeoutMs,
      );
      const rows = data.marketPositions ?? [];
      const positions = rows.map(toPosition).filter((p): p is TokenPosition => p !== undefined);

      return { positions, floor, truncated: rows.length >= limit };
    } catch (err) {
      lastError = redactMessage((err as Error).message ?? String(err));
      // Only a timeout is worth escalating the floor for. Anything else will
      // fail identically at the next rung and just costs the user more waiting.
      if (!/timeout|timed out|statement/i.test(lastError)) break;
    }
  }

  return { positions: [], floor: 0, truncated: false, failed: lastError.slice(0, 160) };
}

/** How far the trade index actually reaches. */
export interface IndexHead {
  /** ISO time of the most recent trade indexed. Absent when it could not be read. */
  lastTradeAt?: string;
  /** Head block the store has processed. */
  block?: number;
  /** Why the head is unknown. An unknown head is never treated as current. */
  failed?: string;
}

/** Re-read at most this often. A watcher runs for days and this does move. */
const HEAD_TTL_MS = 15 * 60 * 1000;
let headCache: { at: number; value: IndexHead } | undefined;

/**
 * When the trade index stops.
 *
 * This exists because an empty position list has two completely different
 * meanings and the store reports them identically. Asked for the winning side
 * of a market that settled after the last block this subgraph processed, it
 * answers `[]` with HTTP 200 and no error, exactly as it would for a market
 * nobody traded. Measured on 2026-08-09 the head was 2026-01-05, 215 days back,
 * and 25 of 38 contested markets in a 600 market scan closed after it. Every
 * one of them was being reported as a market with no winning positions.
 *
 * So the head travels with any reading built on trades, and a caller that finds
 * nothing past it says "not covered" rather than "nobody was there". That
 * distinction is the whole reason this project exists.
 *
 * Unfiltered and sorted on an indexed column, which is the one shape this store
 * answers quickly: the same query with a `where` clause on the market times out
 * every time. `_meta` rides along in the same request and costs nothing.
 */
export async function fetchIndexHead(opts: { timeoutMs?: number } = {}): Promise<IndexHead> {
  const now = Date.now();
  if (headCache && now - headCache.at < HEAD_TTL_MS) return headCache.value;

  const gql = '{ _meta { block { number } } '
    + 'enrichedOrderFilleds(orderBy: timestamp, orderDirection: desc, first: 1) { timestamp } }';

  let value: IndexHead;
  try {
    const data = await query<{
      _meta?: { block?: { number?: number } };
      enrichedOrderFilleds?: { timestamp?: string }[];
    }>(JSON.stringify({ query: gql }), opts.timeoutMs ?? 15_000);

    const seconds = Number(data.enrichedOrderFilleds?.[0]?.timestamp);
    value = {
      // Checked before coercing, because `Number(null)` is 0 and a head of zero
      // would mark every market ever as beyond the index.
      lastTradeAt: Number.isFinite(seconds) && seconds > 0
        ? new Date(seconds * 1000).toISOString()
        : undefined,
      block: data._meta?.block?.number,
    };
  } catch (err) {
    value = { failed: redactMessage((err as Error).message ?? String(err)).slice(0, 160) };
  }

  headCache = { at: now, value };
  return value;
}

/** A position held by one wallet, before it is joined to a market. */
export interface WalletPosition extends TokenPosition {
  /** The outcome token. Parsed from the position id, not from a join. */
  tokenId: string;
}

/**
 * Everything one wallet bought, largest surviving position first.
 *
 * The token id is parsed out of the position id rather than read from the
 * `market` relation. That relation is declared non-null in the schema and is
 * dangling for a small number of positions, so traversing it fails the whole
 * query with "Null value resolved for non-null field". The id is the wallet
 * address followed by the decimal token id, so slicing it is both cheaper and
 * more reliable than the join it replaces.
 */
export async function fetchWalletPositions(
  address: string,
  opts: { limit?: number; floor?: number; timeoutMs?: number } = {},
): Promise<{ positions: WalletPosition[]; floor: number; truncated: boolean; failed?: string }> {
  const { limit = 60, timeoutMs = 25_000 } = opts;

  const who = safeAddress(address);
  if (!who) return { positions: [], floor: 0, truncated: false, failed: 'malformed address' };

  const ladder = opts.floor === undefined ? [1, 100, 1_000] : [opts.floor];
  let lastError = 'subgraph did not answer';

  for (const floor of ladder) {
    const units = (BigInt(Math.max(0, Math.floor(floor))) * BigInt(UNIT)).toString();
    const gql = `{ marketPositions(where: {user: "${who}", netQuantity_gt: "${units}"}, orderBy: netQuantity, orderDirection: desc, first: ${Math.min(Math.max(1, Math.floor(limit)), 200)}) { id quantityBought quantitySold netQuantity valueBought netValue } }`;

    try {
      const data = await query<{ marketPositions?: (RawPosition & { id?: string })[] }>(
        JSON.stringify({ query: gql }),
        timeoutMs,
      );
      const rows = data.marketPositions ?? [];
      const positions: WalletPosition[] = [];

      for (const raw of rows) {
        const base = toPosition({ ...raw, user: { id: who } });
        // The id is `0x` + 40 hex + the decimal token id, so the token starts
        // at 42. Anything that does not parse as a token id is dropped rather
        // than carried into a query.
        const tokenId = safeTokenId(raw.id?.slice(42));
        if (base && tokenId) positions.push({ ...base, tokenId });
      }

      return { positions, floor, truncated: rows.length >= limit };
    } catch (err) {
      lastError = redactMessage((err as Error).message ?? String(err));
      if (!/timeout|timed out|statement/i.test(lastError)) break;
    }
  }

  return { positions: [], floor: 0, truncated: false, failed: lastError.slice(0, 160) };
}

/** How a condition paid out, straight from the chain rather than from prices. */
export interface Payout {
  conditionId: string;
  /** Numerators, index aligned with outcomes. Undefined until it resolves. */
  numerators?: number[];
  denominator?: number;
  resolvedAt?: number;
}

/**
 * Map outcome tokens back to their conditions, with the payout.
 *
 * `Condition.payouts` is the on-chain resolution, which beats reading it off
 * prices: it survives a market being delisted and it represents a split
 * resolution honestly, as numerators over a denominator, rather than as two
 * prices that both look like losses.
 *
 * Queried as an entity list rather than through the position's `market` field
 * so that a token with no MarketData is simply absent from the result instead
 * of failing the request.
 */
export async function fetchTokenPayouts(
  tokenIds: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ byToken: Map<string, Payout>; asked: number; found: number; failed?: string }> {
  const clean = [...new Set(tokenIds.map((t) => safeTokenId(t)).filter((t): t is string => !!t))];
  const byToken = new Map<string, Payout>();
  if (clean.length === 0) return { byToken, asked: 0, found: 0 };

  const gql = `{ marketDatas(where: {id_in: [${clean.map((t) => `"${t}"`).join(',')}]}, first: ${Math.min(clean.length, 1000)}) { id condition { id payoutNumerators payoutDenominator resolutionTimestamp } } }`;

  try {
    const data = await query<{
      marketDatas?: {
        id?: string;
        condition?: {
          id?: string;
          payoutNumerators?: string[] | null;
          payoutDenominator?: string | null;
          resolutionTimestamp?: string | null;
        } | null;
      }[];
    }>(JSON.stringify({ query: gql }), opts.timeoutMs ?? 25_000);

    for (const row of data.marketDatas ?? []) {
      const token = safeTokenId(row.id);
      const conditionId = safeHash(row.condition?.id);
      if (!token || !conditionId) continue;

      const nums = row.condition?.payoutNumerators;
      const den = row.condition?.payoutDenominator;

      byToken.set(token, {
        conditionId,
        // Present only when it actually resolved. An unresolved condition has
        // no payout, and coercing that to zero would report every open
        // position as a loss.
        numerators: Array.isArray(nums) && nums.length > 0 ? nums.map((n) => Number(n)) : undefined,
        denominator: den ? Number(den) : undefined,
        resolvedAt: row.condition?.resolutionTimestamp
          ? Number(row.condition.resolutionTimestamp)
          : undefined,
      });
    }

    return { byToken, asked: clean.length, found: byToken.size };
  } catch (err) {
    return {
      byToken,
      asked: clean.length,
      found: 0,
      failed: redactMessage((err as Error).message ?? String(err)).slice(0, 160),
    };
  }
}
