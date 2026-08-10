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
  /** When Gamma last touched the record. Not when the lifecycle last moved. */
  updatedAt?: string;
  /** When trading stopped, which is when oracle risk starts. */
  closedTime?: string;
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

/*
 * `Actor` and `Conflict` used to be declared here: an address that acted on a
 * resolution, and one that acted on a market it also held. The second is the
 * thesis of the whole tool. Neither was ever produced, because reading who
 * acted needs the oracle logs described in `sources/chain.ts`, and that is
 * unbuilt. They were deleted in 0.6.0 along with the two always-empty fields
 * they filled on `Assessment`. A type nothing constructs is a plan, and a plan
 * belongs in DNA.md, where this one is.
 */

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
   * Why this side is the one being measured.
   *
   * `wiped`    settled, and this is the side that lost. Still fully visible in
   *            balances because there is nothing to redeem a loser for.
   * `redeemed` settled, and this is the side that won. Invisible in balances,
   *            recovered from what they bought.
   * `leading`  live market, both sides intact, this side is ahead on price.
   */
  meaning: 'wiped' | 'redeemed' | 'leading';
  /**
   * What was counted.
   *
   * `balances` is what each wallet holds now. `trades` is what each wallet ever
   * bought. They answer different questions and are never added together: a
   * winner's balance is zero and their buys are not.
   */
  basis: 'balances' | 'trades';
  /** How many top holders the share covers. */
  topN: number;
  /** topSize / totalSize, in [0, 1]. */
  topShare: number;
  topSize: number;
  totalSize: number;
  /** Holders seen on this side. The API pages, so this is a floor, not a count. */
  holderCount: number;
  /**
   * Positions smaller than this many tokens were never requested. Zero means no
   * floor was applied. Set on `trades`, where the store needs a lower bound to
   * serve the query at all.
   */
  floor?: number;
}

/**
 * An address seen across several contested markets.
 *
 * Counts losses, not wins. See the redemption note in core/capture.ts. Winners
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
 * An address on the winning side of more than one contested market.
 *
 * The counterpart to `RepeatPlayer`, and the half that is structurally harder
 * to see. Losers are visible in balances because nothing redeems a losing
 * token, so `RepeatPlayer` is one holder lookup per market. Winners redeem and
 * their balances go to zero, so this has to be rebuilt from cumulative trades,
 * one subgraph query per market, which is why it is its own command and not a
 * column on an existing one.
 *
 * The same restraint applies as to `RepeatPlayer`, in the other direction.
 * Someone wins every market, and winning a disputed one is not evidence of
 * anything on its own. What varies, and is therefore worth printing, is how
 * often: across 33 contested markets read, 263 wallets won one and a single
 * wallet won seven. The tally is the finding and the reader supplies the rest.
 */
export interface Regular {
  address: string;
  name?: string;
  /** Contested markets where this address held a winning position at the end. */
  wins: number;
  /** Tokens carried into settlement, summed across those markets. */
  tokens: number;
  /** USD paid for them, summed. The cost basis of `tokens`. */
  paid: number;
  /**
   * `tokens - paid`. Arithmetic rather than an estimate: every winning token
   * held at settlement redeems for exactly one dollar.
   */
  gain: number;
  /** Which markets, by slug, so any row can be checked with `recuse market`. */
  markets: string[];
}

/**
 * Which evidence a result is standing on.
 *
 * `positions` is what every user gets with no setup. `positions+trades` adds
 * the winning side rebuilt from the subgraph. Both name a source that actually
 * answered, which is the whole point: a partial picture presented as a complete
 * one is the failure this project exists to catch.
 *
 * The `+chain` variants were removed rather than left unreachable. They were
 * produced from the presence of RECUSE_RPC_URL rather than from any oracle
 * request, so they were a claim about configuration wearing the costume of a
 * claim about evidence. Restoring them is one line, once `sources/chain.ts` is
 * wired into an assessment and can say what it read.
 */
export type EvidenceTier = 'positions' | 'positions+trades';

/** A wallet that bought the side which went on to win. */
export interface Winner {
  address: string;
  /**
   * Polymarket display name, when the account made one public and the lookup
   * answered. Absent means one of three things and never distinguishes them:
   * no name set, the account is unnamed by choice, or the request failed. The
   * failure count is a caveat on the assessment for exactly that reason.
   */
  name?: string;
  /** Tokens bought, cumulative. Redemption does not reduce it. */
  bought: number;
  /** Tokens still held when trading stopped: bought minus resold. */
  net: number;
  /** USD paid, cumulative. */
  spent: number;
  /** USD paid minus USD received back. The cost basis of `net`. */
  netSpent: number;
}

/** A market plus everything we know about who decides it. */
export interface Assessment {
  market: Market;
  dispute: DisputeState;
  /** Concentration of the visible side, when holders could be read. */
  concentration?: Concentration;
  /**
   * Concentration of the side that won, rebuilt from trades.
   *
   * Only present on a settled market, and only when the subgraph answered. Its
   * absence is recorded as a caveat rather than shown as an empty result.
   */
  winnerConcentration?: Concentration;
  /** The largest buyers of the winning side, largest first. */
  winners?: Winner[];
  /*
   * There is no `actors` or `conflicts` field, and their absence is the point.
   * Both used to ship as hardcoded empty arrays, on the argument that the JSON
   * shape should not change on the day the oracle reading lands. That argument
   * is worth less than what it cost: `"actors": []` tells a consumer that the
   * oracle was read and nobody was there, which is a confident zero over ground
   * this build never covers. A caveat says the truth, but a consumer parses
   * fields and not prose. An absent field cannot be misread, the version policy
   * allows adding one in any minor release, and until 1.0 the shape is not a
   * contract anyway.
   */
  tier: EvidenceTier;
  /**
   * Where the trade index stops, set only when this market closed after it.
   *
   * Present means the winning side was never read, so `winners` being absent or
   * empty says nothing about who held it. A consumer parses fields rather than
   * prose, and `"winners": []` on its own is a claim that the side was read and
   * nobody was there. This is the field that stops it being read that way, and
   * it is absent whenever the reading was actually covered.
   */
  tradeIndexEndsAt?: string;
  /**
   * Set when `winners` was rebuilt from the data-api trade log rather than from
   * the index, which is what happens whenever `tradeIndexEndsAt` is present and
   * the log could answer.
   *
   * The two fields answer different questions and a consumer needs both. The
   * one above says the index did not cover this market. This one says whether
   * anything covered it instead, and on what terms: `floor` is the minimum
   * trade size in dollars that made the read servable, `read` is how many
   * trades went into it, and `truncated` means the log itself was cut at the
   * most recent `read` of a longer history, which makes every total here a
   * partial rather than a cumulative one.
   */
  tradeLog?: { floor: number; read: number; truncated: boolean };
  /** Why this reading is incomplete. Empty means it is not. */
  caveats: string[];
  /** Money at stake, used to rank. */
  pool: number;
  fetchedAt: string;
}
