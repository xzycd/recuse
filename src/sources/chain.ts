/**
 * The optional layer: reading Polygon for who proposed and who disputed.
 *
 * This is opt-in for a reason that took a while to find. Polymarket's markets
 * resolve through UMA's Managed Optimistic Oracle, and the proposer and
 * disputer addresses only exist in that contract's logs. Reading logs needs
 * `eth_getLogs` over a block range, and the free public Polygon endpoints will
 * not serve one:
 *
 *   polygon-bor-rpc.publicnode.com  1000 blocks, throttled to 10 under load
 *   polygon.drpc.org                rejects ranges it advertises as supported
 *   1rpc.io/matic                   50 blocks
 *
 * At 50 blocks a window, covering a day of Polygon costs 860 requests. So the
 * default build does not pretend to have this data. Point RECUSE_RPC_URL at an
 * endpoint that will serve log ranges (any provider's free tier does) and
 * this layer turns on. Until then the tool says so, every time, rather than
 * showing a partial picture that looks complete.
 */

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

/** Is the chain layer configured at all? */
export function chainConfigured(): boolean {
  return Boolean(process.env.RECUSE_RPC_URL);
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
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    if (!res.ok) throw new Error(`rpc ${res.status} ${res.statusText}`);

    const body = (await res.json()) as { result?: T; error?: { message: string } };
    // Surfaced, never swallowed. Treating an error as an empty result is how a
    // scan reports a confident zero over ground it never covered.
    if (body.error) throw new Error(`rpc error: ${body.error.message}`);
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
