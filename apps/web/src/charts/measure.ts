// What a chart's numbers are, so every chart says them the same way (docs/wave9-plan.md step 9a.6): money in full in
// tooltips and tables (₹ in Indian grouping) and short on axes (₹ L, ₹ Cr); percentages with %; anything else with
// its unit (tenders, man-days, hours).
import { formatInr, formatInrShort } from '../lib/format';

export type Measure = 'money' | 'pct' | { unit: string };

const num = (v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 2 });

/** The unit as a column heading or axis name shows it: ₹, %, or the unit itself. */
export const unitOf = (m: Measure): string => (m === 'money' ? '₹' : m === 'pct' ? '%' : m.unit);

/** A figure in full, for tooltips and the table view. Nothing to show is a dash. */
export function formatFull(v: unknown, m: Measure): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return '–';
  if (m === 'money') return formatInr(String(n));
  if (m === 'pct') return `${num(n)} %`;
  return m.unit ? `${num(n)} ${m.unit}` : num(n);
}

/** A figure on an axis: short money, plain numbers otherwise (the axis name carries the unit). */
export function formatAxis(v: number, m: Measure): string {
  if (m === 'money') return formatInrShort(String(v));
  if (m === 'pct') return `${num(v)}%`;
  return num(v);
}

/** A value axis that says its unit and labels its figures the house way. */
export function valueAxis(m: Measure, extra: Record<string, unknown> = {}) {
  return {
    type: 'value',
    name: unitOf(m),
    axisLabel: { formatter: (v: number) => formatAxis(v, m) },
    ...(m === 'money' || m === 'pct' ? {} : { minInterval: 1 }),
    ...extra,
  };
}
