/**
 * The optional layer: reading Polygon for who proposed and who disputed.
 *
 * NOTHING IN THIS FILE IS WIRED INTO AN ASSESSMENT. `chainStatus` and
 * `chainNote` below are the only exports anything calls. `Chain` is never
 * constructed, `scanLogs` and `actorsInRange` are never reached, and no result
 * this tool has ever printed stood on oracle evidence.
 *
 * That sentence is here because the opposite was true in the output for a
 * while. `assess.ts` built its evidence tier from "is RECUSE_RPC_URL set"
 * rather than from "did we read anything", so exporting the variable was enough
 * to make every reading claim `positions+chain` while `actors` stayed empty.
 * The scheme check in the constructor never ran either, since the constructor
 * never ran, which made SECURITY.md's http-or-https claim true only on paper.
 * Both are fixed by measuring what was read instead of what was configured.
 *
 * The constants are the part worth keeping. Polymarket's markets resolve
 * through UMA's Managed Optimistic Oracle, and the proposer and disputer
 * addresses only exist in that contract's logs. Reading logs needs
 * `eth_getLogs` over a block range, and the free public Polygon endpoints will
 * not serve one:
 *
 *   polygon-bor-rpc.publicnode.com  1000 blocks, throttled to 10 under load
 *   polygon.drpc.org                rejects ranges it advertises as supported
 *   1rpc.io/matic                   50 blocks
 *
 * At 50 blocks a window, covering a day of Polygon costs 860 requests. The
 * addresses and topic hashes below were decoded from live traffic rather than
 * from documentation and are correct; the reading built on them is not
 * finished. Until it is, the tool says the oracle is unread rather than
 * implying that configuration alone bought anything.
 */

import { redactMessage, safeEndpoint } from '../core/safe.js';
import { readJsonCapped } from './http.js';
import type { Actor } from '../types.js';

/**
 * Addresses and topics, all confirmed against live Polygon traffic rather than
 * copied from documentation. The v1/v2/v3 adapters in Polymarket's docs are
 * dormant; these two carry current volume.
 */
export const CONTRACTS = {
  /** Managed Optimistic Oracle V2. Polymarket migrated here under UMIP-189. */
  oracle: '0x2c0367a9db231ddebd88a94b4f6461a6e47c58b1',
  adapters: [
    '0x65070be91477460d8a7aeeb94ef92fe056c2f2a7',
    '0x69c47de9d4d3dad79590d61b9e05918e03775f24',
  ],
} as const;

export const TOPICS = {
  questionInitialized: '0xeee0897acd6893adcaf2ba5158191b3601098ab6bece35c5d57874340b64c5b7',
  questionResolved: '0x566c3fbdd12dd86bb341787f6d531f79fd7ad4ce7e3ae2d15ac0ca1b601af9df',
  questionReset: '0x7981b5832932948db4e32a4a16a0f44b2ce7ff088574afb9364b313f70f82e8f',
  requestPrice: '0xf1679315ff325c257a944e0ca1bfe7b26616039e9511f9610d4ba3eca851027b',
} as const;

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

/** Pull a 20-byte address out of a 32-byte indexed topic. */
export function addressFromTopic(topic: string): string {
  return `0x${topic.slice(26)}`.toLowerCase();
}

/**
 * Classify an oracle log by shape rather than by a hardcoded signature hash.
 *
 * UMA's oracle events are distinguishable by how many parameters they index:
 * a dispute carries requester, proposer and disputer; a proposal carries
 * requester and proposer. Reading the shape means this keeps working across
 * oracle versions, and an unrecognised event is reported as unknown instead of
 * being forced into a category it does not belong in.
 */
export function classifyOracleLog(log: RawLog): Actor[] {
  const indexed = log.topics.length - 1;
  const block = Number.parseInt(log.blockNumber, 16);
  const base = { block, txHash: log.transactionHash, weight: 1 };

  if (indexed === 3) {
    const proposer = log.topics[2];
    const disputer = log.topics[3];
    if (!proposer || !disputer) return [];
    return [
      { address: addressFromTopic(proposer), role: 'proposer', ...base },
      { address: addressFromTopic(disputer), role: 'disputer', ...base },
    ];
  }

  if (indexed === 2) {
    const proposer = log.topics[2];
    if (!proposer) return [];
    return [{ address: addressFromTopic(proposer), role: 'proposer', ...base }];
  }

  return [];
}

export class ChainUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ChainUnavailable';
  }
}

export interface ScanResult {
  logs: RawLog[];
  /** Windows that errored. A non-zero value means the scan has holes. */
  windowsFailed: number;
  windowsTotal: number;
  /** Blocks actually covered by windows that succeeded. */
  blocksCovered: number;
}

export interface ChainStatus {
  /** RECUSE_RPC_URL is set to something. */
  configured: boolean;
  /**
   * Whether any assessment in this build stands on oracle logs. Always false,
   * and typed as false so a caller cannot branch on it becoming true without
   * this file changing first.
   */
  reads: false;
  /** Why the endpoint was refused, when it was. */
  rejected?: string;
}

/**
 * What the chain layer contributes right now, which is nothing.
 *
 * This is the only place RECUSE_RPC_URL is validated, and it is called on every
 * assessment, so `safeEndpoint` now runs for real. It used to sit in the `Chain`
 * constructor, which nothing constructs: an unwired defence reads exactly like
 * a working one, and this is the second time that has happened here.
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

export class Chain {
  private id = 0;

  constructor(
    private readonly url = process.env.RECUSE_RPC_URL ?? '',
    /** Window size. Conservative default; providers vary and most allow more. */
    private readonly windowSize = Number(process.env.RECUSE_RPC_WINDOW ?? 2000),
  ) {
    if (!this.url) {
      throw new ChainUnavailable(
        'RECUSE_RPC_URL is not set. The free public Polygon endpoints cap eth_getLogs ' +
          'at 10-50 blocks, which is too small to read the oracle. Any provider free tier works.',
      );
    }

    // Checked once, here, rather than at every call site. Without it this is an
    // arbitrary URL that the tool POSTs to and reads a JSON body back from, and
    // a scheme like file: would turn a config value into a local file read.
    try {
      safeEndpoint(this.url);
    } catch (err) {
      throw new ChainUnavailable(`RECUSE_RPC_URL rejected: ${(err as Error).message}`);
    }
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      });
    } catch (err) {
      // The endpoint almost always carries an API key. Node puts the request
      // URL into some network error messages, and the natural next step after
      // an error is pasting it into an issue.
      throw new Error(`rpc request failed: ${redactMessage((err as Error).message)}`);
    }

    if (!res.ok) throw new Error(`rpc ${res.status} ${res.statusText}`);

    const body = await readJsonCapped<{ result?: T; error?: { message: string } }>(res);
    // Surfaced, never swallowed. Treating an error as an empty result is how a
    // scan reports a confident zero over ground it never covered.
    if (body.error) throw new Error(`rpc error: ${redactMessage(body.error.message)}`);
    if (body.result === undefined) throw new Error('rpc returned no result');

    return body.result;
  }

  async blockNumber(): Promise<number> {
    return Number.parseInt(await this.call<string>('eth_blockNumber', []), 16);
  }

  /**
   * Scan an address's logs over a block range, paginated.
   *
   * Returns how many windows failed alongside the logs. Callers are expected to
   * pass that through to the user: "0 disputes found" and "0 disputes found,
   * 12 of 30 windows errored" are completely different statements.
   */
  async scanLogs(address: string, fromBlock: number, toBlock: number): Promise<ScanResult> {
    const logs: RawLog[] = [];
    let windowsFailed = 0;
    let windowsTotal = 0;
    let blocksCovered = 0;

    for (let start = fromBlock; start <= toBlock; start += this.windowSize) {
      const end = Math.min(start + this.windowSize - 1, toBlock);
      windowsTotal += 1;

      try {
        const page = await this.call<RawLog[]>('eth_getLogs', [
          { address, fromBlock: `0x${start.toString(16)}`, toBlock: `0x${end.toString(16)}` },
        ]);
        logs.push(...page);
        blocksCovered += end - start + 1;
      } catch {
        windowsFailed += 1;
      }
    }

    return { logs, windowsFailed, windowsTotal, blocksCovered };
  }

  /** Proposers and disputers seen at the oracle over a block range. */
  async actorsInRange(fromBlock: number, toBlock: number): Promise<{ actors: Actor[]; scan: ScanResult }> {
    const scan = await this.scanLogs(CONTRACTS.oracle, fromBlock, toBlock);
    return { actors: scan.logs.flatMap(classifyOracleLog), scan };
  }
}
