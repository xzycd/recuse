import { describe, expect, it } from 'vitest';
import { assessWallet, classifyTradeIndexCoverage, tokenIdForSide } from './assess.js';
import type { Market } from '../types.js';

const market = (over: Partial<Market> = {}): Market => ({
  conditionId: `0x${'a'.repeat(64)}`,
  slug: 'm',
  question: 'q',
  volume: 1,
  liquidity: 1,
  closed: true,
  active: false,
  negRisk: false,
  closedTime: '2026-01-01T00:00:00.000Z',
  resolutionSteps: ['resolved'],
  tokenIds: ['11', '22'],
  outcomes: ['Yes', 'No'],
  outcomePrices: [1, 0],
  ...over,
});

describe('trade index coverage', () => {
  it('distinguishes a covered empty result from a market beyond the index', () => {
    expect(classifyTradeIndexCoverage(market(), { lastTradeAt: '2026-01-02T00:00:00.000Z' }))
      .toEqual({ status: 'covered', lastTradeAt: '2026-01-02T00:00:00.000Z' });
    expect(classifyTradeIndexCoverage(market(), { lastTradeAt: '2025-12-31T00:00:00.000Z' }))
      .toEqual({ status: 'beyond', lastTradeAt: '2025-12-31T00:00:00.000Z' });
  });

  it('never treats an unread head or missing market clock as covered', () => {
    expect(classifyTradeIndexCoverage(market(), { failed: 'timeout' }).status).toBe('unknown');
    expect(classifyTradeIndexCoverage(
      market({ closedTime: undefined, umaEndDate: undefined, endDate: undefined }),
      { lastTradeAt: '2026-01-02T00:00:00.000Z' },
    ).status).toBe('unknown');
  });
});

describe('tokenIdForSide', () => {
  it('keeps token and outcome indices aligned when one token is invalid', () => {
    const m = market({ tokenIds: [undefined, '22'] });
    expect(tokenIdForSide(m, 'YES')).toBeUndefined();
    expect(tokenIdForSide(m, 'NO')).toBe('22');
  });

  it('uses explicit labels when the outcomes are reversed', () => {
    const m = market({ outcomes: ['No', 'Yes'] });
    expect(tokenIdForSide(m, 'YES')).toBe('22');
    expect(tokenIdForSide(m, 'NO')).toBe('11');
  });
});

describe('assessWallet input', () => {
  it('rejects a malformed identity before making any source request', async () => {
    await expect(assessWallet('not-a-wallet')).rejects.toThrow(/20-byte address/);
  });
});
