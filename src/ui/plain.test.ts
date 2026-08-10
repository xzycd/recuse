import { describe, expect, it } from 'vitest';
import { renderRegulars, renderWinners } from './plain.js';
import { detectStyle } from './format.js';
import type { Assessment } from '../types.js';

const style = detectStyle({ colour: false, width: 100 });

const assessment = (over: Partial<Assessment> = {}): Assessment => ({
  market: {
    conditionId: `0x${'a'.repeat(64)}`,
    slug: 'm',
    question: 'Will it happen?',
    volume: 10,
    liquidity: 0,
    closed: true,
    active: false,
    negRisk: false,
    resolutionSteps: ['resolved'],
    tokenIds: ['1', '2'],
    outcomes: ['Yes', 'No'],
    outcomePrices: [1, 0],
  },
  dispute: {
    conditionId: `0x${'a'.repeat(64)}`,
    rounds: 0,
    phase: 'settled',
    contested: false,
    steps: ['resolved'],
  },
  tier: 'catalogue',
  caveats: [],
  pool: 10,
  fetchedAt: '2026-08-10T00:00:00.000Z',
  ...over,
});

describe('winner failure rendering', () => {
  it('does not call an unknown-coverage result an empty winning side', () => {
    const output = renderWinners(assessment({
      tradeIndexCoverage: { status: 'unknown', reason: 'trade index head could not be read' },
    }), [], style);
    expect(output).toContain('the winning side was not read');
    expect(output).toContain('head could not be read');
    expect(output).not.toContain('no winning positions were returned');
  });
});

describe('regular coverage rendering', () => {
  it('keeps every coverage gap visible even when there are no ranked wallets', () => {
    const output = renderRegulars({
      regulars: [], marketsRead: 0, marketsScored: 0, marketsFailed: 1,
      undecided: 2, empty: 3, beyondIndex: 4, coverageUnknown: 5,
      floorLow: 0, floorHigh: 0, floorRaised: 0, wallets: 0,
      namesAsked: 0, namesFailed: 0, positionsDropped: 6,
    }, style);
    expect(output).toContain('1 markets could not be read');
    expect(output).toContain('3 markets had no position');
    expect(output).toContain('4 markets were beyond');
    expect(output).toContain('5 empty readings had unknown');
    expect(output).toContain('6 malformed positions');
  });
});
