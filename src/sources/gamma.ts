/**
 * Polymarket's Gamma API: the market catalogue and, more usefully, the
 * resolution lifecycle of every market.
 *
 * Public, unauthenticated, and the only place the dispute history is served
 * without touching a chain. `limit` is capped server-side at 100 no matter what
 * you ask for, so anything wider pages.
 */

import { getJson, num, numOrUndefined, parseEmbeddedJson } from './http.js';
import { normaliseSteps } from '../core/dispute.js';
import { safeAddress, safeHash, safeText, safeTokenId } from '../core/safe.js';
import type { Market } from '../types.js';

const BASE = 'https://gamma-api.polymarket.com';

/** Gamma silently caps page size here. Asking for more just wastes a round trip. */
const PAGE_SIZE = 100;

/** No embedded market field should make downstream work unbounded. */
const MAX_EMBEDDED_ITEMS = 1_000;
const MAX_EMBEDDED_TEXT = 256 * 1024;

function newest(a: Market, b: Market): Market {
  const aTime = Date.parse(a.updatedAt ?? '');
  const bTime = Date.parse(b.updatedAt ?? '');
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime >= aTime ? b : a;
  return Number.isFinite(bTime) ? b : a;
}

/** One current record per condition, preferring the newest dated copy. */
export function distinctMarkets(markets: Market[]): Market[] {
  const distinct = new Map<string, Market>();
  for (const market of markets) {
    if (!market.conditionId) continue;
    const existing = distinct.get(market.conditionId);
    distinct.set(market.conditionId, existing ? newest(existing, market) : market);
  }
  return [...distinct.values()];
}

/** Raw shape, loosely typed because Gamma adds fields without warning. */
interface RawMarket {
  conditionId?: string;
  questionID?: string;
  slug?: string;
  question?: string;
  volumeNum?: unknown;
  volume?: unknown;
  liquidityNum?: unknown;
  liquidity?: unknown;
  resolvedBy?: string;
  umaBond?: unknown;
  umaReward?: unknown;
  resolutionSource?: string;
  endDate?: string;
  umaEndDate?: string;
  updatedAt?: string;
  closedTime?: string;
  closed?: boolean;
  active?: boolean;
  negRisk?: boolean;
  umaResolutionStatuses?: unknown;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
}

/**
 * Map one raw record onto our shape, tolerating missing fields.
 *
 * Every string that came off the wire goes through `safeText` here, on the way
 * in. Market questions and resolution sources are free text that ends up on a
 * terminal, and a question containing an escape sequence would let whoever
 * wrote it redraw the table it appears in. Sanitising at ingest also means the
 * --json output is clean, which a render-time filter would not achieve.
 */
export function toMarket(raw: RawMarket): Market {
  const embeddedArray = (value: unknown): unknown[] => {
    if (typeof value === 'string' && value.length > MAX_EMBEDDED_TEXT) return [];
    const decoded = parseEmbeddedJson<unknown>(value, []);
    return Array.isArray(decoded) ? decoded.slice(0, MAX_EMBEDDED_ITEMS) : [];
  };
  const nonnegative = (value: unknown): number => {
    const parsed = num(value);
    return parsed >= 0 && parsed <= Number.MAX_SAFE_INTEGER ? parsed : 0;
  };
  const positive = (value: unknown): number | undefined => {
    const parsed = numOrUndefined(value);
    return parsed !== undefined && parsed > 0 && parsed <= Number.MAX_SAFE_INTEGER
      ? parsed
      : undefined;
  };
  const price = (value: unknown): number | undefined => {
    const parsed = numOrUndefined(value);
    return parsed !== undefined && parsed >= 0 && parsed <= 1 ? parsed : undefined;
  };

  return {
    conditionId: safeHash(raw.conditionId) ?? '',
    questionId: safeHash(raw.questionID),
    slug: safeText(raw.slug, 120),
    question: safeText(raw.question) || '(untitled market)',
    volume: nonnegative(raw.volumeNum ?? raw.volume),
    liquidity: nonnegative(raw.liquidityNum ?? raw.liquidity),
    resolvedBy: safeAddress(raw.resolvedBy),
    umaBond: positive(raw.umaBond),
    umaReward: positive(raw.umaReward),
    resolutionSource: safeText(raw.resolutionSource) || undefined,
    endDate: safeText(raw.endDate, 40) || undefined,
    umaEndDate: safeText(raw.umaEndDate, 40) || undefined,
    updatedAt: safeText(raw.updatedAt, 40) || undefined,
    // Gamma serves this as `2025-07-09 00:30:39+00`, a space instead of the T
    // and no milliseconds. Date parses it, but it is not ISO and nothing here
    // should assume it is.
    closedTime: safeText(raw.closedTime, 40) || undefined,
    closed: raw.closed === true,
    active: raw.active !== false,
    negRisk: raw.negRisk === true,
    resolutionSteps: normaliseSteps(embeddedArray(raw.umaResolutionStatuses)),
    // Token ids are interpolated into a GraphQL query downstream, so a value
    // that is not a plain decimal integer is dropped rather than carried.
    // Invalid entries stay in place as undefined. Filtering them would shift the
    // next token onto the wrong outcome, which is worse than losing the field.
    tokenIds: embeddedArray(raw.clobTokenIds).map((t) => safeTokenId(t)),
    outcomes: embeddedArray(raw.outcomes).map((o) => safeText(o, 60)),
    outcomePrices: embeddedArray(raw.outcomePrices).map(price),
  };
}

export interface MarketQuery {
  closed?: boolean;
  active?: boolean;
  /** How many markets to walk in total, across pages. */
  limit?: number;
  order?: 'volumeNum' | 'liquidityNum' | 'endDate';
  ascending?: boolean;
}

/** Page through Gamma and return markets in the requested order. */
export async function fetchMarkets(query: MarketQuery = {}): Promise<Market[]> {
  const { closed, active, limit = 500, order = 'volumeNum', ascending = false } = query;
  const requested = Number.isFinite(limit)
    ? Math.min(5_000, Math.max(0, Math.floor(limit)))
    : 500;

  const out: Market[] = [];
  const indexByCondition = new Map<string, number>();
  let examined = 0;

  for (let offset = 0; examined < requested;) {
    const pageSize = Math.min(PAGE_SIZE, requested - examined);
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
      order,
      ascending: String(ascending),
    });
    if (closed !== undefined) params.set('closed', String(closed));
    if (active !== undefined) params.set('active', String(active));

    const page = await getJson<RawMarket[]>(`${BASE}/markets?${params}`);
    if (!Array.isArray(page)) throw new Error('Gamma returned an invalid market page');
    if (page.length > pageSize) throw new Error('Gamma exceeded the requested market page size');
    if (page.length === 0) break;
    offset += page.length;
    examined += page.length;

    for (const market of page.map(toMarket)) {
      // Every downstream join and deduplication key is the condition id. A row
      // without one cannot be assessed and is omitted rather than becoming an
      // empty key shared by unrelated markets.
      if (!market.conditionId) continue;
      const existingIndex = indexByCondition.get(market.conditionId);
      if (existingIndex === undefined) {
        indexByCondition.set(market.conditionId, out.length);
        out.push(market);
      } else {
        out[existingIndex] = newest(out[existingIndex]!, market);
      }
    }

    // Short page means we reached the end of the result set.
    if (page.length < pageSize) break;
  }

  return out.slice(0, requested);
}

/**
 * Does this record actually answer the question we asked?
 *
 * Gamma ignores query params it does not recognise and returns its default
 * page instead of an error. Ask for `?conditionId=0x655e…` and you get twenty
 * unrelated markets, the first of which looks like a perfectly good answer.
 * Nothing in the response says the filter was dropped.
 *
 * So every lookup is checked against what was requested. A tool built to catch
 * plausible-looking wrong answers does not get to trust one.
 */
export function matchesRequest(market: Market, idOrSlug: string): boolean {
  const wanted = idOrSlug.toLowerCase();
  return market.conditionId.toLowerCase() === wanted || market.slug.toLowerCase() === wanted;
}

/**
 * Look up one market by condition id or slug.
 *
 * Gamma defaults to open markets, so a settled one is invisible unless
 * `closed=true` is set. Both are tried because the caller has no reason to
 * know which state a market is in. That is the thing they are asking about.
 */
export async function fetchMarket(idOrSlug: string): Promise<Market | undefined> {
  const key = /^0x[0-9a-fA-F]{64}$/.test(idOrSlug)
    ? `condition_ids=${idOrSlug}`
    : `slug=${encodeURIComponent(idOrSlug)}`;

  let answered = 0;
  let lastError: Error | undefined;

  for (const closed of [false, true]) {
    try {
      const res = await getJson<RawMarket[]>(`${BASE}/markets?${key}&closed=${closed}`);
      if (!Array.isArray(res)) throw new Error('Gamma returned an invalid market lookup');
      answered += 1;

      const hit = res.map(toMarket).find((m) => matchesRequest(m, idOrSlug));
      if (hit) return hit;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Try the other closed state rather than failing the whole command.
    }
  }

  // A verified miss requires both halves of the catalogue. If one half could
  // not be read, returning undefined would turn an outage into "not found".
  if (answered < 2 && lastError) throw new Error(`market lookup incomplete: ${lastError.message}`);
  return undefined;
}

/**
 * Markets that have been contested at least once.
 *
 * Gamma has no "disputed" filter, so this walks recent markets and keeps the
 * ones whose lifecycle contains a dispute. Callers are told how many were
 * examined so the result never reads as exhaustive when it is a sample.
 */
export async function fetchContestedMarkets(
  scan = 600,
): Promise<{ markets: Market[]; scanned: number }> {
  const { markets, scanned } = await fetchBothStates(scan);
  return { markets: markets.filter((m) => m.resolutionSteps.includes('disputed')), scanned };
}

/**
 * Walk both closed states, because Gamma defaults to open markets.
 *
 * A settled market is invisible without `closed=true`, and the resolution
 * lifecycle only exists on markets that reached the oracle, which are mostly
 * settled. Anything scanning for lifecycle state has to ask for both halves or
 * it is reading a sample it has quietly biased.
 */
export async function fetchBothStates(
  scan = 600,
): Promise<{ markets: Market[]; scanned: number }> {
  const [open, closed] = await Promise.all([
    fetchMarkets({ closed: false, limit: Math.floor(scan / 2) }),
    fetchMarkets({ closed: true, limit: Math.ceil(scan / 2) }),
  ]);

  const markets = distinctMarkets([...open, ...closed]);
  return { markets, scanned: markets.length };
}

/**
 * Fetch many markets by condition id in one request.
 *
 * Gamma accepts `condition_ids` repeated, and returns every match: 26 asked and
 * 26 returned when this was measured. That turns a wallet lookup from one
 * request per market into one request per hundred, which is the difference
 * between a usable command and a rude one.
 *
 * Both closed states are walked for the same reason `fetchMarket` walks them:
 * Gamma defaults to open markets, and a wallet's history is mostly settled.
 * Every record is still checked against what was asked for, because Gamma
 * answers a filter it does not recognise with its default page.
 */
export async function fetchMarketsByCondition(
  conditionIds: string[],
): Promise<{ markets: Map<string, Market>; asked: number; missing: string[]; failed: number }> {
  const wanted = [...new Set(conditionIds.map((id) => id.toLowerCase()))].filter((id) =>
    /^0x[0-9a-f]{64}$/.test(id),
  );
  const markets = new Map<string, Market>();
  if (wanted.length === 0) return { markets, asked: 0, missing: [], failed: 0 };

  let failed = 0;

  for (let i = 0; i < wanted.length; i += PAGE_SIZE) {
    const batch = wanted.slice(i, i + PAGE_SIZE);
    const key = batch.map((id) => `condition_ids=${id}`).join('&');

    for (const closed of [true, false]) {
      // Everything found on the first pass is skipped on the second.
      if (batch.every((id) => markets.has(id))) break;

      try {
        const page = await getJson<RawMarket[]>(
          `${BASE}/markets?${key}&closed=${closed}&limit=${PAGE_SIZE}`,
        );
        if (!Array.isArray(page)) throw new Error('Gamma returned an invalid batch lookup');
        if (page.length > PAGE_SIZE) throw new Error('Gamma exceeded the requested batch size');

        for (const market of page.map(toMarket)) {
          // Verified against the request, never trusted because it came back.
          if (market.conditionId && batch.includes(market.conditionId)) {
            const existing = markets.get(market.conditionId);
            markets.set(market.conditionId, existing ? newest(existing, market) : market);
          }
        }
      } catch {
        failed += 1;
        // Try the other closed state rather than failing every market at once.
      }
    }
  }

  return {
    markets,
    asked: wanted.length,
    missing: wanted.filter((id) => !markets.has(id)),
    failed,
  };
}
