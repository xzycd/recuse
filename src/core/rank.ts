/**
 * Ordering and filtering the radar.
 *
 * Pure, and separate from the view, because a sort order is a claim about what
 * matters. The default puts dispute rounds above money on purpose: a $400M
 * market nobody argued about is less interesting here than a $2M market that
 * went four rounds, and a tool that sorted by volume would just be a list of
 * big markets.
 */

import { disputeWeight } from './dispute.js';
import type { Assessment } from '../types.js';

export const SORTS = ['rounds', 'pool', 'wiped', 'ends'] as const;
export type SortMode = (typeof SORTS)[number];

export const SORT_LABELS: Record<SortMode, string> = {
  rounds: 'most contested',
  pool: 'most money',
  wiped: 'most wiped out',
  ends: 'soonest deadline',
};

/** Next sort in the cycle, so one key can walk all of them. */
export function nextSort(mode: SortMode): SortMode {
  return SORTS[(SORTS.indexOf(mode) + 1) % SORTS.length]!;
}

function wipedSize(a: Assessment): number {
  const c = a.concentration;
  return c && c.meaning === 'wiped' ? c.totalSize : 0;
}

/** Sort a copy. The caller's array is never reordered underneath it. */
export function sortAssessments(list: Assessment[], mode: SortMode): Assessment[] {
  const out = [...list];

  switch (mode) {
    case 'pool':
      return out.sort((a, b) => b.pool - a.pool);
    case 'wiped':
      return out.sort((a, b) => wipedSize(b) - wipedSize(a) || b.pool - a.pool);
    case 'ends':
      // Markets with no clock sink to the bottom rather than sorting as if
      // their deadline were the epoch.
      return out.sort((a, b) => {
        const at = a.dispute.deadline?.getTime();
        const bt = b.dispute.deadline?.getTime();
        if (at === undefined && bt === undefined) return b.pool - a.pool;
        if (at === undefined) return 1;
        if (bt === undefined) return -1;
        return at - bt;
      });
    default:
      return out.sort(
        (a, b) => disputeWeight(b.dispute, b.pool) - disputeWeight(a.dispute, a.pool),
      );
  }
}

/**
 * Filter by a typed query.
 *
 * Matches the question and the slug, case insensitively, on every whitespace
 * separated term. Multiple terms all have to match, because narrowing is what
 * someone typing a second word is trying to do.
 */
export function filterAssessments(list: Assessment[], query: string): Assessment[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return list;

  return list.filter((a) => {
    const haystack = `${a.market.question} ${a.market.slug}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Which slice of a list is on screen, and where the cursor sits inside it.
 *
 * The cursor is kept off the very edge where possible, so there is always a
 * row of context in the direction of travel. Without this the selection sticks
 * to the top or bottom line and scrolling feels like it is fighting you.
 */
export function viewport(
  total: number,
  cursor: number,
  height: number,
  margin = 2,
): { start: number; end: number } {
  if (height >= total) return { start: 0, end: total };

  const safe = Math.max(0, Math.min(cursor, total - 1));
  const pad = Math.min(margin, Math.floor((height - 1) / 2));

  let start = safe - pad;
  if (start < 0) start = 0;
  if (start + height > total) start = total - height;
  if (start < 0) start = 0;

  return { start, end: start + height };
}
