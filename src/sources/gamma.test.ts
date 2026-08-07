import { describe, expect, it } from 'vitest';
import { matchesRequest, toMarket } from './gamma.js';

describe('toMarket', () => {
  it('decodes the fields Gamma ships as JSON inside a string', () => {
    const m = toMarket({
      conditionId: '0xabc',
      slug: 'x',
      question: 'q',
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.125", "0.875"]',
      clobTokenIds: '["111", "222"]',
      umaResolutionStatuses: '["proposed", "disputed"]',
    });
    expect(m.outcomes).toEqual(['Yes', 'No']);
    expect(m.outcomePrices).toEqual([0.125, 0.875]);
    expect(m.tokenIds).toEqual(['111', '222']);
    expect(m.resolutionSteps).toEqual(['proposed', 'disputed']);
  });

  it('survives a market with nothing filled in', () => {
    const m = toMarket({});
    expect(m.conditionId).toBe('');
    expect(m.resolutionSteps).toEqual([]);
    expect(m.volume).toBe(0);
  });

  it('does not let one malformed field take down the record', () => {
    const m = toMarket({ conditionId: '0xabc', outcomes: '["Yes", "No"', volumeNum: '1200' });
    expect(m.outcomes).toEqual([]);
    expect(m.volume).toBe(1200);
  });

  it('reads volume from either field name', () => {
    expect(toMarket({ volumeNum: 5 }).volume).toBe(5);
    expect(toMarket({ volume: '7' }).volume).toBe(7);
  });
});

describe('matchesRequest', () => {
  const market = toMarket({ conditionId: '0xAAA', slug: 'zelenskyy-suit' });

  it('matches on condition id regardless of case', () => {
    expect(matchesRequest(market, '0xaaa')).toBe(true);
    expect(matchesRequest(market, '0xAAA')).toBe(true);
  });

  it('matches on slug', () => {
    expect(matchesRequest(market, 'zelenskyy-suit')).toBe(true);
  });

  it('rejects a market Gamma returned after silently dropping the filter', () => {
    // The real failure: asking for the $242M Zelenskyy market and being handed
    // "Xi Jinping out before 2027?" with no error anywhere in the response.
    expect(matchesRequest(market, '0xbbb')).toBe(false);
  });
});
