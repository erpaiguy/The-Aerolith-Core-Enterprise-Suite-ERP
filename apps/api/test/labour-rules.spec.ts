// Contract labour's arithmetic by hand (docs/wave3-plan.md step 13): a month's wages with overtime at twice the
// ordinary rate, the shortfall against the minimum wage, and a licence's days left.
import { describe, expect, it } from 'vitest';
import { licenceState, wageLine } from '../src/labour/labour-rules.js';

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
    ).toMatchObject({ days: 21, wages: 9450, overtime: 675, gross: 10125, shortfall: 1125 });
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
