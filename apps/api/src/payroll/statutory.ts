// Payroll's statutory returns and the full and final settlement worked exactly (docs/wave3-plan.md step 12b). Pure.
// [Guessing] Formats and formulas are a payroll practitioner's to confirm against the portals' current templates.

/**
 * One member's line of the EPFO's ECR text file (ECR 2.0): UAN, name, gross wages, EPF, EPS and EDLI wages, the
 * employee's EPF, the employer's pension share, the employer's EPF share, days not paid, refund of advances; joined
 * by `#~#`, amounts in whole rupees.
 */
export function ecrLine(m: {
  uan: string;
  name: string;
  gross: number;
  epfWages: number;
  epsWages: number;
  edliWages: number;
  employee: number;
  eps: number;
  employerEpf: number;
  ncpDays: number;
}) {
  const r = (v: number) => String(Math.round(v));
  return [
    m.uan,
    m.name.toUpperCase().replace(/#~#/g, ' '),
    r(m.gross),
    r(m.epfWages),
    r(m.epsWages),
    r(m.edliWages),
    r(m.employee),
    r(m.eps),
    r(m.employerEpf),
    r(m.ncpDays),
    '0',
  ].join('#~#');
}

export interface GratuityRule {
  /** Completed years of service needed (five; one for fixed-term staff under the Code on Social Security). */
  minYears: number;
  /** Days' wages for each year. */
  days: number;
  /** The month's working days the daily wage is reckoned on. */
  divisor: number;
  cap: number;
}

/** Completed years from joining to leaving, a part year of more than six months counting as a year. */
export function serviceYears(joinedOn: string, lastDay: string) {
  const [y1, m1, d1] = joinedOn.split('-').map(Number) as [number, number, number];
  const [y2, m2, d2] = lastDay.split('-').map(Number) as [number, number, number];
  let months = (y2 - y1) * 12 + (m2 - m1) + (d2 + 1 >= d1 ? 0 : -1);
  if (months < 0) months = 0;
  const whole = Math.floor(months / 12);
  return { completed: whole, counted: months % 12 > 6 ? whole + 1 : whole, months };
}

/** Gratuity: the last month's wages ÷ divisor × days × years counted, once the minimum service is reached; capped. */
export function gratuity(input: {
  wages: number;
  joinedOn: string;
  lastDay: string;
  fixedTerm: boolean;
  rule: GratuityRule;
}) {
  const s = serviceYears(input.joinedOn, input.lastDay);
  const min = input.fixedTerm ? 1 : input.rule.minYears;
  if (s.completed < min) return { years: s.counted, amount: 0, eligible: false };
  const amount = Math.round((input.wages / input.rule.divisor) * input.rule.days * s.counted);
  return { years: s.counted, amount: Math.min(amount, input.rule.cap), eligible: true };
}

/** Earned leave paid out: the balance (in half days) at the last month's wages ÷ 26 a day. */
export const encashment = (balance: number, wages: number, divisor = 26) =>
  Math.round((balance * wages) / divisor);

/** Notice short (negative: recovered from the employee) or paid in lieu, at the month's gross ÷ 30 a day. */
export const noticePay = (days: number, monthlyGross: number) =>
  Math.round((days * monthlyGross) / 30);
