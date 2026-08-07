/**
 * The oracle layer, which is not built, and says so.
 *
 * This file used to hold about two hundred lines of working JSON-RPC: a `Chain`
 * class, a windowed `eth_getLogs` scanner, and a log classifier. All of it was
 * unreachable. Nothing constructed `Chain`, so nothing called `scanLogs`, so no
 * reading this tool ever printed stood on oracle evidence. It was deleted in
 * 0.6.0 rather than kept warm, because unreachable code that looks finished is
 * how the 0.5.0 evidence bug happened twice: `safeEndpoint` sat in that class's
 * constructor and read as a working defence for weeks while never executing.
 * The implementation is in the git history if the reading is ever built.
 *
 * The research is worth more than the code was, so it is written down here
 * instead. It was decoded from live Polygon traffic, not from documentation,
 * where the v1, v2 and v3 adapters are listed but dormant.
 *
 *   Managed Optimistic Oracle V2, which Polymarket moved to under UMIP-189:
 *     0x2c0367a9db231ddebd88a94b4f6461a6e47c58b1
 *   The two adapters carrying current volume:
 *     0x65070be91477460d8a7aeeb94ef92fe056c2f2a7
 *     0x69c47de9d4d3dad79590d61b9e05918e03775f24
 *   Event topics:
 *     QuestionInitialized 0xeee0897acd6893adcaf2ba5158191b3601098ab6bece35c5d57874340b64c5b7
 *     QuestionResolved    0x566c3fbdd12dd86bb341787f6d531f79fd7ad4ce7e3ae2d15ac0ca1b601af9df
 *     QuestionReset       0x7981b5832932948db4e32a4a16a0f44b2ce7ff088574afb9364b313f70f82e8f
 *     RequestPrice        0xf1679315ff325c257a944e0ca1bfe7b26616039e9511f9610d4ba3eca851027b
 *
 * The proposer and disputer addresses live only in those logs, which means
 * `eth_getLogs` over a block range, which the free public endpoints will not
 * serve. Measured while building this:
 *
 *   polygon-bor-rpc.publicnode.com  1000 blocks, throttled to 10 under load
 *   polygon.drpc.org                rejects ranges it advertises as supported
 *   1rpc.io/matic                   50 blocks
 *
 * At 50 blocks a window, one day of Polygon costs 860 requests. That is the
 * reason this is unbuilt, and it is a reason about the endpoints rather than
 * about the effort.
 */

import { safeEndpoint } from '../core/safe.js';

export interface ChainStatus {
  /** RECUSE_RPC_URL is set to something. */
  configured: boolean;
  /**
   * Whether any assessment in this build stands on oracle logs. Always false,
   * and typed as the literal `false` so a caller cannot branch on it becoming
   * true without this file changing first.
   */
  reads: false;
  /** Why the endpoint was refused, when it was. */
  rejected?: string;
}

/**
 * What the oracle layer contributes to a reading, which is nothing.
 *
 * This is the only place RECUSE_RPC_URL is validated, and `assess` calls it on
 * every reading, so `safeEndpoint` runs for real. Keeping the check on a path
 * that executes is the entire point of it living here.
 */
export function chainStatus(): ChainStatus {
  const url = process.env.RECUSE_RPC_URL;
  if (!url) return { configured: false, reads: false };

  try {
    safeEndpoint(url);
    return { configured: true, reads: false };
  } catch (err) {
    return { configured: true, reads: false, rejected: (err as Error).message };
  }
}

/**
 * One line saying what the oracle contributed to a reading.
 *
 * Travels as a caveat rather than as chrome, so `--json` carries it too. A user
 * who set the variable and got silence would reasonably assume it worked.
 */
export function chainNote(): string {
  const status = chainStatus();
  if (status.rejected) {
    return `RECUSE_RPC_URL ignored, ${status.rejected}. proposer and disputer unread`;
  }
  if (status.configured) {
    return 'RECUSE_RPC_URL is set but unused: this build does not read the oracle yet, so proposer and disputer are unread';
  }
  return 'this build does not read the oracle, so proposer and disputer are unread';
}
