// Payroll's statutory lines and settlement by hand (docs/wave3-plan.md step 12b): the ECR line, years of service,
// gratuity, leave encashment and notice pay.
import { describe, expect, it } from 'vitest';
import {
  ecrLine,
  encashment,
  gratuity,
  noticePay,
  serviceYears,
} from '../src/payroll/statutory.js';

const RULE = { minYears: 5, days: 15, divisor: 26, cap: 2000000 };

describe('payroll statutory', () => {
  it('writes an ECR line', () => {
    expect(
      ecrLine({
        uan: '100200300400',
        name: 'Raju Shinde',
        gross: 16200,
        epfWages: 13500,
        epsWages: 13500,
        edliWages: 13500,
        employee: 1620,
        eps: 1125,
        employerEpf: 495,
        ncpDays: 3,
      }),
    ).toBe(
      '100200300400#~#RAJU SHINDE#~#16200#~#13500#~#13500#~#13500#~#1620#~#1125#~#495#~#3#~#0',
    );
  });

  it('counts years of service, more than six months as a year', () => {
    expect(serviceYears('2020-04-01', '2026-09-30')).toEqual({
      completed: 6,
      counted: 6,
      months: 77,
    });
    expect(serviceYears('2021-03-15', '2026-09-30').counted).toBe(5);
    expect(serviceYears('2021-02-10', '2026-09-30').counted).toBe(6);
    expect(serviceYears('2026-04-20', '2026-05-10').months).toBe(0);
  });

  it('works gratuity, encashment and notice', () => {
    // ₹30,000 wages ÷ 26 × 15 days × 6 years = ₹1,03,846.15 → ₹1,03,846.
    expect(
      gratuity({
        wages: 30000,
        joinedOn: '2020-04-01',
        lastDay: '2026-09-30',
        fixedTerm: false,
        rule: RULE,
      }),
    ).toEqual({ years: 6, amount: 103846, eligible: true });
    expect(
      gratuity({
        wages: 30000,
        joinedOn: '2023-04-01',
        lastDay: '2026-09-30',
        fixedTerm: false,
        rule: RULE,
      }).eligible,
    ).toBe(false);
    // A fixed-term employee after one year.
    expect(
      gratuity({
        wages: 26000,
        joinedOn: '2025-04-01',
        lastDay: '2026-09-30',
        fixedTerm: true,
        rule: RULE,
      }),
    ).toEqual({ years: 1, amount: 15000, eligible: true });
    expect(
      gratuity({
        wages: 500000,
        joinedOn: '1990-01-01',
        lastDay: '2026-09-30',
        fixedTerm: false,
        rule: RULE,
      }).amount,
    ).toBe(2000000);
    expect(encashment(12.5, 30000)).toBe(14423);
    expect(noticePay(-15, 60000)).toBe(-30000);
  });
});
