/**
 * What is sitting in the oracle right now, and for how long.
 *
 * Pure. The radar ranks by how contested a market was, which is history and
 * does not change. This ranks by what has not finished, which is the only part
 * of this dataset that moves on its own.
 *
 * The measurement that produced this view: across 800 markets, 517 had no
 * lifecycle at all, 175 ended on `resolved`, 70 were still sitting on
 * `proposed` and 36 on `disputed`. So roughly one market in eight that reached
 * the oracle has a lifecycle that never terminated. Some of those are genuinely
 * unfinished and some are Gamma failing to append the `resolved` step, which is
 * itself worth seeing: the watcher already treats a lifecycle changing under us
 * as news, and a lifecycle that stopped short is the quieter version of that.
 *
 * What this deliberately does not do is claim a market is stuck. It reports the
 * last recorded step and how long it has been since the clock that market set
 * for itself. A feed that lags is indistinguishable from an oracle that is
 * slow, from here, and pretending otherwise would be inventing a finding.
 */

import { parseDispute, parseMarketDate } from './dispute.js';
import type { DisputeState, Market, ResolutionStep } from '../types.js';

/** Steps that mean the lifecycle finished. Everything else is still in flight. */
const TERMINAL = new Set<ResolutionStep>(['resolved']);

export interface Pending {
  market: Market;
  dispute: DisputeState;
  /** The last thing recorded against this market's resolution. */
  last: ResolutionStep;
  /**
   * The clock this market set for itself: its UMA deadline, or when trading
   * stopped, or its end date, whichever is known first. Undefined when none is,
   * which is reported rather than filled in with the epoch.
   */
  since?: Date;
  /** Milliseconds since `since`. Undefined when `since` is, negative if future. */
  waited?: number;
}

export interface QueueScan {
  pending: Pending[];
  /** Markets examined. The result is a sample and says so. */
  scanned: number;
  /** Never reached the oracle at all, so there is nothing to be waiting on. */
  noLifecycle: number;
  /** Lifecycle ended on `resolved`. */
  finished: number;
  /** Pending markets with no usable clock, counted rather than sorted as zero. */
  undated: number;
}

// The date repair this file used to own now lives in core/dispute.ts, because
// there were two copies and only this one knew about the `closedTime` shape.
// Losing a clock here sorts a market to the bottom as undated rather than to
// the top as the oldest thing in the queue, which is why it is repaired at all.
const parseDate = parseMarketDate;

/**
 * Split a scanned set into what finished and what did not.
 *
 * Longest wait first, and markets with no clock sort to the bottom rather than
 * to the top, which is where an undefined would put them if it were coerced.
 */
export function queue(markets: Market[], now = new Date()): QueueScan {
  const pending: Pending[] = [];
  let noLifecycle = 0;
  let finished = 0;
  let undated = 0;

  for (const market of markets) {
    const steps = market.resolutionSteps;
    const last = steps.at(-1);

    if (last === undefined) {
      noLifecycle += 1;
      continue;
    }
    if (TERMINAL.has(last)) {
      finished += 1;
      continue;
    }

    const since = parseDate(market.umaEndDate)
      ?? parseDate(market.closedTime)
      ?? parseDate(market.endDate);

    if (!since) undated += 1;

    pending.push({
      market,
      dispute: parseDispute(market),
      last,
      since,
      waited: since ? now.getTime() - since.getTime() : undefined,
    });
  }

  pending.sort((a, b) => {
    // Undated last. Sorting an unknown wait as zero would bury the markets we
    // know least about among the ones that just arrived.
    if (a.waited === undefined && b.waited === undefined) return b.market.volume - a.market.volume;
    if (a.waited === undefined) return 1;
    if (b.waited === undefined) return -1;
    return b.waited - a.waited;
  });

  return { pending, scanned: markets.length, noLifecycle, finished, undated };
}

/** How long a wait reads as, at the resolution a person actually cares about. */
export function waited(ms: number | undefined): string {
  if (ms === undefined) return 'unknown';
  if (ms < 0) return 'not yet due';

  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;

  const days = hours / 24;
  if (days < 90) return `${Math.round(days)}d`;
  return `${Math.round(days / 30)}mo`;
}
