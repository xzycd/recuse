/**
 * Detecting that a resolution moved.
 *
 * Pure. Given what a market looked like last time and what it looks like now,
 * this decides whether anything happened and what to call it. All the I/O lives
 * in `store.ts` and `assess.ts`, so every judgement the daemon makes is testable
 * without a network or a filesystem.
 *
 * Three rules shape it, and all three come from the same place: a watcher that
 * cries wolf gets muted, and a muted watcher is worse than none.
 *
 * A market seen for the first time produces no event. There is no baseline to
 * compare against, and firing on everything the first time it runs is how a tool
 * teaches someone to ignore it. The first pass records and says how many.
 *
 * A lifecycle that changed in any way other than growing is reported as
 * rewritten rather than quietly re-baselined. Gamma editing history under us is
 * itself the news.
 *
 * A market that could not be read produces no event at all. Not-read and
 * nothing-happened are different statements, and the caller reports the first
 * one separately.
 */

import { leadingSide } from './capture.js';
import { parseDispute } from './dispute.js';
import type { Concentration, DisputeState, Market, ResolutionStep } from '../types.js';

/** What a market looked like at the last poll. */
export interface Seen {
  conditionId: string;
  slug: string;
  question: string;
  steps: ResolutionStep[];
  /** Prices had reached an extreme, so an outcome was decided. */
  settled: boolean;
  pool: number;
  /** ISO timestamp of the poll that produced this. */
  at: string;
}

/**
 * What happened.
 *
 * The lifecycle steps double as event kinds, because "the market was disputed"
 * is exactly the step being appended. `settled` is a price change rather than a
 * lifecycle change. `appeared` is a market entering the scan already contested.
 * `rewritten` is the record itself moving.
 */
export type EventKind = 'proposed' | 'disputed' | 'resolved' | 'reset' | 'settled' | 'appeared' | 'rewritten';

export interface WatchEvent {
  at: string;
  kind: EventKind;
  conditionId: string;
  slug: string;
  question: string;
  /** Dispute rounds after this event. */
  rounds: number;
  /** Dispute rounds before it. Equal to `rounds` when the event is not a dispute. */
  previousRounds: number;
  phase: DisputeState['phase'];
  steps: ResolutionStep[];
  pool: number;
  deadline?: string;
  /** Whether this market was named by the user or turned up in a scan. */
  origin: 'watchlist' | 'discovery';
  /**
   * Who held what, attached to the event only, never to a poll. Best effort: an
   * alert that arrives without it beats an alert that does not arrive.
   */
  concentration?: Concentration;
  /** Why `concentration` is missing, when it is. */
  detailFailed?: string;
}

/** Reduce a market to the fields the next comparison needs. */
export function snapshot(market: Market, now = new Date()): Seen {
  return {
    conditionId: market.conditionId,
    slug: market.slug,
    question: market.question,
    steps: [...market.resolutionSteps],
    settled: leadingSide(market)?.settled ?? false,
    pool: market.volume,
    at: now.toISOString(),
  };
}

export type StepChange =
  | { kind: 'unchanged' }
  | { kind: 'appended'; steps: ResolutionStep[] }
  | { kind: 'rewritten' };

/**
 * How a lifecycle changed.
 *
 * Growing at the end is the normal case and the only one that produces per-step
 * events. Anything else means the prefix we were comparing against is no longer
 * there, and re-baselining silently would hide the fact that a settled record
 * moved. That is the one thing this tool exists to notice.
 */
export function compareSteps(before: ResolutionStep[], after: ResolutionStep[]): StepChange {
  const prefixHolds = before.every((step, i) => after[i] === step);

  if (!prefixHolds) return { kind: 'rewritten' };
  if (after.length === before.length) return { kind: 'unchanged' };

  return { kind: 'appended', steps: after.slice(before.length) };
}

/** Steps that are worth waking someone for. `unknown` is noise from Gamma. */
const REPORTABLE = new Set<ResolutionStep>(['proposed', 'disputed', 'resolved', 'reset']);

export interface CompareOptions {
  origin: 'watchlist' | 'discovery';
  /**
   * False on the very first run, when nothing has a baseline and every market
   * would otherwise look like news.
   */
  baselineDone: boolean;
  now?: Date;
}

/**
 * Compare one market against what we last saw of it.
 *
 * Returns the events to report and the snapshot to store. The snapshot is
 * returned even when there are no events, because "we looked and nothing had
 * changed" still moves the clock forward.
 */
export function compare(
  before: Seen | undefined,
  market: Market,
  opts: CompareOptions,
): { events: WatchEvent[]; next: Seen } {
  const now = opts.now ?? new Date();
  const next = snapshot(market, now);
  const dispute = parseDispute(market);

  const base = {
    at: now.toISOString(),
    conditionId: market.conditionId,
    slug: market.slug,
    question: market.question,
    phase: dispute.phase,
    steps: next.steps,
    pool: market.volume,
    deadline: dispute.deadline?.toISOString(),
    origin: opts.origin,
  };

  // Never seen before.
  if (!before) {
    // On the first pass there is nothing to compare against, so this is a
    // baseline and not news. After that, a contested market entering the scan
    // window for the first time is worth one line.
    const worthReporting = opts.baselineDone && next.steps.includes('disputed');
    if (!worthReporting) return { events: [], next };

    return {
      events: [{ ...base, kind: 'appeared', rounds: dispute.rounds, previousRounds: 0 }],
      next,
    };
  }

  const events: WatchEvent[] = [];
  const change = compareSteps(before.steps, next.steps);

  if (change.kind === 'rewritten') {
    events.push({
      ...base,
      kind: 'rewritten',
      rounds: dispute.rounds,
      previousRounds: before.steps.filter((s) => s === 'disputed').length,
    });
  } else if (change.kind === 'appended') {
    // One event per appended step, in order, each carrying the round count as
    // of that step rather than as of the end. Collapsing three steps into one
    // event would lose which of them was the dispute.
    let rounds = before.steps.filter((s) => s === 'disputed').length;

    for (const step of change.steps) {
      const previousRounds = rounds;
      if (step === 'disputed') rounds += 1;
      if (!REPORTABLE.has(step)) continue;

      events.push({ ...base, kind: step as EventKind, rounds, previousRounds });
    }
  }

  // A price change rather than a lifecycle change. Gamma does not always append
  // a `resolved` step when a market lands, so without this a settlement on a
  // market someone is watching can pass in silence.
  // When Gamma supplies both signals in the same poll, `resolved` already says
  // the market settled. Emitting the price fallback too records and delivers
  // the same transition twice. `settled` exists for the feeds that omit the
  // lifecycle step, so keep it only when it is adding that missing fact.
  if (!before.settled && next.settled && !events.some((event) => event.kind === 'resolved')) {
    events.push({
      ...base,
      kind: 'settled',
      rounds: dispute.rounds,
      previousRounds: dispute.rounds,
    });
  }

  return { events, next };
}

/** Does this event clear the bar the user set? */
export function passesFilters(
  event: WatchEvent,
  filters: { minPool?: number; kinds?: Set<EventKind> },
): boolean {
  if (filters.minPool !== undefined && event.pool < filters.minPool) return false;
  if (filters.kinds && !filters.kinds.has(event.kind)) return false;
  return true;
}
