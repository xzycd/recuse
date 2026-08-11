import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Market } from '../types.js';
import { fetchDisplayNames, fetchHolders } from './dataapi.js';

const ADDRESS = `0x${'a'.repeat(40)}`;
const OTHER_ADDRESS = `0x${'b'.repeat(40)}`;
const CONDITION = `0x${'c'.repeat(64)}`;
const YES = '111';
const NO = '222';

function market(tokenIds: Array<string | undefined> = [YES, NO]): Market {
  return {
    conditionId: CONDITION,
    slug: 'one-market',
    question: 'one market?',
    volume: 1,
    liquidity: 1,
    closed: true,
    active: false,
    negRisk: false,
    resolutionSteps: ['resolved'],
    tokenIds,
    outcomes: ['Yes', 'No'],
    outcomePrices: [1, 0],
  };
}

function serve(body: unknown): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('holder response scope', () => {
  it('does not turn an invalid condition id into a successful empty reading', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await expect(fetchHolders({ ...market(), conditionId: '' })).rejects.toThrow(/no usable condition id/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not ask when Gamma supplied no token ids to verify against', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await expect(fetchHolders(market([]))).rejects.toThrow(/no usable outcome token ids/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects a holder whose repeated asset disagrees with its token group', async () => {
    serve([{
      token: YES,
      holders: [{ proxyWallet: ADDRESS, asset: NO, outcomeIndex: 0, amount: 10 }],
    }]);

    await expect(fetchHolders(market())).rejects.toThrow(/wrong token/);
  });

  it('rejects an ambiguous market that repeats one token on two outcomes', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);

    await expect(fetchHolders(market([YES, YES]))).rejects.toThrow(/duplicate outcome token ids/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects amounts that would poison concentration arithmetic', async () => {
    serve([{
      token: YES,
      holders: [{
        proxyWallet: ADDRESS,
        asset: YES,
        outcomeIndex: 0,
        amount: Number.MAX_VALUE,
      }],
    }]);

    await expect(fetchHolders(market())).rejects.toThrow(/safe numeric range/);
  });

  it('rejects a holder page larger than the requested limit', async () => {
    serve([{
      token: YES,
      holders: Array.from({ length: 3 }, () => ({
        proxyWallet: ADDRESS,
        asset: YES,
        outcomeIndex: 0,
        amount: 1,
      })),
    }]);

    await expect(fetchHolders(market(), 2)).rejects.toThrow(/exceeded the requested holder limit/);
  });

  it('accepts a holder only under a verified market token', async () => {
    serve([{
      token: YES,
      holders: [{ proxyWallet: ADDRESS, asset: YES, outcomeIndex: 0, amount: 10 }],
    }]);

    await expect(fetchHolders(market())).resolves.toMatchObject([
      { address: ADDRESS, side: 'YES', size: 10 },
    ]);
  });
});

describe('display-name response scope', () => {
  it('counts an HTTP-200 object as a failed lookup instead of an unnamed wallet', async () => {
    serve({ error: 'filter was not applied' });

    const result = await fetchDisplayNames([ADDRESS]);
    expect(result.byAddress.size).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('does not attach a name returned for another wallet', async () => {
    serve([{ proxyWallet: OTHER_ADDRESS, name: 'not yours' }]);

    const result = await fetchDisplayNames([ADDRESS]);
    expect(result.byAddress.size).toBe(0);
    expect(result.failed).toBe(1);
  });

  it('attaches a name only after verifying the response wallet', async () => {
    serve([{ proxyWallet: ADDRESS.toUpperCase(), name: 'verified name' }]);

    const result = await fetchDisplayNames([ADDRESS]);
    expect(result.byAddress.get(ADDRESS)).toBe('verified name');
    expect(result.failed).toBe(0);
  });
});
