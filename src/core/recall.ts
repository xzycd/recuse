/**
 * What has moved since you last looked.
 *
 * Pure. The radar reads a list that barely changes: the most contested markets
 * of all time are the same markets tomorrow, which is a good ranking and a bad
 * reason to run a command twice. This answers the other question, the one that
 * does change, by keeping a snapshot of the last reading and diffing against it.
 *
 * It reuses `compare` from watch.ts rather than deciding for itself what a move
 * is. There should be exactly one definition of "this resolution moved" in the
 * codebase, and it is the one that already has twenty tests and knows that a
 * lifecycle shrinking is news rather than a correction.
 *
 * The baseline rule carries over too. A first run has nothing to compare
 * against, reports nothing, and says how many markets it recorded. A tool that
 * announces twenty five findings the first time it runs teaches you that the
 * announcement means nothing.
 */

import { compare, type Seen } from './watch.js';
import type { Assessment } from '../types.js';

/**
 * What happened to one market since the previous reading.
 *
 * `rewritten` is kept apart from `moved` because it is a different claim. A
 * market that gained a dispute round moved forward; a market whose settled
 * history changed underneath us means Gamma edited the record, and that is the
 * single thing this tool exists to notice.
 */
export type Movement = 'unseen' | 'moved' | 'rewritten' | 'steady';

/** Sort weight. Rewritten first: it is the rarest and the most alarming. */
const RANK: Record<Movement, number> = { rewritten: 3, moved: 2, unseen: 1, steady: 0 };

export function movementRank(movement: Movement | undefined): number {
  return movement === undefined ? 0 : RANK[movement];
}

export interface Recall {
  /** Condition id to what changed. Every assessed market has an entry. */
  movement: Map<string, Movement>;
  /** Markets whose resolution moved forward since the last reading. */
  moved: number;
  /** Markets whose recorded history changed rather than grew. */
  rewritten: number;
  /** Markets in this reading that the previous one did not contain. */
  unseen: number;
  /** Markets that were in both readings, which is the honest denominator. */
  compared: number;
  /** When the previous reading was taken. Absent on the first run. */
  since?: string;
  /** True when there was no previous reading, so nothing is reported. */
  baseline: boolean;
}

/**
 * Diff this reading against the last one.
 *
 * `previous` is keyed by condition id. A market missing from it is `unseen`
 * rather than `moved`: the radar only snapshots the rows it assessed, so a
 * market that fell out of the top of the ranking and came back has no baseline
 * to be compared against, and calling that a move would be inventing news out
 * of a change in the sort order.
 */
export function recall(
  assessments: Assessment[],
  previous: { baselineAt?: string; markets: Record<string, Seen> },
  now = new Date(),
): Recall {
  const movement = new Map<string, Movement>();
  const first = !previous.baselineAt;

  let moved = 0;
  let rewritten = 0;
  let unseen = 0;
  let compared = 0;

  for (const a of assessments) {
    const id = a.market.conditionId;
    if (!id) continue;

    const before = previous.markets[id];

    if (!before) {
      // On a first run everything is a baseline, not an arrival.
      movement.set(id, first ? 'steady' : 'unseen');
      if (!first) unseen += 1;
      continue;
    }

    compared += 1;

    const { events } = compare(before, a.market, { origin: 'discovery', baselineDone: true, now });

    if (events.some((e) => e.kind === 'rewritten')) {
      movement.set(id, 'rewritten');
      rewritten += 1;
    } else if (events.length > 0) {
      movement.set(id, 'moved');
      moved += 1;
    } else {
      movement.set(id, 'steady');
    }
  }

  return {
    movement,
    moved,
    rewritten,
    unseen,
    compared,
    since: previous.baselineAt,
    baseline: first,
    // A first run reports nothing at all, so the counts above are zero by
    // construction and the caller prints the baseline line instead.
  };
}

/**
 * The line under the table saying what changed.
 *
 * Returns undefined when there is nothing to say, which is different from
 * saying nothing changed. A run with no previous reading says so, because
 * "0 moved" over ground never covered is exactly the confident zero this
 * project refuses to print.
 */
export function recallNote(r: Recall, assessed: number): string | undefined {
  if (r.baseline) {
    return `first reading, ${assessed} markets recorded. run again to see what moved.`;
  }

  const parts: string[] = [];
  if (r.rewritten > 0) parts.push(`${r.rewritten} rewritten`);
  if (r.moved > 0) parts.push(`${r.moved} moved`);
  if (r.unseen > 0) parts.push(`${r.unseen} not seen before`);

  const when = r.since ? ` since ${r.since.slice(0, 16).replace('T', ' ')}` : '';

  if (parts.length === 0) {
    return `nothing moved in ${r.compared} markets${when}`;
  }

  // The denominator travels with the count, the same as every other share this
  // tool prints. "3 moved" alone cannot be checked; "3 moved of 25 compared" can.
  return `${parts.join(', ')} of ${r.compared} compared${when}`;
}
