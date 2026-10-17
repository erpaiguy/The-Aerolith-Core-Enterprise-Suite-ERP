// Payroll's statutory arithmetic by hand (docs/wave3-plan.md step 12): wages under the Code on Wages, PF either side
// of the ceiling, ESI rounded up, Maharashtra's professional tax, income tax under both regimes, and a month's TDS.
import { describe, expect, it } from 'vitest';
import {
  bonus,
  declaredDeductions,
  instalment,
  overtimePay,
  esi,
  esiPeriodStart,
  incomeTax,
  monthlyTds,
  monthsLeftInYear,
  pf,
  professionalTax,
  wagesOf,
  type TaxRegime,
} from '../src/payroll/payroll-rules.js';

const PF = { employeeRate: 12, employerRate: 12, epsRate: 8.33, edliRate: 0.5, adminRate: 0.5 };
const NEW: TaxRegime = {
  slabs: [
    { upTo: 400000, rate: 0 },
    { upTo: 800000, rate: 5 },
    { upTo: 1200000, rate: 10 },
    { upTo: 1600000, rate: 15 },
    { upTo: 2000000, rate: 20 },
    { upTo: 2400000, rate: 25 },
    { upTo: null, rate: 30 },
  ],
  standardDeduction: 75000,
  rebateUpTo: 1200000,
  marginalRelief: true,
  cess: 4,
};
const OLD: TaxRegime = {
  slabs: [
    { upTo: 250000, rate: 0 },
    { upTo: 500000, rate: 5 },
    { upTo: 1000000, rate: 20 },
    { upTo: null, rate: 30 },
  ],
  standardDeduction: 50000,
  rebateUpTo: 500000,
  marginalRelief: false,
  cess: 4,
};

describe('payroll rules', () => {
  it('counts allowances beyond half the pay as wages', () => {
    const pay = [
      { amount: 20000, inWages: true },
      { amount: 16000, inWages: false },
      { amount: 14000, inWages: false },
    ];
    // ₹30,000 of ₹50,000 left out is ₹5,000 over half: wages ₹25,000.
    expect(wagesOf(pay, { excludedCap: 50 })).toBe(25000);
    expect(
      wagesOf(
        [
          { amount: 30000, inWages: true },
          { amount: 20000, inWages: false },
        ],
        { excludedCap: 50 },
      ),
    ).toBe(30000);
  });

  it('works PF on the ceiling or on actual wages', () => {
    expect(pf(25000, { ...PF, ceiling: 15000 })).toEqual({
      epfWages: 15000,
      epsWages: 15000,
      edliWages: 15000,
      employee: 1800,
      eps: 1250,
      employerEpf: 550,
      edli: 75,
      admin: 75,
    });
    // The ₹25,000 ceiling: 8.33% of it is ₹2,082.50, to the rupee ₹2,083.
    expect(pf(25000, { ...PF, ceiling: 25000 })).toMatchObject({
      employee: 3000,
      eps: 2083,
      employerEpf: 917,
    });
    expect(pf(40000, { ...PF, ceiling: 15000 }, true)).toMatchObject({
      epfWages: 40000,
      employee: 4800,
      eps: 1250,
      employerEpf: 3550,
      edli: 75,
      admin: 200,
    });
  });

  it('rounds ESI up and knows its contribution periods', () => {
    const rule = { ceiling: 21000, employeeRate: 0.75, employerRate: 3.25 };
    expect(esi(18000, rule)).toEqual({ employee: 135, employer: 585 });
    expect(esi(17333.33, rule)).toEqual({ employee: 130, employer: 564 });
    expect(esiPeriodStart('2026-09')).toBe('2026-04');
    expect(esiPeriodStart('2026-11')).toBe('2026-10');
    expect(esiPeriodStart('2027-02')).toBe('2026-10');
  });

  it("charges Maharashtra's professional tax by slab, sex and February", () => {
    const rule = {
      slabs: [
        { from: 7501, amount: 175, gender: 'male' as const },
        { from: 10001, amount: 200, february: 300, gender: 'male' as const },
        { from: 25001, amount: 200, february: 300, gender: 'female' as const },
      ],
    };
    expect(professionalTax(7500, 'male', 9, rule)).toBe(0);
    expect(professionalTax(9000, 'male', 9, rule)).toBe(175);
    expect(professionalTax(30000, null, 2, rule)).toBe(300);
    expect(professionalTax(20000, 'female', 9, rule)).toBe(0);
    expect(professionalTax(30000, 'female', 9, rule)).toBe(200);
  });

  it('taxes a year under either regime', () => {
    expect(incomeTax(1100000, NEW)).toBe(0);
    // ₹12.1 lakh: ₹61,500 by the slabs, but no more than the ₹10,000 over the rebate limit; plus 4%.
    expect(incomeTax(1210000, NEW)).toBe(10400);
    expect(incomeTax(1800000, NEW)).toBe(166400);
    expect(incomeTax(900000, OLD)).toBe(96200);
    expect(incomeTax(500000, OLD)).toBe(0);
  });

  it("spreads the year's tax over the months left, one-off pay taxed at once", () => {
    expect(monthsLeftInYear('2026-04')).toBe(12);
    expect(monthsLeftInYear('2026-09')).toBe(7);
    expect(monthsLeftInYear('2027-03')).toBe(1);
    const april = {
      regime: NEW,
      paidSoFar: 0,
      regular: 150000,
      regularFull: 150000,
      oneOff: 0,
      monthsLeft: 12,
      tdsSoFar: 0,
      deductions: 0,
    };
    // ₹18 lakh less ₹75,000: ₹1,45,000 and 4%, ₹1,50,800 over twelve months.
    expect(monthlyTds(april)).toEqual({ projected: 1725000, yearTax: 150800, tds: 12567 });
    // ₹50,000 of arrears add ₹10,400 of tax, all this month.
    expect(monthlyTds({ ...april, oneOff: 50000 })).toEqual({
      projected: 1775000,
      yearTax: 161200,
      tds: 22967,
    });
  });
});

describe('payroll gaps (docs/wave8-plan.md step 8c.4)', () => {
  it('pays overtime at twice the hourly rate on wages', () => {
    // ₹31,200 over 30 days of 8 hours = ₹130 an hour; doubled for 6 hours = ₹1,560.
    expect(overtimePay(31200, 30, 6)).toBe(1560);
  });

  it('takes the EMI, or what is left', () => {
    expect([instalment(5000, 12000), instalment(5000, 3000), instalment(5000, 0)]).toEqual([
      5000, 3000, 0,
    ]);
  });

  it('works the bonus on wages within the ceilings', () => {
    // Twelve months: eight at ₹15,000 (eligible, counted on ₹7,000), four at ₹22,000 (not). 8.33% of ₹56,000.
    const months = [
      ...Array.from({ length: 8 }, () => ({ wages: 15000, days: 30 })),
      ...Array.from({ length: 4 }, () => ({ wages: 22000, days: 30 })),
    ];
    expect(bonus(months, 8.33)).toEqual({ eligibleMonths: 8, base: 56000, bonus: 4665 });
    expect(bonus([{ wages: 10000, days: 20 }], 8.33).bonus).toBe(0);
  });

  it('counts declarations, proofs once verified, within each cap', () => {
    const rows = [
      { section: '80C', declared: 120000, proved: null },
      { section: '80C', declared: 60000, proved: null },
      { section: '80D', declared: 25000, proved: null },
    ];
    expect(declaredDeductions(rows)).toBe(175000); // 80C capped at ₹1.5 lakh
    expect(
      declaredDeductions([
        { section: '80C', declared: 150000, proved: 90000 },
        { section: '80D', declared: 25000, proved: null },
      ]),
    ).toBe(90000);
  });
});
