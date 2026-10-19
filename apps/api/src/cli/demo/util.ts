// Dates, money and a seeded random source for the demo history (all dates are India dates, YYYY-MM-DD).
export type Day = string;

const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;

export const toDay = (t: number): Day => new Date(t + IST_MS).toISOString().slice(0, 10);
export const dayMs = (d: Day): number => Date.parse(`${d}T00:00:00Z`) - IST_MS;
/** A moment inside the India working day `d` (the simulated clock is set to it). */
export const atWork = (d: Day, hour = 11): number => dayMs(d) + hour * 3_600_000;
export const addDays = (d: Day, n: number): Day =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const diffDays = (a: Day, b: Day): number =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
export const weekday = (d: Day): number => new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Sunday
export const monthOf = (d: Day): string => d.slice(0, 7);
export const firstOfMonth = (d: Day): Day => `${d.slice(0, 7)}-01`;
export const lastOfMonth = (d: Day): Day => {
  const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() + 1);
  x.setUTCDate(0);
  return x.toISOString().slice(0, 10);
};
export const addMonths = (d: Day, n: number): Day => {
  const x = new Date(`${d}T00:00:00Z`);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x.toISOString().slice(0, 10);
};
export const minDay = (a: Day, b: Day): Day => (a < b ? a : b);
export const maxDay = (a: Day, b: Day): Day => (a > b ? a : b);
/** Indian financial year of a day, e.g. 2025-26. */
export const fyOf = (d: Day): string => {
  const y = Number(d.slice(0, 4));
  const start = Number(d.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
};
export function* days(from: Day, to: Day): Generator<Day> {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}

/** Rounded to paise, as a string. */
export const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
export const qty4 = (n: number): string => (Math.round(n * 10_000) / 10_000).toFixed(4);
export const rupees = (n: number): string =>
  `₹${Math.round(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/** mulberry32: the same demo on every run. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    chance: (p: number) => next() < p,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    between: (lo: number, hi: number) => lo + next() * (hi - lo),
  };
}
export type Rng = ReturnType<typeof rng>;

/** Smooth 0→1 over [0,1] (an S-curve for progress). */
export const sCurve = (x: number): number => {
  const t = Math.max(0, Math.min(1, x));
  return t * t * (3 - 2 * t);
};

/** What a site engineer writes when an order goes beyond the material budget (ignored when it does not). */
export const OVER_BUDGET_REASON = 'Rates have moved since the budget; site needs it now.';
