/**
 * The event log, read back as a whole rather than as a tail.
 *
 * Pure. `events.jsonl` is append only and is the one artefact here that
 * compounds: every other number this tool prints can be recomputed from public
 * endpoints on demand, and this one cannot, because nobody else is keeping it.
 * A market's dispute history is public today and the record of when you saw it
 * move is not.
 *
 * So this exists to make that pile visible. A log nobody can look at is a log
 * nobody keeps running, and the daemon only accumulates while someone leaves it
 * on. What it reports is deliberately plain: how much is in there, over what
 * span, what kinds of thing happened, and which markets moved most often.
 *
 * It does not tally addresses. The event record carries concentration but not
 * holder identities, so an actor ledger is not derivable from this file, and
 * writing one that looked like it was would be inventing a source.
 */

import type { EventKind, WatchEvent } from './watch.js';

export interface MarketTally {
  conditionId: string;
  slug: string;
  question: string;
  /** Events recorded against this market. */
  events: number;
  /** Dispute rounds as of the most recent event. */
  rounds: number;
  /** The most recent event, and when. */
  lastKind: EventKind;
  lastAt: string;
  pool: number;
}

export interface LedgerSummary {
  /** Events read. */
  events: number;
  /** Lines that would not parse, from a process killed mid-append. */
  skipped: number;
  /** Distinct markets the log has ever recorded. */
  markets: number;
  /** Oldest and newest event timestamps, when there are any. */
  first?: string;
  last?: string;
  /** How many of each kind. Every kind that occurred, none that did not. */
  byKind: Partial<Record<EventKind, number>>;
  /** Markets by how many times they moved, most first. */
  busiest: MarketTally[];
  /** Markets whose most recent event was not a settlement. */
  unfinished: MarketTally[];
}

/** Kinds that mean a market's record stopped moving. */
const SETTLED = new Set<EventKind>(['resolved', 'settled']);

export function summarise(
  events: WatchEvent[],
  skipped: number,
  limit = 10,
): LedgerSummary {
  const byKind: Partial<Record<EventKind, number>> = {};
  const tallies = new Map<string, MarketTally>();

  let first: string | undefined;
  let last: string | undefined;

  for (const e of events) {
    byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

    // The log is append only, so it arrives in order, but it is also hand
    // editable and concatenable. Comparing rather than taking the ends means a
    // spliced file cannot produce a span that runs backwards.
    if (e.at) {
      if (first === undefined || e.at < first) first = e.at;
      if (last === undefined || e.at > last) last = e.at;
    }

    const key = e.conditionId;
    if (!key) continue;

    const existing = tallies.get(key);
    if (!existing) {
      tallies.set(key, {
        conditionId: key,
        slug: e.slug,
        question: e.question,
        events: 1,
        rounds: e.rounds,
        lastKind: e.kind,
        lastAt: e.at,
        pool: e.pool,
      });
      continue;
    }

    existing.events += 1;
    // Latest wins, by timestamp rather than by position, for the same reason.
    if (!existing.lastAt || e.at >= existing.lastAt) {
      existing.lastKind = e.kind;
      existing.lastAt = e.at;
      existing.rounds = e.rounds;
      existing.question = e.question;
      existing.pool = e.pool;
    }
  }

  const all = [...tallies.values()];

  return {
    events: events.length,
    skipped,
    markets: all.length,
    first,
    last,
    byKind,
    busiest: [...all]
      .sort((a, b) => b.events - a.events || b.pool - a.pool)
      .slice(0, limit),
    unfinished: all
      .filter((m) => !SETTLED.has(m.lastKind))
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
      .slice(0, limit),
  };
}

/**
 * How long the log has been running, in days.
 *
 * Returned as a number rather than a sentence so the caller decides how to say
 * it, and undefined when the log is empty, because zero days of history and no
 * history are different claims.
 */
export function span(summary: LedgerSummary): number | undefined {
  if (!summary.first || !summary.last) return undefined;
  const ms = new Date(summary.last).getTime() - new Date(summary.first).getTime();
  return Number.isFinite(ms) ? ms / 86_400_000 : undefined;
}
