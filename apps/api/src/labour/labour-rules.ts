// Contract labour's arithmetic (docs/wave3-plan.md step 13): a worker's month from the musters, overtime at twice the
// ordinary rate, and the shortfall against the minimum wage. Pure.

/** Ordinary hours in a day: the day's wage ÷ 8 is the hourly rate overtime doubles. */
export const HOURS_A_DAY = 8;

export interface WageLine {
  workerId: string;
  name: string;
  skill: string;
  rate: number;
  days: number;
  overtimeHours: number;
  wages: number;
  overtime: number;
  gross: number;
  /** The minimum daily wage for their skill, or null when none is on record. */
  minimum: number | null;
  shortfall: number;
  /** PF (12% each side on wages up to ₹15,000 a month) and ESI (0.75% and 3.25% while gross is ₹21,000 or less). */
  pfEmployee: number;
  pfEmployer: number;
  esiEmployee: number;
  esiEmployer: number;
}

/** The statutory limits the contributions turn on. [Guessing] The CA confirms each year's figures. */
export const PF_WAGE_CEILING = 15000;
export const ESI_GROSS_CEILING = 21000;

const r2 = (v: number) => Math.round(v * 100 + 1e-9) / 100;

export function wageLine(w: {
  workerId: string;
  name: string;
  skill: string;
  rate: number;
  present: number;
  halfDays: number;
  overtimeHours: number;
  minimum: number | null;
}): WageLine {
  const days = w.present + w.halfDays / 2;
  const wages = r2(days * w.rate);
  const overtime = r2((w.overtimeHours * w.rate * 2) / HOURS_A_DAY);
  const short = w.minimum !== null && w.rate < w.minimum ? w.minimum - w.rate : 0;
  const shortfall = r2(days * short + (w.overtimeHours * short * 2) / HOURS_A_DAY);
  const gross = r2(wages + overtime);
  const pfBase = Math.min(wages, PF_WAGE_CEILING);
  const esi = gross <= ESI_GROSS_CEILING;
  return {
    workerId: w.workerId,
    name: w.name,
    skill: w.skill,
    rate: w.rate,
    days,
    overtimeHours: w.overtimeHours,
    wages,
    overtime,
    gross,
    minimum: w.minimum,
    shortfall,
    pfEmployee: Math.round(pfBase * 0.12),
    pfEmployer: Math.round(pfBase * 0.12),
    esiEmployee: esi ? Math.ceil(gross * 0.0075) : 0,
    esiEmployer: esi ? Math.ceil(gross * 0.0325) : 0,
  };
}

/** Days to the licence's end (negative when lapsed), and whether that is near enough to warn about. */
export function licenceState(validTo: string | null, today: string, warnDays = 30) {
  if (!validTo) return { daysLeft: null, lapsed: false, nearing: false };
  const days = Math.round(
    (Date.parse(`${validTo}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  return { daysLeft: days, lapsed: days < 0, nearing: days >= 0 && days <= warnDays };
}

/** What holds a labour contractor's bill: each reason in words. */
export function complianceReasons(x: {
  licenceValidTo: string | null;
  on: string;
  belowMinimum: { month: string; site: string; shortfall: string }[];
  unpaid: { month: string; kind: 'pf' | 'esi'; due: string; paid: string }[];
}) {
  const out: string[] = [];
  if (x.licenceValidTo && x.licenceValidTo < x.on)
    out.push(`The contract labour licence lapsed on ${x.licenceValidTo}.`);
  for (const b of x.belowMinimum)
    out.push(`${b.month} at ${b.site}: workers paid ₹${b.shortfall} below the minimum wage.`);
  for (const u of x.unpaid)
    out.push(`${u.month}: ${u.kind.toUpperCase()} of ₹${u.due} due, ₹${u.paid} shown paid.`);
  return out;
}
