/**
 * Polymarket's data API: who holds what, by wallet, with the display names
 * those accounts chose for themselves.
 *
 * Public and unauthenticated. This is the position half of the join, and on a
 * contested market it is the more interesting half: after a disputed
 * resolution the winning side holds tens of millions of tokens and the losing
 * side holds a few hundred, because the losers went to zero.
 */

import { getJson, num } from './http.js';
import type { Holder, Market, Side } from '../types.js';

const BASE = 'https://data-api.polymarket.com';

interface RawHolder {
  proxyWallet?: string;
  name?: string;
  pseudonym?: string;
  amount?: unknown;
  outcomeIndex?: unknown;
}

interface RawHolderGroup {
  token?: string;
  holders?: RawHolder[];
}

/**
 * Accounts show up with a chosen name, a generated pseudonym, or neither.
 *
 * The generated fallback looks like `0xAbC…-1730864521381`, an address with a
 * timestamp glued on. That is not a name, it is the absence of one, so it is
 * dropped rather than displayed as if the account had identified itself.
 */
export function displayName(raw: RawHolder): string | undefined {
  const candidate = raw.name?.trim() || raw.pseudonym?.trim();
  if (!candidate) return undefined;
  if (/^0x[0-9a-fA-F]{40}-\d+$/.test(candidate)) return undefined;
  return candidate;
}

/** Map an outcome index onto a side, using the market's own labels. */
export function sideForIndex(market: Market, index: number): Side {
  const label = market.outcomes[index]?.toLowerCase();
  if (label === 'yes') return 'YES';
  if (label === 'no') return 'NO';
  // Non-binary or unlabelled markets: index 0 is the affirmative by convention.
  return index === 0 ? 'YES' : 'NO';
}

/**
 * Top holders of a market, both sides, largest first.
 *
 * `limit` is per outcome token, not overall. The API groups by token and this
 * keeps that meaning rather than quietly reinterpreting it.
 */
export async function fetchHolders(market: Market, limit = 100): Promise<Holder[]> {
  if (!market.conditionId) return [];

  const url = `${BASE}/holders?market=${market.conditionId}&limit=${limit}`;
  const groups = await getJson<RawHolderGroup[]>(url);
  if (!Array.isArray(groups)) return [];

  const out: Holder[] = [];

  for (const group of groups) {
    for (const raw of group.holders ?? []) {
      const address = raw.proxyWallet?.toLowerCase();
      if (!address) continue;

      const index = num(raw.outcomeIndex, 0);
      const size = num(raw.amount);
      if (size <= 0) continue;

      const price = market.outcomePrices[index] ?? 0;

      out.push({
        address,
        name: displayName(raw),
        side: sideForIndex(market, index),
        size,
        // A resolved market prices the losing side at zero, which is correct:
        // that position really is worth nothing now.
        value: size * price,
      });
    }
  }

  return out.sort((a, b) => b.size - a.size);
}

/** Fetch holders for several markets, politely, keeping failures visible. */
export async function fetchHoldersForMarkets(
  markets: Market[],
  limit = 100,
): Promise<{ byCondition: Map<string, Holder[]>; failed: string[] }> {
  const byCondition = new Map<string, Holder[]>();
  const failed: string[] = [];

  // Sequential on purpose. This endpoint is free and unmetered; hammering it
  // in parallel is how a tool gets its users rate limited.
  for (const market of markets) {
    try {
      byCondition.set(market.conditionId, await fetchHolders(market, limit));
    } catch {
      failed.push(market.conditionId);
    }
  }

  return { byCondition, failed };
}
