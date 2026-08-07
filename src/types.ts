/**
 * Shared record shapes. Everything crossing a module boundary is one of these.
 *
 * Rule that governs this file: a score never travels alone. Any number that
 * represents a judgement carries the terms it was computed from, so a caller
 * can always show its work. See CLAUDE.md.
 */

/** Which side of a binary market an address is on. */
export type Side = 'YES' | 'NO';

/** One round in a market's resolution lifecycle, in order. */
export type ResolutionStep = 'proposed' | 'disputed' | 'resolved' | 'reset' | 'unknown';

/** A market as Polymarket's Gamma API describes it, narrowed to what we use. */
export interface Market {
  conditionId: string;
  questionId?: string;
  slug: string;
  question: string;
  /** Total lifetime volume in USD. */
  volume: number;
  liquidity: number;
  /** UMA adapter contract that owns this market's resolution. */
  resolvedBy?: string;
  /** Bond a proposer must post, in USDC. */
  umaBond?: number;
  umaReward?: number;
  /** Free text the oracle is meant to consult. Often the whole problem. */
  resolutionSource?: string;
  endDate?: string;
  umaEndDate?: string;
  closed: boolean;
  active: boolean;
  negRisk: boolean;
  /** Raw lifecycle from Gamma, e.g. ["proposed","disputed","proposed"]. */
  resolutionSteps: ResolutionStep[];
  /** CLOB token ids, index-aligned with outcomes. */
  tokenIds: string[];
  outcomes: string[];
  outcomePrices: number[];
}

/** A market's resolution lifecycle, parsed into something answerable. */
export interface DisputeState {
  conditionId: string;
  /** How many times someone put up a bond to contest a proposal. */
  rounds: number;
  /** Where it stands right now. */
  phase: 'undisputed' | 'proposed' | 'in-dispute' | 'settled';
  /** True once contested at least once, regardless of current phase. */
  contested: boolean;
  /** Deadline for the current phase, if one is knowable. */
  deadline?: Date;
  /** The raw steps, kept so callers can render the full history. */
  steps: ResolutionStep[];
}

/** Someone holding a position in a market. From data-api or the subgraph. */
export interface Holder {
  address: string;
  /** Polymarket display name, when the account made one public. */
  name?: string;
  side: Side;
  /** Position size in outcome tokens. */
  size: number;
  /** Position value in USD at current mark. */
  value: number;
}

/** An address that acted on a market's resolution. */
export interface Actor {
  address: string;
  role: 'proposer' | 'disputer' | 'voter';
  /** Vote weight for voters; bond size for proposers and disputers. */
  weight: number;
  /** Block the action landed in, for ordering and auditability. */
  block?: number;
  txHash?: string;
}

/**
 * An actor who holds a position in the market they acted on.
 *
 * This is the whole product. Both halves are public facts; the finding is
 * that they overlap.
 */
export interface Conflict {
  address: string;
  name?: string;
  role: Actor['role'];
  weight: number;
  /** The side they hold. */
  side: Side;
  /** What that position is worth in USD. */
  exposure: number;
  /**
   * Whether their action pushed toward the side they hold. Null when the
   * action's direction is not knowable, which is honest and common.
   */
  alignsWithPosition: boolean | null;
}

/**
 * The capture score plus every term behind it.
 *
 * `score` alone is unfalsifiable. The rest of this object is what makes it
 * checkable, and the UI is required to render it. See DNA.md.
 */
export interface CaptureScore {
  /** conflictedWeight / totalWeight, in [0, 1]. */
  score: number;
  /** Combined weight of actors holding a position in this market. */
  conflictedWeight: number;
  /** Combined weight of every actor considered. */
  totalWeight: number;
  /** How many actors were conflicted, of how many examined. */
  conflictedCount: number;
  actorCount: number;
  /** Combined USD exposure held by conflicted actors. */
  exposure: number;
  /** The conflicts themselves, largest weight first. */
  conflicts: Conflict[];
  /**
   * Why this score should be distrusted, if it should be. Empty means every
   * actor's position could be checked.
   */
  caveats: string[];
}

/** A market plus everything we know about who decides it. */
export interface Assessment {
  market: Market;
  dispute: DisputeState;
  capture: CaptureScore;
  /** Money at stake, used to rank. */
  pool: number;
  fetchedAt: string;
}
