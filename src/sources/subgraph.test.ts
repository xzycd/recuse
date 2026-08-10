import { describe, expect, it } from 'vitest';
import { toPosition } from './subgraph.js';

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
    expect(p.spent - 106_640 * 0 - p.netSpent).toBeCloseTo(105_894, 0);
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
    expect(toPosition({ ...raw, quantitySold: 'not-a-number' })).toBeUndefined();
  });

  it('drops internally inconsistent position arithmetic', () => {
    expect(toPosition({ ...raw, netQuantity: '1' })).toBeUndefined();
  });
});
