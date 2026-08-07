/**
 * Polymarket's Gamma API — the market catalogue and, more usefully, the
 * resolution lifecycle of every market.
 *
 * Public, unauthenticated, and the only place the dispute history is served
 * without touching a chain. `limit` is capped server-side at 100 no matter what
 * you ask for, so anything wider pages.
 */

import { getJson, num, parseEmbeddedJson } from './http.js';
import { normaliseSteps } from '../core/dispute.js';
import type { Market } from '../types.js';

const BASE = 'https://gamma-api.polymarket.com';

/** Gamma silently caps page size here. Asking for more just wastes a round trip. */
const PAGE_SIZE = 100;

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
  closed?: boolean;
  active?: boolean;
  negRisk?: boolean;
  umaResolutionStatuses?: unknown;
  clobTokenIds?: unknown;
  outcomes?: unknown;
  outcomePrices?: unknown;
}

/** Map one raw record onto our shape, tolerating missing fields. */
export function toMarket(raw: RawMarket): Market {
  return {
    conditionId: raw.conditionId ?? '',
    questionId: raw.questionID,
    slug: raw.slug ?? '',
    question: raw.question ?? '(untitled market)',
    volume: num(raw.volumeNum ?? raw.volume),
    liquidity: num(raw.liquidityNum ?? raw.liquidity),
    resolvedBy: raw.resolvedBy,
    umaBond: num(raw.umaBond, 0) || undefined,
    umaReward: num(raw.umaReward, 0) || undefined,
    resolutionSource: raw.resolutionSource || undefined,
    endDate: raw.endDate,
    umaEndDate: raw.umaEndDate,
    closed: raw.closed === true,
    active: raw.active !== false,
    negRisk: raw.negRisk === true,
    resolutionSteps: normaliseSteps(parseEmbeddedJson<unknown[]>(raw.umaResolutionStatuses, [])),
    tokenIds: parseEmbeddedJson<string[]>(raw.clobTokenIds, []),
    outcomes: parseEmbeddedJson<string[]>(raw.outcomes, []),
    outcomePrices: parseEmbeddedJson<string[]>(raw.outcomePrices, []).map((p) => num(p)),
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

  const out: Market[] = [];

  for (let offset = 0; out.length < limit; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      limit: String(Math.min(PAGE_SIZE, limit - out.length)),
      offset: String(offset),
      order,
      ascending: String(ascending),
    });
    if (closed !== undefined) params.set('closed', String(closed));
    if (active !== undefined) params.set('active', String(active));

    const page = await getJson<RawMarket[]>(`${BASE}/markets?${params}`);
    if (!Array.isArray(page) || page.length === 0) break;

    out.push(...page.map(toMarket));

    // Short page means we reached the end of the result set.
    if (page.length < PAGE_SIZE) break;
  }

  return out.slice(0, limit);
}

/**
 * Does this record actually answer the question we asked?
 *
 * Gamma ignores query params it does not recognise and returns its default
 * page instead of an error — ask for `?conditionId=0x655e…` and you get twenty
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
 * know which state a market is in — that is the thing they are asking about.
 */
export async function fetchMarket(idOrSlug: string): Promise<Market | undefined> {
  const key = /^0x[0-9a-fA-F]{64}$/.test(idOrSlug)
    ? `condition_ids=${idOrSlug}`
    : `slug=${encodeURIComponent(idOrSlug)}`;

  for (const closed of [false, true]) {
    try {
      const res = await getJson<RawMarket[]>(`${BASE}/markets?${key}&closed=${closed}`);
      if (!Array.isArray(res)) continue;

      const hit = res.map(toMarket).find((m) => matchesRequest(m, idOrSlug));
      if (hit) return hit;
    } catch {
      // Try the other closed state rather than failing the whole command.
    }
  }

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
  const [open, closed] = await Promise.all([
    fetchMarkets({ closed: false, limit: Math.floor(scan / 2) }),
    fetchMarkets({ closed: true, limit: Math.ceil(scan / 2) }),
  ]);

  const all = [...open, ...closed];
  const markets = all.filter((m) => m.resolutionSteps.includes('disputed'));

  return { markets, scanned: all.length };
}
