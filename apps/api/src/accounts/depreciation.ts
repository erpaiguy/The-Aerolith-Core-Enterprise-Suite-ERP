// Depreciation worked exactly (docs/wave3-plan.md step 9). Books: the Companies Act's straight line or written-down
// value over the class's useful life, day by day over the year's days, never below the residual value. Tax: the Income
// Tax Act's block of assets, full rate on additions used 180 days or more in the year, half rate on the rest.
// Pure: the service brings the asset, its moves and what was charged before.
import { dec, div, fmt, mul, type Dec } from '../rates/decimal.js';

const r2 = (v: Dec) => dec(fmt(v, 2));
const DAY = 86_400_000;
export const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
export const addDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const fyStart = (d: string) => {
  const y = Number(d.slice(0, 4));
  return Number(d.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01`;
};

/** The WDV rate that brings cost to residual over the life: 1 − (residual / cost)^(1 / life), to four places. */
export function wdvRate(residualPct: string, lifeYears: string) {
  const r = Number(residualPct) / 100;
  if (r <= 0) return '1.0000';
  return (1 - Math.pow(r, 1 / Number(lifeYears))).toFixed(4);
}

export interface AssetForRun {
  cost: string;
  /** Depreciation charged before (opening and earlier runs). */
  charged: string;
  /** Book value at the start of the financial year the period begins in (WDV's base). */
  yearOpening: string;
  residualPct: string;
  lifeYears: string;
  method: 'slm' | 'wdv';
  /** Where it stood: each move's date and project, oldest first. */
  moves: { from: string; projectId: string | null }[];
}

/**
 * The charge from one date to another (both inclusive), split where the asset moved and where a financial year
 * starts: straight line on (cost − residual) ÷ life; WDV on the year's opening book value × rate; each piece by its
 * days over 365, to the paisa; the whole never taking the book value below the residual.
 */
export function charge(a: AssetForRun, from: string, to: string) {
  if (to < from) return [];
  const residual = r2(mul(dec(a.cost), div(dec(a.residualPct), dec('100'))));
  let room = dec(a.cost) - dec(a.charged) - residual;
  if (room <= 0n) return [];
  const annualSlm = div(dec(a.cost) - residual, dec(a.lifeYears));
  const rate = dec(wdvRate(a.residualPct, a.lifeYears));
  // Cut points: each move after from, each 1 April after from.
  const cuts = new Set<string>();
  for (const m of a.moves) if (m.from > from && m.from <= to) cuts.add(m.from);
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    const d = `${y}-04-01`;
    if (d > from && d <= to) cuts.add(d);
  }
  const starts = [from, ...[...cuts].sort()];
  let yearBase = dec(a.yearOpening);
  let yearCharged = 0n;
  let currentYear = fyStart(from);
  const out: { from: string; to: string; projectId: string | null; amount: string }[] = [];
  for (const [i, s] of starts.entries()) {
    const e = i + 1 < starts.length ? addDays(starts[i + 1]!, -1) : to;
    if (fyStart(s) !== currentYear) {
      // A new financial year: WDV's base is the book value now.
      yearBase = yearBase - yearCharged;
      yearCharged = 0n;
      currentYear = fyStart(s);
    }
    const days = dec(String(daysBetween(s, e)));
    const annual = a.method === 'slm' ? annualSlm : mul(yearBase, rate);
    // By the day, over the days of that financial year (366 when it holds 29 February).
    const yearDays = daysBetween(
      fyStart(s),
      addDays(`${Number(fyStart(s).slice(0, 4)) + 1}-04-01`, -1),
    );
    let amount = r2(div(mul(annual, days), dec(String(yearDays))));
    if (amount > room) amount = room;
    room -= amount;
    yearCharged += amount;
    const project = [...a.moves].reverse().find((m) => m.from <= s)?.projectId ?? null;
    out.push({ from: s, to: e, projectId: project, amount: fmt(amount, 2) });
    if (room <= 0n) break;
  }
  return out.filter((x) => dec(x.amount) > 0n);
}

/** One block's year under the Income Tax Act. */
export function taxBlock(input: {
  rate: string;
  opening: string;
  /** Additions with the days used in the year. */
  additions: { cost: string; daysUsed: number }[];
  sales: string;
}) {
  const full = input.additions
    .filter((x) => x.daysUsed >= 180)
    .reduce((s, x) => s + dec(x.cost), 0n);
  const half = input.additions
    .filter((x) => x.daysUsed < 180)
    .reduce((s, x) => s + dec(x.cost), 0n);
  const rate = div(dec(input.rate), dec('100'));
  let base = dec(input.opening) + full - dec(input.sales);
  let halfBase = half;
  if (base < 0n) {
    halfBase += base;
    base = 0n;
  }
  if (halfBase < 0n) halfBase = 0n;
  const depreciation = r2(mul(base, rate)) + r2(div(mul(halfBase, rate), dec('2')));
  const closing = dec(input.opening) + full + half - dec(input.sales) - depreciation;
  return {
    opening: fmt(dec(input.opening), 2),
    additionsFull: fmt(full, 2),
    additionsHalf: fmt(half, 2),
    sales: fmt(dec(input.sales), 2),
    depreciation: fmt(depreciation, 2),
    closing: fmt(closing < 0n ? 0n : closing, 2),
  };
}
