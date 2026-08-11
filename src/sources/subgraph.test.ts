import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchTokenPayouts, fetchTokenPositions, fetchWalletPositions, toPosition,
} from './subgraph.js';

const ADDRESS = '0x889e7f0464c72eb8cda1525ebc12b6aaba9d09e0';
const OTHER_ADDRESS = `0x${'b'.repeat(40)}`;
const TOKEN = '34379581789895528560281218239759280237277305372978794324822777438824410172683';
const OTHER_TOKEN = '103864131794756285503734468197278890131080300305704085735435172616220564121629';
const CONDITION = `0x${'c'.repeat(64)}`;

describe('toPosition', () => {
  // Real numbers, from the top buyer of the winning side of the Zelenskyy
  // market. That wallet bought 7,132,806 tokens and holds nothing today,
  // because it redeemed. The holders endpoint cannot see it at all.
  const raw = {
    user: { id: '0x889E7F0464C72eb8CDA1525EbC12b6aABA9D09e0' },
    quantityBought: '7132806000000',
    quantitySold: '106640000000',
    netQuantity: '7026166000000',
    valueBought: '7015571000000',
    valueSold: '105894000000',
    netValue: '6909677000000',
  };

  it('converts six decimal fixed point into tokens', () => {
    const p = toPosition(raw)!;
    expect(p.bought).toBeCloseTo(7_132_806, 0);
    expect(p.net).toBeCloseTo(7_026_166, 0);
    expect(p.netSpent).toBeCloseTo(6_909_677, 0);
  });

  it('lowercases the address so it joins against holder data', () => {
    expect(toPosition(raw)!.address).toBe('0x889e7f0464c72eb8cda1525ebc12b6aaba9d09e0');
  });

  it('keeps netSpent as buys minus sells, checked against the live fields', () => {
    const p = toPosition(raw)!;
    expect(p.spent - 105_894).toBe(p.netSpent);
    // The identity the profit column depends on: every held token on the
    // winning side redeems for one dollar, so gain is net minus netSpent.
    expect(p.net - p.netSpent).toBeCloseTo(116_489, 0);
  });

  it('drops a row with an address it cannot verify', () => {
    expect(toPosition({ ...raw, user: { id: '0xshort' } })).toBeUndefined();
    expect(toPosition({ ...raw, user: undefined })).toBeUndefined();
  });

  it('drops a row that never bought anything', () => {
    expect(toPosition({ ...raw, quantityBought: '0' })).toBeUndefined();
    expect(toPosition({ ...raw, quantityBought: undefined })).toBeUndefined();
  });

  it('drops a row with a missing financial field rather than inventing zero', () => {
    expect(toPosition({ ...raw, netValue: undefined })).toBeUndefined();
    expect(toPosition({ ...raw, valueSold: undefined })).toBeUndefined();
    expect(toPosition({ ...raw, quantitySold: 'not-a-number' })).toBeUndefined();
  });

  it('drops internally inconsistent position arithmetic', () => {
    expect(toPosition({ ...raw, netQuantity: '1' })).toBeUndefined();
    expect(toPosition({ ...raw, netValue: '1' })).toBeUndefined();
  });
});

describe('subgraph response scope', () => {
  afterEach(() => vi.unstubAllGlobals());

  const rawPosition = (over: Record<string, unknown> = {}) => ({
    id: `${ADDRESS}${TOKEN}`,
    user: { id: ADDRESS },
    quantityBought: '2000000',
    quantitySold: '500000',
    netQuantity: '1500000',
    valueBought: '1000000',
    valueSold: '300000',
    netValue: '700000',
    ...over,
  });

  const serve = (data: unknown) => {
    const fetcher = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetcher);
    return fetcher;
  };

  it('requests sold value and accepts an internally scoped token position', async () => {
    const fetcher = serve({ marketPositions: [rawPosition()] });

    const scan = await fetchTokenPositions(TOKEN, { floor: 0, timeoutMs: 100 });

    expect(scan.failed).toBeUndefined();
    expect(scan.positions).toHaveLength(1);
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain('valueSold');
  });

  it('rejects a token query that returns a position for another token', async () => {
    serve({ marketPositions: [rawPosition({ id: `${ADDRESS}${OTHER_TOKEN}` })] });

    const scan = await fetchTokenPositions(TOKEN, { floor: 0, timeoutMs: 100 });

    expect(scan.failed).toMatch(/outside the requested token/);
    expect(scan.positions).toEqual([]);
  });

  it('rejects a position whose entity id contradicts its user', async () => {
    serve({ marketPositions: [rawPosition({ id: `${OTHER_ADDRESS}${TOKEN}` })] });

    const scan = await fetchTokenPositions(TOKEN, { floor: 0, timeoutMs: 100 });

    expect(scan.failed).toMatch(/contradictory position identity/);
    expect(scan.positions).toEqual([]);
  });

  it('does not manufacture the requested wallet into a foreign position', async () => {
    serve({ marketPositions: [rawPosition({ id: `${OTHER_ADDRESS}${TOKEN}`, user: undefined })] });

    const scan = await fetchWalletPositions(ADDRESS, { floor: 0, timeoutMs: 100 });

    expect(scan.failed).toMatch(/outside the requested wallet/);
    expect(scan.positions).toEqual([]);
  });

  it('rejects a payout row outside the requested token set', async () => {
    serve({
      marketDatas: [{
        id: OTHER_TOKEN,
        condition: {
          id: CONDITION,
          payoutNumerators: ['1', '0'],
          payoutDenominator: '1',
          resolutionTimestamp: '1',
        },
      }],
    });

    const scan = await fetchTokenPayouts([TOKEN], { timeoutMs: 100 });

    expect(scan.failed).toMatch(/outside the requested tokens/);
    expect(scan.byToken.size).toBe(0);
  });
});
