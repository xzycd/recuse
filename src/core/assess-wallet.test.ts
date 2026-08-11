import { beforeEach, describe, expect, it, vi } from 'vitest';

const sources = vi.hoisted(() => ({
  displayNames: vi.fn(),
  indexHead: vi.fn(),
  marketsByCondition: vi.fn(),
  tokenPayouts: vi.fn(),
  walletPositions: vi.fn(),
  walletTrades: vi.fn(),
}));

vi.mock('../sources/dataapi.js', () => ({
  fetchDisplayNames: sources.displayNames,
  fetchHolders: vi.fn(),
}));

vi.mock('../sources/gamma.js', () => ({
  fetchMarketsByCondition: sources.marketsByCondition,
}));

vi.mock('../sources/subgraph.js', () => ({
  fetchIndexHead: sources.indexHead,
  fetchTokenPayouts: sources.tokenPayouts,
  fetchTokenPositions: vi.fn(),
  fetchWalletPositions: sources.walletPositions,
}));

vi.mock('../sources/trades.js', () => ({
  fetchMarketTrades: vi.fn(),
  fetchWalletTrades: sources.walletTrades,
}));

vi.mock('../sources/chain.js', () => ({ chainNote: () => 'no chain source configured' }));

import type { Market } from '../types.js';
import { assessWallet } from './assess.js';

const ADDRESS = `0x${'a'.repeat(40)}`;
const OLD_CONDITION = `0x${'b'.repeat(64)}`;
const NEW_CONDITION = `0x${'c'.repeat(64)}`;
const OLD_TOKEN = '11';
const NEW_TOKEN = '22';

function market(conditionId: string, tokenId: string): Market {
  return {
    conditionId,
    slug: `market-${tokenId}`,
    question: `market ${tokenId}`,
    volume: 1,
    liquidity: 1,
    closed: true,
    active: false,
    negRisk: false,
    resolutionSteps: ['resolved'],
    tokenIds: [tokenId, `${tokenId}0`],
    outcomes: ['Yes', 'No'],
    outcomePrices: [1, 0],
  };
}

function indexPosition(tokenId = OLD_TOKEN) {
  return { tokenId, bought: 10, net: 10, spent: 4, netSpent: 4, address: ADDRESS };
}

function trade(tokenId = NEW_TOKEN, conditionId = NEW_CONDITION) {
  return {
    address: ADDRESS,
    tokenId,
    conditionId,
    side: 'BUY' as const,
    size: 20,
    price: 0.4,
  };
}

function serveMarket(conditionId: string, tokenId: string): void {
  const one = market(conditionId, tokenId);
  sources.tokenPayouts.mockResolvedValue({
    byToken: new Map([[tokenId, { conditionId, numerators: [1, 0], denominator: 1 }]]),
    asked: 1,
    found: 1,
    invalid: 0,
  });
  sources.marketsByCondition.mockResolvedValue({
    markets: new Map([[conditionId, one]]),
    missing: [],
    failed: 0,
  });
}

describe('wallet trade-source selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sources.displayNames.mockResolvedValue({ byAddress: new Map(), failed: 0 });
    sources.indexHead.mockResolvedValue({ lastTradeAt: '2026-01-05T22:05:45.000Z' });
    sources.walletPositions.mockResolvedValue({
      positions: [indexPosition()], floor: 1, truncated: false, dropped: 0,
    });
    sources.walletTrades.mockResolvedValue({
      trades: [trade()], floor: 0, truncated: false, dropped: 0,
    });
  });

  it('uses the current log even when the old index returned positions', async () => {
    serveMarket(NEW_CONDITION, NEW_TOKEN);

    const ledger = await assessWallet(ADDRESS);

    expect(ledger.entries.map((entry) => entry.conditionId)).toEqual([NEW_CONDITION]);
    expect(ledger.caveats.join(' ')).toContain('rebuilt from 1 trades in the live log');
    expect(sources.tokenPayouts).toHaveBeenCalledWith([NEW_TOKEN]);
  });

  it('falls back to the dated index when the current log refuses', async () => {
    sources.walletTrades.mockResolvedValue({
      trades: [], floor: 0, truncated: false, dropped: 0, failed: 'unavailable',
    });
    serveMarket(OLD_CONDITION, OLD_TOKEN);

    const ledger = await assessWallet(ADDRESS);

    expect(ledger.entries.map((entry) => entry.conditionId)).toEqual([OLD_CONDITION]);
    expect(ledger.caveats.join(' ')).toContain(
      'the live trade log was not used: unavailable; this record uses the older trade index',
    );
  });

  it('does not let a complete empty log erase a contradictory index record', async () => {
    sources.walletTrades.mockResolvedValue({
      trades: [], floor: 0, truncated: false, dropped: 0,
    });
    serveMarket(OLD_CONDITION, OLD_TOKEN);

    const ledger = await assessWallet(ADDRESS);

    expect(ledger.entries.map((entry) => entry.conditionId)).toEqual([OLD_CONDITION]);
    expect(ledger.caveats.join(' ')).toContain('empty history that contradicted the index');
  });

  it('returns an unread record when neither source supplies positions', async () => {
    sources.walletPositions.mockResolvedValue({
      positions: [], floor: 0, truncated: false, dropped: 0, failed: 'index unavailable',
    });
    sources.walletTrades.mockResolvedValue({
      trades: [], floor: 0, truncated: false, dropped: 0, failed: 'log unavailable',
    });

    const ledger = await assessWallet(ADDRESS);

    expect(ledger.entries).toEqual([]);
    expect(ledger.caveats.join(' ')).toContain('positions could not be read');
    expect(sources.tokenPayouts).not.toHaveBeenCalled();
    expect(sources.marketsByCondition).not.toHaveBeenCalled();
  });
});
