/**
 * Polymarket's data API: who holds what, by wallet, with the display names
 * those accounts chose for themselves.
 *
 * Public and unauthenticated. This is the position half of the join, and on a
 * contested market it is the more interesting half: after a disputed
 * resolution the winning side holds tens of millions of tokens and the losing
 * side holds a few hundred, because the losers went to zero.
 */

import { getJson, numOrUndefined } from './http.js';
import { safeAddress, safeHash, safeText, safeTokenId } from '../core/safe.js';
import { sideForIndex } from '../core/capture.js';
import type { Holder, Market } from '../types.js';

const BASE = 'https://data-api.polymarket.com';

/**
 * The two name fields, which arrive on more than one endpoint in this API.
 * Holders carry them and so do activity records, which is what makes a
 * redeemed winner nameable at all.
 */
interface Named {
  name?: string;
  pseudonym?: string;
}

interface RawHolder extends Named {
  proxyWallet?: string;
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
 *
 * This is the single most hostile field the tool reads. It is chosen freely by
 * the account, and the tool prints it in a table making claims about that same
 * account. Left raw, a wallet could set a name containing a screen clear and
 * forge every row above its own. `safeText` strips anything the terminal would
 * act on, and the length cap keeps one row from pushing the rest off screen.
 */
export function displayName(raw: Named): string | undefined {
  const candidate = safeText(raw.name, 40) || safeText(raw.pseudonym, 40);
  if (!candidate) return undefined;
  if (/^0x[0-9a-fA-F]{40}-\d+$/.test(candidate)) return undefined;
  return candidate;
}

/**
 * Top holders of a market, both sides, largest first.
 *
 * `limit` is per outcome token, not overall. The API groups by token and this
 * keeps that meaning rather than quietly reinterpreting it.
 */
export async function fetchHolders(market: Market, limit = 100): Promise<Holder[]> {
  // Re-checked rather than assumed. This value is interpolated into a URL, and
  // the guarantee that it is a 32 byte hash belongs next to the interpolation,
  // not three modules away in whatever produced the Market.
  const condition = safeHash(market.conditionId);
  if (!condition) return [];

  const size = Number.isFinite(limit)
    ? Math.min(Math.max(1, Math.floor(limit)), 500)
    : 100;
  const url = `${BASE}/holders?market=${condition}&limit=${size}`;
  const groups = await getJson<RawHolderGroup[]>(url);
  if (!Array.isArray(groups)) throw new Error('holders endpoint returned an invalid response');

  const out: Holder[] = [];
  const expectedTokens = new Set(market.tokenIds.filter((token): token is string => token !== undefined));
  const seenTokens = new Set<string>();

  for (const group of groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      throw new Error('holders endpoint returned an invalid group');
    }
    if (group.holders !== undefined && !Array.isArray(group.holders)) {
      throw new Error('holders endpoint returned an invalid holder list');
    }
    const token = safeTokenId(group.token);
    if (!token || (expectedTokens.size > 0 && !expectedTokens.has(token))) {
      throw new Error('holders endpoint returned a token outside the requested market');
    }
    if (seenTokens.has(token)) throw new Error('holders endpoint returned a duplicate token group');
    seenTokens.add(token);
    const tokenIndex = market.tokenIds.indexOf(token);

    for (const raw of group.holders ?? []) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const address = safeAddress(raw.proxyWallet);
      if (!address) continue;

      // Dropped rather than defaulted to 0. An absent index coerced with a
      // fallback puts every holder on outcome 0, which reads as a full table of
      // confident answers with everyone on the same side. The endpoint returns
      // this field on every record today, so this is a guard against it
      // stopping, not a workaround for it being missing.
      const index = numOrUndefined(raw.outcomeIndex);
      if (index === undefined) continue;
      if (tokenIndex >= 0 && index !== tokenIndex) continue;
      const side = sideForIndex(market, index);
      if (side === undefined) continue;

      const amount = numOrUndefined(raw.amount);
      if (amount === undefined || amount <= 0) continue;

      const price = market.outcomePrices[index];

      out.push({
        address,
        name: displayName(raw),
        side,
        size: amount,
        // Missing and zero are different here. A resolved losing side really is
        // worth zero, while an absent price says nothing about its value.
        ...(price === undefined ? {} : { value: amount * price }),
      });
    }
  }

  // A source retry or duplicate group must not double a wallet's weight in the
  // concentration denominator. Merge by the identity the table actually uses.
  const merged = new Map<string, Holder>();
  for (const holder of out) {
    const key = `${holder.address}:${holder.side}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...holder });
      continue;
    }
    existing.size += holder.size;
    existing.value = existing.value === undefined || holder.value === undefined
      ? undefined
      : existing.value + holder.value;
    existing.name ??= holder.name;
  }

  return [...merged.values()].sort((a, b) => b.size - a.size);
}

/**
 * Put names to addresses that hold nothing any more.
 *
 * This exists because of redemption. The winning side of a settled market
 * cashed out, so those wallets are absent from `/holders` and their names
 * cannot come from there. `/activity` keeps a record per trade and carries the
 * same `name` and `pseudonym` fields, so asking for a single row per address
 * recovers the identity that redemption erased from the balance view.
 *
 * One request per address, sequentially. The endpoint takes one `user` and
 * answers a comma separated list with a 400, so there is no batch form to
 * reach for, and this endpoint is free and unmetered: a burst of parallel
 * requests is how a tool gets its users rate limited.
 *
 * Failures are counted and returned, never thrown. A missing name costs a
 * column and a raised error costs the command. The count travels back so the
 * caller can say the list is partly unnamed rather than implying that the
 * unnamed wallets chose to be anonymous.
 */
export async function fetchDisplayNames(
  addresses: string[],
): Promise<{ byAddress: Map<string, string>; asked: number; failed: number }> {
  const clean = [...new Set(addresses.map((a) => safeAddress(a)).filter((a): a is string => !!a))];
  const byAddress = new Map<string, string>();
  let failed = 0;

  for (const address of clean) {
    try {
      const rows = await getJson<Named[]>(`${BASE}/activity?user=${address}&limit=1`);
      // Same treatment as a holder name: chosen by the account, printed next to
      // a claim about that account, so it goes through safeText on the way in.
      const name = Array.isArray(rows) && rows[0] ? displayName(rows[0]) : undefined;
      if (name) byAddress.set(address, name);
    } catch {
      failed += 1;
    }
  }

  return { byAddress, asked: clean.length, failed };
}
