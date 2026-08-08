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
    return id === 'missing' ? undefined : assessment({
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
      'contested_markets', 'market_record', 'winning_side', 'wallet_record', 'resolution_queue',
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
    for (const name of ['contested_markets', 'market_record', 'winning_side', 'wallet_record', 'resolution_queue']) {
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
