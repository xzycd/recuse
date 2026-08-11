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
  /** Positions at or below this many tokens were not requested. */
  floor: number;
  /** True when the page filled, so there are more positions above the floor. */
  truncated: boolean;
  /** Rows returned by the store that were malformed and therefore omitted. */
  dropped: number;
  /** Set when nothing could be read. Never an empty list presented as a zero. */
  failed?: string;
}

interface RawPosition {
  id?: string;
  user?: { id?: string };
  quantityBought?: string;
  quantitySold?: string;
  netQuantity?: string;
  valueBought?: string;
  valueSold?: string;
  netValue?: string;
}

interface FixedUnits {
  integer: bigint;
  value: number;
}

/** Fixed point to a plain number, without inventing zero for an absent field. */
function fromUnits(value: string | undefined): FixedUnits | undefined {
  if (!value || !/^-?\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? { integer: BigInt(value), value: n / UNIT } : undefined;
}

export function toPosition(raw: RawPosition): TokenPosition | undefined {
  const address = safeAddress(raw.user?.id);
  if (!address) return undefined;

  const bought = fromUnits(raw.quantityBought);
  const sold = fromUnits(raw.quantitySold);
  const net = fromUnits(raw.netQuantity);
  const spent = fromUnits(raw.valueBought);
  const received = fromUnits(raw.valueSold);
  const netSpent = fromUnits(raw.netValue);

  // Every field below changes the financial answer. A missing net cost is not a
  // free position, and a missing net quantity is not a position of zero.
  if (
    bought === undefined || sold === undefined || net === undefined
    || spent === undefined || received === undefined || netSpent === undefined
    || bought.value <= 0 || sold.value < 0 || net.value < 0 || spent.value < 0
    || received.value < 0
    || net.integer !== bought.integer - sold.integer
    || netSpent.integer !== spent.integer - received.integer
  ) return undefined;

  return {
    address,
    bought: bought.value,
    sold: sold.value,
    net: net.value,
    spent: spent.value,
    netSpent: netSpent.value,
  };
}

async function query<T>(body: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new HttpError(`${res.status} ${res.statusText}`, res.status, ENDPOINT);
    }

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
  if (!token) {
    return { positions: [], floor: 0, truncated: false, dropped: 0, failed: 'malformed token id' };
  }

  const requested = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), 100)
    : 20;
  if (opts.floor !== undefined && (!Number.isFinite(opts.floor) || opts.floor < 0)) {
    return { positions: [], floor: 0, truncated: false, dropped: 0, failed: 'invalid position floor' };
  }

  const ladder = opts.floor === undefined ? FLOOR_LADDER : [opts.floor];
  let lastError = 'subgraph did not answer';

  for (const floor of ladder) {
    const effectiveFloor = Math.max(0, Math.floor(floor));
    const units = (BigInt(effectiveFloor) * BigInt(UNIT)).toString();
    // The token id and the floor are both validated numerics by this point, so
    // there is nothing here a caller could inject a clause through.
    const gql = `{ marketPositions(where: {market: "${token}", quantityBought_gt: "${units}"}, orderBy: quantityBought, orderDirection: desc, first: ${requested}) { id user { id } quantityBought quantitySold netQuantity valueBought valueSold netValue } }`;

    try {
      const data = await query<{ marketPositions?: RawPosition[] }>(
        JSON.stringify({ query: gql }),
        timeoutMs,
      );
      if (!Array.isArray(data.marketPositions)) throw new Error('subgraph returned no position list');
      const rows = data.marketPositions;
      const positions = rows.map((raw) => {
        // A GraphQL `where` clause is still a request, not proof that the
        // response honoured it. The entity id carries both sides of the join:
        // wallet address followed by outcome token. A valid id naming another
        // token means the market filter was ignored, and a prefix disagreeing
        // with `user.id` means the row contradicts itself. Either invalidates
        // the whole response rather than becoming a plausible position.
        const idAddress = safeAddress(raw.id?.slice(0, 42));
        const idToken = safeTokenId(raw.id?.slice(42));
        const user = safeAddress(raw.user?.id);
        if (idToken && idToken !== token) {
          throw new Error('subgraph returned a position outside the requested token');
        }
        if (idAddress && user && idAddress !== user) {
          throw new Error('subgraph returned a contradictory position identity');
        }
        if (!idAddress || !idToken || !user) return undefined;
        return toPosition(raw);
      }).filter((p): p is TokenPosition => p !== undefined);
      const dropped = rows.length - positions.length;
      if (rows.length > 0 && positions.length === 0) {
        throw new Error('subgraph returned no usable positions');
      }
      if (new Set(positions.map((position) => position.address)).size !== positions.length) {
        throw new Error('subgraph returned duplicate positions for one wallet');
      }

      return {
        positions,
        floor: effectiveFloor,
        truncated: rows.length >= requested,
        dropped,
      };
    } catch (err) {
      lastError = redactMessage((err as Error).message ?? String(err));
      // Only a timeout is worth escalating the floor for. Anything else will
      // fail identically at the next rung and just costs the user more waiting.
      if (!/timeout|timed out|statement/i.test(lastError)) break;
    }
  }

  return { positions: [], floor: 0, truncated: false, dropped: 0, failed: lastError.slice(0, 160) };
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
const FAILED_HEAD_TTL_MS = 30 * 1000;
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
  const ttl = headCache?.value.failed ? FAILED_HEAD_TTL_MS : HEAD_TTL_MS;
  if (headCache && now - headCache.at < ttl) return headCache.value;

  const gql = '{ _meta { block { number } } '
    + 'enrichedOrderFilleds(orderBy: timestamp, orderDirection: desc, first: 1) { timestamp } }';

  let value: IndexHead;
  try {
    const data = await query<{
      _meta?: { block?: { number?: number } };
      enrichedOrderFilleds?: { timestamp?: string }[];
    }>(JSON.stringify({ query: gql }), opts.timeoutMs ?? 15_000);

    const rawSeconds = data.enrichedOrderFilleds?.[0]?.timestamp;
    const seconds = typeof rawSeconds === 'string' && /^\d+$/.test(rawSeconds)
      ? Number(rawSeconds)
      : undefined;
    const date = seconds !== undefined && Number.isSafeInteger(seconds) && seconds > 0
      ? new Date(seconds * 1000)
      : undefined;
    if (!date || Number.isNaN(date.getTime())) throw new Error('trade index returned no usable head time');

    const rawBlock = data._meta?.block?.number;
    value = {
      lastTradeAt: date.toISOString(),
      block: Number.isSafeInteger(rawBlock) && (rawBlock ?? -1) >= 0 ? rawBlock : undefined,
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
): Promise<{ positions: WalletPosition[]; floor: number; truncated: boolean; dropped: number; failed?: string }> {
  const { limit = 60, timeoutMs = 25_000 } = opts;

  const who = safeAddress(address);
  if (!who) {
    return { positions: [], floor: 0, truncated: false, dropped: 0, failed: 'malformed address' };
  }

  const requested = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), 200)
    : 60;
  if (opts.floor !== undefined && (!Number.isFinite(opts.floor) || opts.floor < 0)) {
    return { positions: [], floor: 0, truncated: false, dropped: 0, failed: 'invalid position floor' };
  }

  const ladder = opts.floor === undefined ? [1, 100, 1_000] : [opts.floor];
  let lastError = 'subgraph did not answer';

  for (const floor of ladder) {
    const effectiveFloor = Math.max(0, Math.floor(floor));
    const units = (BigInt(effectiveFloor) * BigInt(UNIT)).toString();
    const gql = `{ marketPositions(where: {user: "${who}", netQuantity_gt: "${units}"}, orderBy: netQuantity, orderDirection: desc, first: ${requested}) { id quantityBought quantitySold netQuantity valueBought valueSold netValue } }`;

    try {
      const data = await query<{ marketPositions?: (RawPosition & { id?: string })[] }>(
        JSON.stringify({ query: gql }),
        timeoutMs,
      );
      if (!Array.isArray(data.marketPositions)) throw new Error('subgraph returned no position list');
      const rows = data.marketPositions;
      const positions: WalletPosition[] = [];

      for (const raw of rows) {
        // The id is `0x` + 40 hex + the decimal token id, so the token starts
        // at 42. Anything that does not parse as a token id is dropped rather
        // than carried into a query.
        const rowAddress = safeAddress(raw.id?.slice(0, 42));
        const tokenId = safeTokenId(raw.id?.slice(42));
        // Never manufacture the requested wallet into the row. A valid prefix
        // for someone else proves the user filter was ignored and invalidates
        // the response. A malformed identity is counted with the other dropped
        // rows, since it cannot be joined safely at all.
        if (rowAddress && rowAddress !== who) {
          throw new Error('subgraph returned a position outside the requested wallet');
        }
        const base = rowAddress ? toPosition({ ...raw, user: { id: rowAddress } }) : undefined;
        if (base && tokenId) positions.push({ ...base, tokenId });
      }

      const dropped = rows.length - positions.length;
      if (rows.length > 0 && positions.length === 0) {
        throw new Error('subgraph returned no usable wallet positions');
      }
      if (new Set(positions.map((position) => position.tokenId)).size !== positions.length) {
        throw new Error('subgraph returned duplicate wallet tokens');
      }

      return {
        positions,
        floor: effectiveFloor,
        truncated: rows.length >= requested,
        dropped,
      };
    } catch (err) {
      lastError = redactMessage((err as Error).message ?? String(err));
      if (!/timeout|timed out|statement/i.test(lastError)) break;
    }
  }

  return { positions: [], floor: 0, truncated: false, dropped: 0, failed: lastError.slice(0, 160) };
}

/** How a condition paid out, straight from the chain rather than from prices. */
export interface Payout {
  conditionId: string;
  /** Numerators, index aligned with outcomes. Undefined until it resolves. */
  numerators?: number[];
  denominator?: number;
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
): Promise<{ byToken: Map<string, Payout>; asked: number; found: number; invalid: number; failed?: string }> {
  const clean = [...new Set(tokenIds.map((t) => safeTokenId(t)).filter((t): t is string => !!t))];
  const requested = new Set(clean);
  const byToken = new Map<string, Payout>();
  if (clean.length === 0) return { byToken, asked: 0, found: 0, invalid: 0 };

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

    if (!Array.isArray(data.marketDatas)) throw new Error('subgraph returned no payout list');

    let invalid = 0;
    for (const row of data.marketDatas) {
      const token = safeTokenId(row.id);
      const conditionId = safeHash(row.condition?.id);
      if (!token || !conditionId) {
        invalid += 1;
        continue;
      }
      // Gamma and wallet joins trust this map to describe only the tokens that
      // were asked for. A valid foreign id means the `id_in` filter was ignored,
      // not an extra record that is safe to carry along.
      if (!requested.has(token)) {
        throw new Error('subgraph returned a payout outside the requested tokens');
      }
      if (byToken.has(token)) throw new Error('subgraph returned a duplicate payout token');

      const nums = row.condition?.payoutNumerators;
      const den = row.condition?.payoutDenominator;
      const parsedNums = Array.isArray(nums) && nums.length > 0
        ? nums.map((n) => (/^\d+$/.test(n) ? Number(n) : Number.NaN))
        : undefined;
      const parsedDen = typeof den === 'string' && /^\d+$/.test(den) ? Number(den) : undefined;
      const numeratorTotal = parsedNums?.reduce((sum, n) => sum + n, 0);
      const validPayout = parsedNums?.every((n) => Number.isSafeInteger(n) && n >= 0)
        && Number.isSafeInteger(parsedDen) && (parsedDen ?? 0) > 0
        && parsedNums.every((n) => n <= parsedDen!)
        && Number.isSafeInteger(numeratorTotal) && numeratorTotal === parsedDen;
      const rawResolvedAt = row.condition?.resolutionTimestamp;
      const resolvedAt = typeof rawResolvedAt === 'string' && /^\d+$/.test(rawResolvedAt)
        ? Number(rawResolvedAt)
        : undefined;

      if ((nums !== null && nums !== undefined && !validPayout)
        || (rawResolvedAt !== null && rawResolvedAt !== undefined
          && (!Number.isSafeInteger(resolvedAt) || (resolvedAt ?? 0) <= 0))
        || (Number.isSafeInteger(resolvedAt) && (resolvedAt ?? 0) > 0 && !validPayout)) {
        invalid += 1;
      }

      byToken.set(token, {
        conditionId,
        // Present only when it actually resolved. An unresolved condition has
        // no payout, and coercing that to zero would report every open
        // position as a loss.
        numerators: validPayout ? parsedNums : undefined,
        denominator: validPayout ? parsedDen : undefined,
      });
    }

    return { byToken, asked: clean.length, found: byToken.size, invalid };
  } catch (err) {
    // A response rejected halfway through is not a partial success. Returning
    // the rows visited before the malformed one would put totals over an
    // arbitrary prefix while the result merely says the request failed.
    byToken.clear();
    return {
      byToken,
      asked: clean.length,
      found: 0,
      invalid: 0,
      failed: redactMessage((err as Error).message ?? String(err)).slice(0, 160),
    };
  }
}
