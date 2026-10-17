// Contract labour's arithmetic by hand (docs/wave3-plan.md step 13): a month's wages with overtime at twice the
// ordinary rate, the shortfall against the minimum wage, and a licence's days left.
import { describe, expect, it } from 'vitest';
import { complianceReasons, licenceState, wageLine } from '../src/labour/labour-rules.js';

describe('labour rules', () => {
  it('works a month with overtime and the minimum wage', () => {
    // 20 days and 2 half days at ₹450: 21 days, ₹9,450; 6 hours at twice ₹56.25: ₹675. Minimum ₹500: ₹50 a day and
    // ₹12.50 an overtime hour short, ₹1,050 + ₹75.
    expect(
      wageLine({
        workerId: 'w',
        name: 'Sunita',
        skill: 'unskilled',
        rate: 450,
        present: 20,
        halfDays: 2,
        overtimeHours: 6,
        minimum: 500,
      }),
    ).toMatchObject({
      days: 21,
      wages: 9450,
      overtime: 675,
      gross: 10125,
      shortfall: 1125,
      // docs/wave8-plan.md step 8c.1: PF 12% of ₹9,450 each side; ESI on ₹10,125 at 0.75% and 3.25%, rounded up.
      pfEmployee: 1134,
      pfEmployer: 1134,
      esiEmployee: 76,
      esiEmployer: 330,
    });
    expect(
      wageLine({
        workerId: 'w',
        name: 'R',
        skill: 'skilled',
        rate: 750,
        present: 1,
        halfDays: 0,
        overtimeHours: 0,
        minimum: null,
      }),
    ).toMatchObject({ gross: 750, shortfall: 0, minimum: null });
  });

  it("words what holds a labour contractor's bill", () => {
    expect(
      complianceReasons({
        licenceValidTo: '2026-09-30',
        on: '2026-10-05',
        belowMinimum: [{ month: '2026-09', site: 'Washim', shortfall: '1125.00' }],
        unpaid: [{ month: '2026-09', kind: 'pf', due: '2268.00', paid: '0.00' }],
      }),
    ).toEqual([
      'The contract labour licence lapsed on 2026-09-30.',
      '2026-09 at Washim: workers paid ₹1125.00 below the minimum wage.',
      '2026-09: PF of ₹2268.00 due, ₹0.00 shown paid.',
    ]);
  });

  it("tells a licence's days left", () => {
    expect(licenceState('2026-10-30', '2026-10-12')).toEqual({
      daysLeft: 18,
      lapsed: false,
      nearing: true,
    });
    expect(licenceState('2027-01-30', '2026-10-12').nearing).toBe(false);
    expect(licenceState('2026-10-01', '2026-10-12')).toMatchObject({ lapsed: true });
    expect(licenceState(null, '2026-10-12').daysLeft).toBeNull();
  });
});
