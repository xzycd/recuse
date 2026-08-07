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
 * How much of one side of a market sits in how few hands.
 *
 * On a contested market this is the plainest available reading of who took the
 * money. Every term is reported alongside the share, because a share on its own
 * cannot be checked.
 */
export interface Concentration {
  side: Side;
  /**
   * Why this side is the one being measured. `wiped` means the market has
   * settled and this is the side that lost — the only side still fully visible,
   * because winners redeem and losers do not. `leading` means the market is
   * live and both sides are intact.
   */
  meaning: 'wiped' | 'leading';
  /** How many top holders the share covers. */
  topN: number;
  /** topSize / totalSize, in [0, 1]. */
  topShare: number;
  topSize: number;
  totalSize: number;
  /** Holders seen on this side. The API pages, so this is a floor, not a count. */
  holderCount: number;
}

/**
 * An address seen across several contested markets.
 *
 * Counts losses, not wins — see the redemption note in core/capture.ts. Winners
 * redeem and vanish from holder data; losers stay, holding tokens worth nothing.
 *
 * The signal is deliberately weaker than it sounds: being on the losing side of
 * a disputed market is not evidence of anything on its own, since someone has
 * to be. Doing it repeatedly is worth a look. The tool reports the tally and
 * lets the reader draw the line.
 */
export interface RepeatPlayer {
  address: string;
  name?: string;
  /** Contested markets where this address held the side that lost. */
  losses: number;
  /** Contested markets where this address held any side at all. */
  appearances: number;
  /** losses / appearances. Meaningless below a handful of appearances. */
  lossRate: number;
  /** Combined token size across losing appearances. */
  size: number;
}

/**
 * Which evidence a result is standing on.
 *
 * `positions` is what every user gets with no setup. `positions+chain` needs an
 * RPC that will serve log ranges, which the free public endpoints will not.
 * The tool always states which one produced a given answer — a partial picture
 * presented as a complete one is the failure this project exists to catch.
 */
export type EvidenceTier = 'positions' | 'positions+chain';

/** A market plus everything we know about who decides it. */
export interface Assessment {
  market: Market;
  dispute: DisputeState;
  /** Concentration of the leading side, when holders could be read. */
  concentration?: Concentration;
  /** Empty unless the chain layer is configured and reachable. */
  actors: Actor[];
  /** Empty unless the chain layer is configured and reachable. */
  conflicts: Conflict[];
  tier: EvidenceTier;
  /** Why this reading is incomplete. Empty means it is not. */
  caveats: string[];
  /** Money at stake, used to rank. */
  pool: number;
  fetchedAt: string;
}
