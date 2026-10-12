// Depreciation by hand (docs/wave3-plan.md step 9): straight line for a part year split by a transfer, WDV across a
// year end, the residual floor, and an Income Tax block with a half-rate addition and a sale.
import { describe, expect, it } from 'vitest';
import { charge, taxBlock, wdvRate } from '../src/accounts/depreciation.js';

describe('depreciation', () => {
  const slm = {
    cost: '100000',
    charged: '0',
    yearOpening: '100000',
    residualPct: '5',
    lifeYears: '10',
    method: 'slm' as const,
    moves: [{ from: '2026-04-01', projectId: 'p1' }],
  };

  it('charges straight line by the day, split where the asset moved', () => {
    // (1,00,000 − 5,000) ÷ 10 = 9,500 a year.
    expect(charge(slm, '2026-04-01', '2027-03-31')).toEqual([
      { from: '2026-04-01', to: '2027-03-31', projectId: 'p1', amount: '9500.00' },
    ]);
    // Moved to p2 on 1 January: 92 days (2,394.52) and 90 days (2,342.47).
    expect(
      charge(
        { ...slm, moves: [...slm.moves, { from: '2027-01-01', projectId: 'p2' }] },
        '2026-10-01',
        '2027-03-31',
      ),
    ).toEqual([
      { from: '2026-10-01', to: '2026-12-31', projectId: 'p1', amount: '2394.52' },
      { from: '2027-01-01', to: '2027-03-31', projectId: 'p2', amount: '2342.47' },
    ]);
  });

  it('charges WDV on each year opening value, and never below the residual', () => {
    expect(wdvRate('5', '8')).toBe('0.3123');
    const car = {
      ...slm,
      cost: '1000000',
      yearOpening: '1000000',
      lifeYears: '8',
      method: 'wdv' as const,
    };
    // 10,00,000 × 31.23% = 3,12,300; then 6,87,700 × 31.23% = 2,14,768.71.
    expect(charge(car, '2026-04-01', '2028-03-31').map((x) => x.amount)).toEqual([
      '312300.00',
      '214768.71',
    ]);
    // Cost 1,000, 940 charged, residual 50: only 10 left.
    expect(
      charge({ ...slm, cost: '1000', charged: '940' }, '2026-04-01', '2027-03-31').map(
        (x) => x.amount,
      ),
    ).toEqual(['10.00']);
  });

  it('works a tax block with a half-rate addition and a sale', () => {
    // 15% on 5,00,000 + 2,00,000 − 50,000 = 97,500; half of 15% on 1,00,000 = 7,500.
    expect(
      taxBlock({
        rate: '15',
        opening: '500000',
        additions: [
          { cost: '200000', daysUsed: 200 },
          { cost: '100000', daysUsed: 90 },
        ],
        sales: '50000',
      }),
    ).toEqual({
      opening: '500000.00',
      additionsFull: '200000.00',
      additionsHalf: '100000.00',
      sales: '50000.00',
      depreciation: '105000.00',
      closing: '645000.00',
    });
  });
});
