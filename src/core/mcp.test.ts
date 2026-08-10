/**
 * The protocol, tested against a fake engine.
 *
 * Two groups of cases, and the second one is the point of the file. The first
 * checks the wire format, where the failure mode is a client that hangs up. The
 * second checks that the guardrails travel as data: a share never leaves this
 * surface without its denominator, every payload carries what it cannot
 * support, and the tool descriptions say so too. Those are the assertions that
 * fail if someone later trims a payload for size, which is exactly the change
 * that would look harmless.
 */

import { describe, expect, it } from 'vitest';
import { dispatch, lineSplitter, recuseTools, serve, type Engine } from './mcp.js';
import type { Assessment, Market } from '../types.js';

const INFO = { name: 'recuse', version: '0.6.0' };

const market = (over: Partial<Market> = {}): Market => ({
  conditionId: '0xabc',
  slug: 'will-x-happen',
  question: 'Will X happen?',
  outcomes: ['Yes', 'No'],
  tokenIds: ['1', '2'],
  prices: [0, 1],
  volume: 242_200_000,
  resolutionSteps: ['proposed', 'disputed', 'proposed', 'resolved'],
  closed: true,
  ...over,
} as Market);

const assessment = (over: Partial<Assessment> = {}): Assessment => ({
  market: market(),
  dispute: {
    conditionId: '0xabc',
    rounds: 5,
    phase: 'settled',
    contested: true,
    steps: ['proposed', 'disputed', 'proposed', 'resolved'],
  },
  concentration: {
    side: 'Yes',
    meaning: 'lost',
    basis: 'balances',
    topN: 5,
    topShare: 0.33,
    topSize: 17_100_000,
    totalSize: 52_100_000,
    holderCount: 100,
  },
  tier: 'positions',
  caveats: [],
  pool: 242_200_000,
  fetchedAt: '2026-08-08T00:00:00.000Z',
  ...over,
} as Assessment);

const engine: Engine = {
  async contested() {
    return { assessments: [assessment()], scanned: 400, contested: 30 };
  },
  async market(id) {
    return id === 'missing' ? undefined : assessment();
  },
  async winners(id) {
    if (id === 'missing') return undefined;
    // Past the index and nothing else could read it: the one case where an
    // empty winners list is a statement about coverage and not about people.
    if (id === 'beyond') {
      return assessment({ winners: [], tradeIndexEndsAt: '2026-01-05T22:05:45.000Z' });
    }
    // Past the index, and the trade log answered anyway.
    if (id === 'from-log') {
      return assessment({
        winners: [{ address: '0xd99f', bought: 18_600_000, net: 18_600_000, spent: 18_500_000, netSpent: 18_500_000 }],
        tradeIndexEndsAt: '2026-01-05T22:05:45.000Z',
        tradeLog: { floor: 5000, read: 5392, truncated: false },
      });
    }
    return assessment({
      winnerConcentration: {
        side: 'No', meaning: 'won', basis: 'trades', topN: 5, topShare: 0.52,
        topSize: 30_500_000, totalSize: 58_900_000, holderCount: 20, floor: 1000,
      },
      winners: [
        { address: '0x5bff', name: '0943', bought: 49_700_000, net: 34_000_000, spent: 18_700_000, netSpent: 18_700_000 },
      ],
      tier: 'positions+trades',
    });
  },
  async wallet(address) {
    return {
      address, entries: [], won: 29, lost: 9, split: 0, open: 1,
      gain: 859_000, contestedGain: 275_000, contested: 11, caveats: [],
    };
  },
  async pending() {
    return { pending: [], scanned: 300, noLifecycle: 191, finished: 83, undated: 0 };
  },
  async regulars() {
    return {
      regulars: [
        {
          address: '0xc8ab', name: 'ArmageddonRewardsBilly', wins: 11,
          tokens: 2_900_000, paid: 2_867_000, gain: 33_000,
          markets: ['will-x-happen', 'will-y-happen'],
        },
        {
          address: '0x24c8', wins: 9, tokens: 10_200_000, paid: 9_906_000, gain: 294_000,
          markets: ['will-x-happen'],
        },
      ],
      marketsRead: 38, marketsScored: 20, marketsFailed: 2, undecided: 4, empty: 18,
      beyondIndex: 25, indexHead: '2026-01-05T22:05:45.000Z',
      fromLog: 21, fromLogPastIndex: 21, logCut: 3, logFloorLow: 500, logFloorHigh: 5_000,
      floorLow: 1_000, floorHigh: 100_000, floorRaised: 6,
      wallets: 494, namesAsked: 1, namesFailed: 0,
    };
  },
};

const tools = recuseTools(engine);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await dispatch(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
    tools, INFO,
  );
  const result = res?.result as { content: Array<{ text: string }>; isError: boolean };
  return { isError: result.isError, payload: JSON.parse(result.content[0]!.text) };
};

describe('the wire format', () => {
  it('answers initialize with a version it speaks', async () => {
    const res = await dispatch(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      tools, INFO,
    );
    const result = res?.result as { protocolVersion: string; serverInfo: unknown };
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual(INFO);
  });

  it('falls back to the newest version it speaks when asked for one it does not', async () => {
    const res = await dispatch(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
      tools, INFO,
    );
    expect((res?.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
  });

  it('never replies to a notification, which is what hangs a client', async () => {
    expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }, tools, INFO)).toBeUndefined();
    // Including one it has never heard of. A reply carrying no id is worse
    // than silence.
    expect(await dispatch({ jsonrpc: '2.0', method: 'notifications/whatever' }, tools, INFO)).toBeUndefined();
  });

  it('reports an unknown method rather than staying silent on a request', async () => {
    const res = await dispatch({ jsonrpc: '2.0', id: 7, method: 'resources/list' }, tools, INFO);
    expect(res?.error?.code).toBe(-32601);
    expect(res?.id).toBe(7);
  });

  it('lists every tool with a schema', async () => {
    const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, tools, INFO);
    const listed = (res?.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(listed.map((t) => t.name)).toEqual([
      'contested_markets', 'market_record', 'winning_side', 'repeat_winners', 'wallet_record',
      'resolution_queue',
    ]);
    for (const t of listed) expect(t.inputSchema).toBeTruthy();
  });

  it('reports a tool failure in the result, so the session survives it', async () => {
    const res = await dispatch(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'market_record', arguments: {} } },
      tools, INFO,
    );
    const result = res?.result as { content: Array<{ text: string }>; isError: boolean };
    // A missing argument is the model's mistake to correct, not a reason to
    // drop the connection, so it comes back as a readable result.
    expect(res?.error).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('market is required');
  });

  it('rejects an unknown tool at the protocol level', async () => {
    const res = await dispatch(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'drop_table' } },
      tools, INFO,
    );
    expect(res?.error?.code).toBe(-32602);
  });
});

describe('lineSplitter', () => {
  it('joins a message split across two chunks', () => {
    // stdin delivers whatever arrived. Parsing per chunk passes every small
    // test and fails the first time a payload crosses the pipe buffer.
    const split = lineSplitter();
    expect(split('{"a":')).toEqual([]);
    expect(split('1}\n')).toEqual(['{"a":1}']);
  });

  it('returns several messages from one chunk', () => {
    const split = lineSplitter();
    expect(split('{"a":1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });
});

describe('serve', () => {
  it('answers a handshake and writes one line per reply', async () => {
    const written: string[] = [];
    await serve(
      {
        input: (async function* () {
          yield '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n';
          yield '{"jsonrpc":"2.0","method":"notifications/initialized"}\n';
          yield '{"jsonrpc":"2.0","id":2,"method":"ping"}\n';
        })(),
        write: (line) => written.push(line),
      },
      tools, INFO,
    );

    // Two requests and one notification produce two replies, not three.
    expect(written).toHaveLength(2);
    expect(written.map((l) => JSON.parse(l).id)).toEqual([1, 2]);
    for (const line of written) expect(line).not.toContain('\n');
  });

  it('answers unparseable input without dying', async () => {
    const written: string[] = [];
    await serve(
      {
        input: (async function* () {
          yield 'not json\n{"jsonrpc":"2.0","id":9,"method":"ping"}\n';
        })(),
        write: (line) => written.push(line),
      },
      tools, INFO,
    );
    expect(JSON.parse(written[0]!).error.code).toBe(-32700);
    expect(JSON.parse(written[1]!).id).toBe(9);
  });
});

describe('what the payload refuses to leave out', () => {
  it('never states a share without the denominator in the same field', async () => {
    const { payload } = await call('market_record', { market: '0xabc' });
    // The single most likely thing to be summarised away is the count behind
    // the percentage, so the reading is one string that cannot be split.
    expect(payload.losingSide.reading).toBe('top 5 of 100 held 33.0%');
    expect(payload.losingSide.holderCount).toBe(100);
    expect(payload.losingSide.holderCountIsFloor).toBe(true);
  });

  it('carries the limits on every tool, not just the alarming ones', async () => {
    for (const name of ['contested_markets', 'market_record', 'winning_side', 'repeat_winners', 'wallet_record', 'resolution_queue']) {
      const args = name === 'wallet_record' ? { address: '0x1' }
        : name.includes('market_record') || name === 'winning_side' ? { market: '0xabc' } : {};
      const { payload } = await call(name, args);
      expect(payload.limits.join(' ')).toMatch(/tallies, not intent/);
      expect(payload.limits.join(' ')).toMatch(/no proposer, disputer or voter is read/);
    }
  });

  it('says how many scanned markets are missing from the contested list', async () => {
    const { payload } = await call('contested_markets');
    expect(payload.scanned).toBe(400);
    expect(payload.contested).toBe(30);
    expect(payload.limits.join(' ')).toContain('370 of 400 markets scanned were never contested');
  });

  it('reports the floor the subgraph needed, because it changes what was read', async () => {
    const { payload } = await call('winning_side', { market: '0xabc' });
    expect(payload.concentration.positionsBelowTokensNotRequested).toBe(1000);
    expect(payload.limits.join(' ')).toContain('below 1000 tokens were never requested');
  });

  it('says the winning side was read when the log read it, and by what', async () => {
    const { payload } = await call('winning_side', { market: '0xabc' });
    // The index reaching this market is the ordinary case, and the consumer
    // still gets told which source it stood on rather than having to infer it.
    expect(payload.winningSideRead).toBe(true);
    expect(payload.readFrom).toBe('trade index');
    expect(payload.tradeIndexEndsAt).toBeUndefined();
  });

  it('separates a side nothing read from a side the log read instead', async () => {
    // These two used to be one field. `winningSideRead: false` was set from the
    // index falling short alone, which stopped being the same statement the
    // moment something else could answer past it.
    const unread = await call('winning_side', { market: 'beyond' });
    expect(unread.payload.winningSideRead).toBe(false);
    expect(unread.payload.limits.join(' ')).toContain('never means nobody won');

    const rescued = await call('winning_side', { market: 'from-log' });
    expect(rescued.payload.winningSideRead).toBe(true);
    expect(rescued.payload.readFrom).toBe('trade log');
    // The terms travel as fields, not only as prose, because a consumer parses
    // fields and a summariser drops sentences.
    expect(rescued.payload.tradeLog).toEqual({ floor: 5000, read: 5392, truncated: false });
    expect(rescued.payload.limits.join(' ')).toContain('rebuilt from 5392 trades in the log');
  });

  it('never states a win count without the markets it is out of', async () => {
    const { payload } = await call('repeat_winners');
    // `won 11` is the number a summary keeps. The denominator has to be
    // attached to it, not sitting in a sibling field it can drop.
    expect(payload.repeatWinners[0].reading).toBe('won 11 of 20 contested markets scored');
    expect(payload.repeatWinners[0].marketsScored).toBe(20);
    expect(payload.marketsScored).toBe(20);
  });

  it('separates markets it could not read from markets nobody won', async () => {
    const { payload } = await call('repeat_winners');
    const caveats = payload.caveats.join(' ');
    // The distinction the whole project turns on. Folding these into the
    // denominator would put a confident number over ground never covered.
    expect(caveats).toContain('2 contested markets could not be read');
    expect(caveats).toContain('18 markets returned no position above the floor');
    expect(caveats).toContain('4 contested markets have not settled');
  });

  it('reports the floor range, not just the highest one it hit', async () => {
    const { payload } = await call('repeat_winners');
    expect(payload.caveats.join(' ')).toContain('under 1000 tokens were never requested');
    expect(payload.caveats.join(' ')).toContain('6 markets needed a floor up to 100000');
  });

  it('says which markets were never reached, not just which were empty', async () => {
    const { payload } = await call('repeat_winners');
    const caveats = payload.caveats.join(' ');
    // The store answers a market past its indexing head with an empty list and
    // HTTP 200, exactly as it answers a market nobody traded. Collapsing the
    // two is how two thirds of the contested set read as markets nobody won.
    expect(caveats).toContain('25 contested markets closed after the trade index stops at 2026-01-05');
    // 21 of those 25 were rescued from the trade log, and the four that were
    // not are their own sentence. Reporting only the 25 would understate the
    // coverage and reporting only the 21 would hide the hole.
    expect(caveats).toContain('21 of those were rebuilt from the trade log');
    expect(caveats).toContain('4 contested markets were not read by anything');
  });

  it('never lets a partial trade log pass as a cumulative total', async () => {
    const { payload } = await call('repeat_winners');
    const caveats = payload.caveats.join(' ');
    // A floor drops small trades and names its size. This drops the older half
    // of a market and keeps the recent one, so the totals on those rows are not
    // cumulative at all, which is a different and worse statement.
    expect(caveats).toContain('trades of $500 or more');
    expect(caveats).toContain('3 markets had more trades than the log will page to');
  });

  it('says an unread name is unread rather than letting it read as unnamed', async () => {
    const { payload } = await call('repeat_winners');
    expect(payload.caveats.join(' ')).toContain('unread rather than unnamed');
  });

  it('refuses to let a win count imply anything about the resolution', async () => {
    const { payload } = await call('repeat_winners');
    const limits = payload.limits.join(' ');
    expect(limits).toContain('not over every market a wallet has ever traded');
    expect(limits).toContain('sold before resolution is not counted');
  });

  it('reports a miss as a miss rather than as the first row of something else', async () => {
    const { payload } = await call('market_record', { market: 'missing' });
    expect(payload.found).toBe(false);
    expect(payload.limits.join(' ')).toContain('reported as a miss');
  });

  it('tells the model to repeat the caveats, in every description', () => {
    for (const tool of tools) {
      expect(tool.description).toContain('Repeat the caveats and limits fields');
    }
  });

  it('clamps a limit instead of trusting it, and does not read null as zero', async () => {
    const { payload } = await call('contested_markets', { limit: 9999 });
    expect(payload.showing).toBe(1);
    const withNull = await call('contested_markets', { limit: null });
    expect(withNull.payload.showing).toBe(1);
  });
});
