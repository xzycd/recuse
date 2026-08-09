/**
 * Turning Polymarket's resolution log into an answerable state.
 *
 * Gamma exposes `umaResolutionStatuses` as an ordered list of what happened to
 * a market's resolution, e.g. ["proposed","disputed","proposed","resolved"].
 * Read left to right it is the whole fight: someone proposed an outcome, someone
 * bonded against it, a new proposal went up, and that one stuck.
 *
 * A round is one `disputed` entry. Two rounds means two people were confident
 * enough to put up a bond, which is the signal we rank on.
 */

import type { DisputeState, Market, ResolutionStep } from '../types.js';

const KNOWN_STEPS = new Set<ResolutionStep>(['proposed', 'disputed', 'resolved', 'reset']);

/** Normalise one raw status string. Unrecognised values survive as 'unknown'. */
export function normaliseStep(raw: unknown): ResolutionStep {
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.trim().toLowerCase();
  return KNOWN_STEPS.has(s as ResolutionStep) ? (s as ResolutionStep) : 'unknown';
}

/** Normalise the whole lifecycle array. */
export function normaliseSteps(raw: unknown): ResolutionStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normaliseStep);
}

/**
 * Derive the current phase from the last thing that happened.
 *
 * Deliberately literal: we report the last recorded step and nothing more.
 * Inferring "probably settled by now" from a stale feed is how a tool starts
 * lying, and this one is read by people with money on the answer.
 */
function derivePhase(steps: ResolutionStep[], market?: Pick<Market, 'closed'>): DisputeState['phase'] {
  const last = steps.at(-1);

  if (last === 'disputed') return 'in-dispute';
  if (last === 'resolved') return 'settled';
  if (last === 'proposed' || last === 'reset') return 'proposed';

  // No lifecycle recorded. A closed market with no steps resolved by some
  // route other than UMA: automatic settlement, or the feed never filled in.
  return market?.closed ? 'settled' : 'undisputed';
}

/**
 * Parse the two date shapes Gamma serves.
 *
 * `endDate` and `umaEndDate` are ISO. `closedTime` is `2025-07-09 00:30:39+00`,
 * which is not: a space instead of the T, and a two digit offset where ISO
 * wants four or a Z. Both defects have to be repaired or `new Date` returns
 * Invalid Date and the market silently loses its clock, which reads as "no
 * deadline recorded" rather than as an error.
 *
 * One parser rather than two. This file and `core/queue.ts` each had their own,
 * and only one of them knew about the `closedTime` shape, so which fields could
 * be read depended on which module was asking.
 */
export function parseMarketDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || value === '') return undefined;

  const normalised = value
    .replace(' ', 'T')
    .replace(/([+-]\d{2})$/, '$1:00');

  const d = new Date(normalised);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Parse a market's resolution lifecycle.
 *
 * Accepts the market so the phase can account for closure, but the round count
 * comes only from the steps. That number is a fact about the record, not a
 * judgement, and it should not vary with anything else.
 */
export function parseDispute(market: Market): DisputeState {
  const steps = market.resolutionSteps;
  const rounds = steps.filter((s) => s === 'disputed').length;

  return {
    conditionId: market.conditionId,
    rounds,
    phase: derivePhase(steps, market),
    contested: rounds > 0,
    deadline: parseMarketDate(market.umaEndDate) ?? parseMarketDate(market.endDate),
    steps,
  };
}

/**
 * Render a lifecycle compactly for a dense table: P→D→P→R.
 *
 * The arrows matter. A flat "2 disputes" hides whether the market is still
 * being fought over or already landed.
 */
export function formatSteps(steps: ResolutionStep[]): string {
  if (steps.length === 0) return '—';
  const glyph: Record<ResolutionStep, string> = {
    proposed: 'P',
    disputed: 'D',
    resolved: 'R',
    reset: 'X',
    unknown: '?',
  };
  return steps.map((s) => glyph[s]).join('→');
}

/**
 * Rank markets by how much attention they deserve.
 *
 * Rounds dominate money: a twice-contested $1M market is a live fight, while a
 * clean $300M market is just large. Ties break on pool so that, among equally
 * contested markets, the expensive one sorts first.
 */
export function disputeWeight(state: DisputeState, pool: number): number {
  const phaseBonus = state.phase === 'in-dispute' ? 1_000_000 : 0;
  return state.rounds * 10_000_000 + phaseBonus + Math.log10(Math.max(pool, 1));
}
