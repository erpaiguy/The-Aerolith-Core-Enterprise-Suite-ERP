// Payroll's statutory arithmetic (docs/wave3-plan.md step 12). Pure: the figures come from the compliance rules in
// force (data with effective dates, never constants here); the service brings the employee's month. [Guessing] Every
// rule is a payroll practitioner's to confirm.

/** The figures of each kind of rule, as stored. Percentages as numbers (12 = 12%). */
export interface PfRule {
  ceiling: number;
  employeeRate: number;
  /** The employer's share going to the pension scheme, on wages up to the ceiling. */
  epsRate: number;
  /** The employer's whole share; EPF gets it less the pension share. */
  employerRate: number;
  edliRate: number;
  adminRate: number;
}
export interface EsiRule {
  ceiling: number;
  employeeRate: number;
  employerRate: number;
}
export interface PtSlab {
  /** Monthly gross from which the slab applies. */
  from: number;
  amount: number;
  /** A different amount in February (Maharashtra's ₹300). */
  february?: number;
  gender?: 'female' | 'male';
}
export interface PtRule {
  slabs: PtSlab[];
}
export interface LwfRule {
  employee: number;
  employer: number;
  /** The months (1–12) it is deducted in. */
  months: number[];
}
export interface TaxSlab {
  /** Upper end of the slab; null for the top. */
  upTo: number | null;
  rate: number;
}
export interface TaxRegime {
  slabs: TaxSlab[];
  standardDeduction: number;
  /** Taxable income up to which the rebate wipes the tax out. */
  rebateUpTo: number;
  /** Above it, the tax never exceeds the income over the limit (marginal relief). */
  marginalRelief: boolean;
  cess: number;
}
export interface TaxRule {
  new: TaxRegime;
  old: TaxRegime;
}
export interface WagesRule {
  /** The most the excluded allowances may be of the whole pay, as a percentage; beyond it they count as wages. */
  excludedCap: number;
}

const rupee = (v: number) => Math.round(v + 1e-9);

/**
 * "Wages" under the Code on Wages: the components that are wages (basic, dearness, retaining allowance), plus whatever
 * of the rest passes the cap of the whole pay.
 */
export function wagesOf(components: { amount: number; inWages: boolean }[], rule: WagesRule) {
  const total = components.reduce((s, c) => s + c.amount, 0);
  const wages = components.filter((c) => c.inWages).reduce((s, c) => s + c.amount, 0);
  const excluded = total - wages;
  const cap = (total * rule.excludedCap) / 100;
  return round2(excluded > cap ? wages + excluded - cap : wages);
}
export const round2 = (v: number) => Math.round(v * 100 + 1e-9) / 100;

/**
 * PF on the month's wages: the employee's 12%, the employer's split between the pension scheme (on wages up to the
 * ceiling) and EPF, EDLI and admin charges; each to the rupee. `onActual`: the company contributes on actual wages
 * above the ceiling (the pension share stays on the ceiling).
 */
export function pf(wages: number, rule: PfRule, onActual = false) {
  const epfWages = onActual ? wages : Math.min(wages, rule.ceiling);
  const epsWages = Math.min(wages, rule.ceiling);
  const employee = rupee((epfWages * rule.employeeRate) / 100);
  const eps = rupee((epsWages * rule.epsRate) / 100);
  const employerEpf = rupee((epfWages * rule.employerRate) / 100) - eps;
  return {
    epfWages: round2(epfWages),
    epsWages: round2(epsWages),
    edliWages: round2(epsWages),
    employee,
    eps,
    employerEpf,
    edli: rupee((epsWages * rule.edliRate) / 100),
    admin: rupee((epfWages * rule.adminRate) / 100),
  };
}

/** ESI on the month's gross, each share rounded up to the rupee (as the ESIC does). */
export function esi(gross: number, rule: EsiRule) {
  const up = (v: number) => Math.ceil(v - 1e-9);
  return {
    employee: up((gross * rule.employeeRate) / 100),
    employer: up((gross * rule.employerRate) / 100),
  };
}

/** Whether a full month's gross brings someone under ESI (judged at the start of each contribution period). */
export const esiCovered = (monthlyGross: number, rule: EsiRule) => monthlyGross <= rule.ceiling;

/** The first month (1 or 4 … ) of ESI's contribution period holding a month: April–September or October–March. */
export const esiPeriodStart = (month: string) => {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  if (m >= 4 && m <= 9) return `${y}-04`;
  return m >= 10 ? `${y}-10` : `${y - 1}-10`;
};

export function professionalTax(gross: number, gender: string | null, month: number, rule: PtRule) {
  const slabs = rule.slabs
    .filter((s) => !s.gender || s.gender === (gender === 'female' ? 'female' : 'male'))
    .sort((a, b) => b.from - a.from);
  const slab = slabs.find((s) => gross >= s.from);
  if (!slab) return 0;
  return month === 2 && slab.february !== undefined ? slab.february : slab.amount;
}

export const lwf = (month: number, rule: LwfRule | null) =>
  rule && rule.months.includes(month)
    ? { employee: rule.employee, employer: rule.employer }
    : { employee: 0, employer: 0 };

/** A year's tax on taxable income under a regime: the slabs, the rebate (with marginal relief) and the cess. */
export function incomeTax(taxable: number, regime: TaxRegime) {
  const income = Math.max(0, Math.floor(taxable / 10) * 10); // rounded down to ₹10
  let tax = 0;
  let lower = 0;
  for (const s of regime.slabs) {
    const upper = s.upTo ?? Infinity;
    if (income > lower) tax += ((Math.min(income, upper) - lower) * s.rate) / 100;
    lower = upper;
  }
  if (income <= regime.rebateUpTo) tax = 0;
  else if (regime.marginalRelief) tax = Math.min(tax, income - regime.rebateUpTo);
  return rupee(tax + (tax * regime.cess) / 100);
}

/**
 * This month's TDS on salary: the year projected (paid so far, this month, and this month's regular pay for each
 * month left after it), less the standard deduction and the employee's declared deductions; the tax on it less what
 * was deducted already, spread over the months left with this one. Tax on one-off pay (arrears) is taken whole this
 * month.
 */
export function monthlyTds(input: {
  regime: TaxRegime;
  /** Taxable pay in earlier months of the financial year. */
  paidSoFar: number;
  /** This month's regular taxable pay (as cut for unpaid days). */
  regular: number;
  /** This month's regular taxable pay for a full month: what the months left are expected to pay. */
  regularFull: number;
  /** This month's one-off taxable pay. */
  oneOff: number;
  /** Months left in the financial year including this one (12 in April, 1 in March). */
  monthsLeft: number;
  tdsSoFar: number;
  deductions: number;
}) {
  const base =
    input.paidSoFar +
    input.regular +
    input.regularFull * (input.monthsLeft - 1) -
    input.regime.standardDeduction -
    input.deductions;
  const without = incomeTax(base, input.regime);
  const withOneOff = incomeTax(base + input.oneOff, input.regime);
  const due = Math.max(0, without - input.tdsSoFar);
  return {
    projected: round2(base + input.oneOff),
    yearTax: withOneOff,
    tds: rupee(due / input.monthsLeft) + (withOneOff - without),
  };
}

/** Months left in India's financial year, counting this one: April 12 … March 1. */
export const monthsLeftInYear = (month: string) => {
  const m = Number(month.slice(5, 7));
  return m >= 4 ? 16 - m : 4 - m;
};
export const financialYearStart = (month: string) => {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  return `${m >= 4 ? y : y - 1}-04`;
};
