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
}

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
  return {
    workerId: w.workerId,
    name: w.name,
    skill: w.skill,
    rate: w.rate,
    days,
    overtimeHours: w.overtimeHours,
    wages,
    overtime,
    gross: r2(wages + overtime),
    minimum: w.minimum,
    shortfall,
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
