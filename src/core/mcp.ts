/**
 * Serving the engine over MCP, so an agent can ask instead of a person typing.
 *
 * The protocol half of this file is pure: `dispatch` takes a message and a list
 * of tools and returns a reply. The engine is injected, so the tests run the
 * real protocol against a fake reader and never touch the network.
 *
 * Two things about this surface are different from every other one here, and
 * both changed how it is written.
 *
 * The first is mechanical. stdout is the transport, so anything that prints
 * corrupts the session: one stray line and the client sees a parse error and
 * hangs up. `recuse serve` therefore draws no banner, starts no spinner and
 * runs no update check. The spinner already writes to stderr and the banner
 * already refuses to draw into a pipe, which is why that was one line rather
 * than an audit.
 *
 * The second is the reason this file has so much prose in it. Every other
 * consumer of this engine is a person reading a table, and a person reading
 * `85% 5/100` can see the denominator sitting next to the share. The consumer
 * here is a language model, which will summarise, and summarising is exactly
 * the operation that drops a denominator, a caveat and a floor while keeping
 * the number that looked like the finding. This tool exists because people
 * present partial pictures as complete ones, so handing one to the most fluent
 * summariser ever built needs the guardrails to be data rather than prose.
 *
 * So every payload carries `evidence`, `caveats` and `limits` as arrays of
 * short declarative strings, and every tool description says to repeat them.
 * A caveat in a paragraph gets summarised away. A caveat in a field the model
 * has to look at is harder to lose, and if it goes missing it went missing
 * visibly.
 */

import type { Assessment, Concentration } from '../types.js';
import type { WalletLedger } from './wallet.js';
import type { QueueScan } from './queue.js';
import { waited } from './queue.js';

/**
 * Protocol versions this speaks, newest first.
 *
 * A client that asks for one of these gets it back. A client that asks for
 * anything else gets the newest, which is what the specification says to do:
 * the server names the version it intends to use and the client disconnects if
 * it cannot live with that.
 */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcReply {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<unknown>;
}

/**
 * The engine, as this surface needs it.
 *
 * Injected rather than imported so the protocol stays testable without a
 * network, and so the tool list cannot quietly grow a second way of reading a
 * market that drifts from what the CLI prints.
 */
export interface Engine {
  contested(scan: number): Promise<{ assessments: Assessment[]; scanned: number; contested: number }>;
  market(idOrSlug: string): Promise<Assessment | undefined>;
  winners(idOrSlug: string, limit: number): Promise<Assessment | undefined>;
  wallet(address: string, limit: number): Promise<WalletLedger>;
  pending(scan: number): Promise<QueueScan>;
}

/**
 * What no reading from this tool can support, whatever the numbers look like.
 *
 * Attached to every payload. These are the sentences a summary drops first,
 * and they are the ones that keep an answer honest.
 */
const ALWAYS: string[] = [
  'this reports tallies, not intent. someone holds the losing side of every market, and holding it is not evidence of wrongdoing',
  'no proposer, disputer or voter is read by this build, so nothing here says who decided a resolution',
  'a display name is chosen by the account it describes and is not an identity. every row is anchored to its address',
];

/** A share, with the terms that make it checkable, or undefined. */
function share(c: Concentration | undefined): Record<string, unknown> | undefined {
  if (!c) return undefined;
  return {
    side: c.side,
    basis: c.basis,
    // Never the share on its own. A model asked to summarise will keep one
    // number, and this makes the one number impossible to state alone.
    reading: `top ${c.topN} of ${c.holderCount} held ${(c.topShare * 100).toFixed(1)}%`,
    topShare: c.topShare,
    topN: c.topN,
    topSize: c.topSize,
    totalSize: c.totalSize,
    holderCount: c.holderCount,
    holderCountIsFloor: true,
    ...(c.floor ? { positionsBelowTokensNotRequested: c.floor } : {}),
  };
}

function marketRow(a: Assessment): Record<string, unknown> {
  return {
    conditionId: a.market.conditionId,
    slug: a.market.slug,
    question: a.market.question,
    disputeRounds: a.dispute.rounds,
    lifecycle: a.dispute.steps,
    volumeUsd: a.pool,
    losingSide: share(a.concentration),
    winningSide: share(a.winnerConcentration),
  };
}

/** The tools this server offers, bound to an engine. */
export function recuseTools(engine: Engine): McpTool[] {
  return [
    {
      name: 'contested_markets',
      description:
        'Rank Polymarket markets by how hard their resolution was fought, most contested first. '
        + 'Returns a row per market: dispute rounds, the lifecycle the oracle recorded, volume, and how '
        + 'concentrated each side was. Use it to find markets worth looking at, then call market_record '
        + 'for the full reading of one. Contested markets are almost never still open, so this is history '
        + 'rather than a live feed. Repeat the caveats and limits fields in any answer built on this.',
      inputSchema: {
        type: 'object',
        properties: {
          scan: { type: 'integer', description: 'How many markets to examine. Default 400.' },
          limit: { type: 'integer', description: 'How many rows to return. Default 10, maximum 50.' },
        },
      },
      async run(args) {
        const scan = clamp(args.scan, 400, 1, 1000);
        const limit = clamp(args.limit, 10, 1, 50);
        const { assessments, scanned, contested } = await engine.contested(scan);
        const shown = assessments.slice(0, limit);

        return {
          scanned,
          contested,
          showing: shown.length,
          markets: shown.map(marketRow),
          evidence: tierOf(shown),
          caveats: unique(shown.flatMap((a) => a.caveats)),
          limits: [
            ...ALWAYS,
            `${scanned - contested} of ${scanned} markets scanned were never contested and are not in this list`,
            'concentration on a settled market is measured on the side that lost, because winners redeem and their balances go to zero',
            'ranking by dispute rounds is a claim about what matters, and it is this tool\'s claim rather than a fact',
          ],
        };
      },
    },
    {
      name: 'market_record',
      description:
        'The full resolution record of one Polymarket market, by condition id or slug: how many dispute '
        + 'rounds it went through, the ordered lifecycle the oracle recorded, and both sides of the book. '
        + 'The losing side comes from current balances and the winning side is rebuilt from cumulative '
        + 'trades, because a winner redeems and their balance goes to zero. The two are never added '
        + 'together. Repeat the caveats and limits fields in any answer built on this.',
      inputSchema: {
        type: 'object',
        properties: {
          market: { type: 'string', description: 'Condition id (0x...) or market slug.' },
        },
        required: ['market'],
      },
      async run(args) {
        const id = requireString(args.market, 'market');
        const a = await engine.market(id);
        if (!a) {
          // Gamma answers a filter it does not recognise with its default page
          // and HTTP 200, so an unverifiable lookup is a miss and never the
          // first row of whatever came back.
          return {
            found: false,
            market: id,
            limits: ['no market matched, and an unverified match is reported as a miss rather than guessed at'],
          };
        }

        return {
          found: true,
          ...marketRow(a),
          phase: a.dispute.phase,
          everContested: a.dispute.contested,
          winners: (a.winners ?? []).slice(0, 10).map(winnerRow),
          evidence: a.tier,
          caveats: a.caveats,
          limits: [
            ...ALWAYS,
            'the losing side is measured from balances and the winning side from cumulative buys. they answer different questions and are never summed',
            'holder counts are a floor, because the holders endpoint pages',
          ],
        };
      },
    },
    {
      name: 'winning_side',
      description:
        'Who bought the side that won a settled market, largest first, priced from the on-chain payout. '
        + 'These wallets redeemed and left the holder list, so no balance-based tracker can see them at '
        + 'all. Every winning token redeems for exactly one dollar, so the gain is arithmetic rather than '
        + 'an estimate. Plenty of these wallets bought at 0.98 and made two cents. Repeat the caveats and '
        + 'limits fields in any answer built on this.',
      inputSchema: {
        type: 'object',
        properties: {
          market: { type: 'string', description: 'Condition id (0x...) or market slug.' },
          limit: { type: 'integer', description: 'How many wallets. Default 20, maximum 50.' },
        },
        required: ['market'],
      },
      async run(args) {
        const id = requireString(args.market, 'market');
        const limit = clamp(args.limit, 20, 1, 50);
        const a = await engine.winners(id, limit);
        if (!a) return { found: false, market: id, limits: ['no market matched'] };

        const conc = a.winnerConcentration;
        return {
          found: true,
          conditionId: a.market.conditionId,
          question: a.market.question,
          concentration: share(conc),
          winners: (a.winners ?? []).map(winnerRow),
          evidence: a.tier,
          caveats: a.caveats,
          limits: [
            ...ALWAYS,
            'these are cumulative buys, not balances. a balance is a position now and a winner\'s is zero',
            ...(conc?.floor
              ? [`positions below ${conc.floor} tokens were never requested, because the subgraph will not sort by size without a floor`]
              : []),
            'buying the winning side is what a correct prediction looks like. it is not on its own evidence of anything else',
          ],
        };
      },
    },
    {
      name: 'wallet_record',
      description:
        'One wallet\'s record across resolved Polymarket markets, disputed ones first: which side it held, '
        + 'whether that side won, and the net in dollars. Positions come from cumulative trades and '
        + 'settlement from the on-chain payout, so a wallet that redeemed and vanished from every '
        + 'balance-based tracker is still fully visible. A wallet appearing on both sides of one market is '
        + 'a spread, not a contradiction. Repeat the caveats and limits fields in any answer built on this.',
      inputSchema: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'A 0x-prefixed wallet address.' },
          limit: { type: 'integer', description: 'How many positions to read. Default 25, maximum 100.' },
        },
        required: ['address'],
      },
      async run(args) {
        const address = requireString(args.address, 'address');
        const limit = clamp(args.limit, 25, 1, 100);
        const ledger = await engine.wallet(address, limit);

        return {
          address: ledger.address,
          name: ledger.name,
          resolved: ledger.won + ledger.lost + ledger.split,
          won: ledger.won,
          lost: ledger.lost,
          split: ledger.split,
          open: ledger.open,
          netUsd: ledger.gain,
          contestedMarkets: ledger.contested,
          contestedNetUsd: ledger.contestedGain,
          positions: ledger.entries.slice(0, limit).map((e) => ({
            conditionId: e.conditionId,
            question: e.question,
            disputeRounds: e.rounds,
            side: e.side,
            result: result(e),
            tokensHeld: e.net,
            usdCost: e.cost,
            usdProceeds: e.proceeds,
            netUsd: e.gain,
          })),
          evidence: 'positions+trades',
          caveats: ledger.caveats,
          limits: [
            ...ALWAYS,
            'a profitable record is a record of being right, and this tool cannot tell that from anything else',
            'only the positions read are summarised here, so the totals cover the positions listed and not the wallet\'s whole history',
          ],
        };
      },
    },
    {
      name: 'resolution_queue',
      description:
        'Markets whose resolution record never reached a terminal step, longest wait first. This does not '
        + 'say a market is stuck: a record that stops short is either a resolution still in progress or a '
        + 'feed that never appended the last step, and from outside those two are indistinguishable. The '
        + 'counts of what finished and what never reached the oracle are part of the answer, not context '
        + 'for it. Repeat the caveats and limits fields in any answer built on this.',
      inputSchema: {
        type: 'object',
        properties: {
          scan: { type: 'integer', description: 'How many markets to examine. Default 300.' },
          limit: { type: 'integer', description: 'How many rows to return. Default 15, maximum 50.' },
        },
      },
      async run(args) {
        const scan = clamp(args.scan, 300, 1, 1000);
        const limit = clamp(args.limit, 15, 1, 50);
        const scanned = await engine.pending(scan);

        return {
          examined: scanned.scanned,
          pending: scanned.pending.length,
          finished: scanned.finished,
          neverReachedOracle: scanned.noLifecycle,
          withoutAClock: scanned.undated,
          showing: Math.min(limit, scanned.pending.length),
          markets: scanned.pending.slice(0, limit).map((p) => ({
            conditionId: p.market.conditionId,
            question: p.market.question,
            lastStep: p.last,
            lifecycle: p.dispute.steps,
            disputeRounds: p.dispute.rounds,
            waited: waited(p.waited),
            waitedMs: p.waited,
            volumeUsd: p.market.volume,
          })),
          limits: [
            ...ALWAYS,
            'a lifecycle that stops short is not the same as a market that is stuck, and this cannot tell them apart',
            `${scanned.undated} pending markets had no usable deadline and are counted rather than sorted as zero`,
          ],
        };
      },
    },
  ];
}

/**
 * What one position did, in a word.
 *
 * A split is its own answer rather than a rounding of one of the other two.
 * UMA hands down 50/50 outcomes, and calling one a loss is wrong on both sides
 * of the market at once.
 */
function result(entry: { resolved: boolean; payout?: number }): 'open' | 'won' | 'lost' | 'split' | 'unknown' {
  if (!entry.resolved) return 'open';
  if (entry.payout === undefined) return 'unknown';
  if (entry.payout === 1) return 'won';
  if (entry.payout === 0) return 'lost';
  return 'split';
}

function winnerRow(w: { address: string; name?: string; bought: number; net: number; spent: number; netSpent: number }) {
  return {
    address: w.address,
    name: w.name,
    tokensBought: w.bought,
    tokensHeldAtSettlement: w.net,
    usdPaid: w.spent,
    // Every winning token redeems for exactly one dollar, so this is a
    // subtraction rather than a model.
    usdGain: w.net - w.netSpent,
  };
}

function tierOf(assessments: Assessment[]): string {
  return assessments.some((a) => a.tier === 'positions+trades') ? 'positions+trades' : 'positions';
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  // Number(null) is 0 and would read as a deliberate zero here, the same way it
  // put every subgraph position on outcome 0.
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required and must be a string`);
  }
  return value.trim();
}

function reply(id: string | number | null, result: unknown): JsonRpcReply {
  return { jsonrpc: '2.0', id, result };
}

function fail(id: string | number | null, code: number, message: string): JsonRpcReply {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export interface ServerInfo {
  name: string;
  version: string;
}

/**
 * Handle one message. Pure, apart from whatever a tool's `run` does.
 *
 * Returns undefined for a notification, which by the JSON-RPC rules gets no
 * reply at all. Writing one back is the most common way to break a client.
 */
export async function dispatch(
  message: JsonRpcMessage,
  tools: McpTool[],
  info: ServerInfo,
): Promise<JsonRpcReply | undefined> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined;

  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return isNotification ? undefined : fail(id, JSON_RPC_ERRORS.invalidRequest, 'not a JSON-RPC 2.0 request');
  }

  switch (message.method) {
    case 'initialize': {
      const asked = message.params?.protocolVersion;
      const version = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
      return reply(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: info,
        instructions:
          'recuse reads the public record behind a Polymarket resolution. Every result carries evidence, '
          + 'caveats and limits fields. Repeat them in any answer you build from this data, and never state '
          + 'a share without the denominator printed beside it. This tool cannot identify insiders, name a '
          + 'wrongdoer, or say who decided a resolution, and answers built on it should not either.',
      });
    }

    // Notifications. No reply, ever, including for ones we do not know.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return undefined;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = message.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(id, JSON_RPC_ERRORS.invalidParams, `no tool named ${String(name)}`);

      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await tool.run(args);
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: false,
        });
      } catch (err) {
        // A tool that failed reports through the result rather than through a
        // protocol error, so the model can read what went wrong and try
        // something else instead of the session dying.
        return reply(id, {
          content: [{ type: 'text', text: `recuse: ${(err as Error).message}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification || message.method.startsWith('notifications/')) return undefined;
      return fail(id, JSON_RPC_ERRORS.methodNotFound, `unsupported method ${message.method}`);
  }
}

/**
 * Split a stream of chunks into whole lines.
 *
 * A pure buffer, because stdin delivers whatever arrived and a message split
 * across two chunks is normal rather than exceptional. Parsing per chunk works
 * on every small test and fails the first time a real payload crosses the pipe
 * buffer.
 */
export function lineSplitter(): (chunk: string) => string[] {
  let buffer = '';
  return (chunk: string) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    return parts.map((l) => l.trim()).filter((l) => l !== '');
  };
}

export interface ServeIo {
  input: AsyncIterable<string | Buffer>;
  write(line: string): void;
}

/**
 * Read messages until the input ends.
 *
 * One JSON object per line, replies written the same way. Nothing else may go
 * to the output stream for the life of the process.
 */
export async function serve(io: ServeIo, tools: McpTool[], info: ServerInfo): Promise<void> {
  const split = lineSplitter();

  for await (const chunk of io.input) {
    for (const line of split(String(chunk))) {
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        io.write(JSON.stringify(fail(null, JSON_RPC_ERRORS.parse, 'invalid JSON')));
        continue;
      }

      if (Array.isArray(message)) {
        io.write(JSON.stringify(fail(null, JSON_RPC_ERRORS.invalidRequest, 'batches are not supported')));
        continue;
      }

      let response: JsonRpcReply | undefined;
      try {
        response = await dispatch(message, tools, info);
      } catch (err) {
        response = fail(message.id ?? null, JSON_RPC_ERRORS.internal, (err as Error).message);
      }

      if (response) io.write(JSON.stringify(response));
    }
  }
}
