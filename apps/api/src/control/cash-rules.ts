// Cash flow's arithmetic (docs/wave4-plan.md step 2): periods, dates moved by terms, flows placed in periods, a
// bill's cash, even spreads and GST netted to the government. Money in paise (bigint), dates as YYYY-MM-DD. Pure.

export type By = 'month' | 'week';
export interface Period {
  key: string;
  label: string;
  from: string;
  to: string;
  actual: boolean;
}
export interface Flow {
  date: string;
  amount: bigint;
  /** The GST inside `amount`, owed to (in) or claimable from (out) the government in `gstMonth`. */
  gst: bigint;
  gstMonth: string;
  direction: 'in' | 'out';
  kind: string;
  label: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) =>
  iso(new Date(toDate(d).getTime() + n * 86_400_000));
export const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
export function addMonths(d: string, n: number) {
  const x = toDate(monthStart(d));
  x.setUTCMonth(x.getUTCMonth() + n);
  return iso(x);
}
export const monthEnd = (d: string) => addDays(addMonths(d, 1), -1);
const weekStart = (d: string) => addDays(d, -((toDate(d).getUTCDay() + 6) % 7)); // Monday
const monthLabel = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;

/**
 * Actual periods (six months or eight weeks back, then the current one up to the day before `asOf`), and forecast
 * periods (the current one from `asOf`, then eleven months or twelve weeks more).
 */
export function periods(asOf: string, by: By): Period[] {
  const out: Period[] = [];
  if (by === 'month') {
    const cur = monthStart(asOf);
    for (let i = 6; i >= 1; i--) {
      const f = addMonths(cur, -i);
      out.push({
        key: `a${f.slice(0, 7)}`,
        label: monthLabel(f),
        from: f,
        to: monthEnd(f),
        actual: true,
      });
    }
    if (asOf > cur)
      out.push({
        key: `a${cur.slice(0, 7)}`,
        label: `${monthLabel(cur)} to date`,
        from: cur,
        to: addDays(asOf, -1),
        actual: true,
      });
    for (let i = 0; i < 12; i++) {
      const f = addMonths(cur, i);
      out.push({
        key: `f${f.slice(0, 7)}`,
        label: monthLabel(f),
        from: i ? f : asOf,
        to: monthEnd(f),
        actual: false,
      });
    }
  } else {
    const cur = weekStart(asOf);
    for (let i = 8; i >= 1; i--) {
      const f = addDays(cur, -7 * i);
      out.push({
        key: `a${f}`,
        label: `Week of ${dayLabel(f)}`,
        from: f,
        to: addDays(f, 6),
        actual: true,
      });
    }
    if (asOf > cur)
      out.push({
        key: `a${cur}`,
        label: `Week of ${dayLabel(cur)} to date`,
        from: cur,
        to: addDays(asOf, -1),
        actual: true,
      });
    for (let i = 0; i < 13; i++) {
      const f = addDays(cur, 7 * i);
      out.push({
        key: `f${f}`,
        label: `Week of ${dayLabel(f)}`,
        from: i ? f : asOf,
        to: addDays(f, 6),
        actual: false,
      });
    }
  }
  return out;
}

/** The forecast period a flow falls in: anything already due counts in the first; past the last, `null` (later). */
export function placeForecast(date: string, ps: Period[]) {
  const f = ps.filter((p) => !p.actual);
  if (date < f[0]!.from) return f[0]!;
  return f.find((p) => date >= p.from && date <= p.to) ?? null;
}
export const placeActual = (date: string, ps: Period[]) =>
  ps.find((p) => p.actual && date >= p.from && date <= p.to) ?? null;

const pct = (v: bigint, p: string) => {
  // p has up to 2 decimals; round half up to the paisa.
  const [i = '0', f = ''] = p.split('.');
  const bp = BigInt(i) * 100n + BigInt((f + '00').slice(0, 2));
  return (v * bp + 5_000n) / 10_000n;
};

/** What a bill for `value` of work brings in: value plus GST, less retention, advance recovery and the client's TDS. */
export function billCash(
  value: bigint,
  t: { gstPct: string; retentionPct: string; advancePct: string; tdsPct: string },
) {
  const gst = pct(value, t.gstPct);
  return {
    amount:
      value + gst - pct(value, t.retentionPct) - pct(value, t.advancePct) - pct(value, t.tdsPct),
    gst,
  };
}

/** `total` in equal parts (paise), the remainder on the last part. */
export function spreadEven(total: bigint, parts: number): bigint[] {
  if (parts <= 0) return [];
  const each = total / BigInt(parts);
  return Array.from({ length: parts }, (_, i) =>
    i === parts - 1 ? total - each * BigInt(parts - 1) : each,
  );
}

/** `total` in proportion to `weights` (paise), the remainder on the last non-zero weight. */
export function spreadBy(total: bigint, weights: bigint[]): bigint[] {
  const sum = weights.reduce((a, w) => a + (w > 0n ? w : 0n), 0n);
  if (sum === 0n) return weights.map(() => 0n);
  const out = weights.map((w) => (w > 0n ? (total * w) / sum : 0n));
  const last = weights.map((w) => w > 0n).lastIndexOf(true);
  out[last] = out[last]! + total - out.reduce((a, x) => a + x, 0n);
  return out;
}

/**
 * GST paid to the government: for each month from `fromMonth`, output tax on what is billed less input tax on what is
 * bought, paid on the 20th of the next month; a month with more input than output carries its credit forward.
 */
export function gstPayments(flows: Flow[], fromMonth: string): Flow[] {
  const net = new Map<string, bigint>();
  for (const f of flows) {
    if (f.gst === 0n || f.gstMonth < fromMonth.slice(0, 7)) continue;
    net.set(f.gstMonth, (net.get(f.gstMonth) ?? 0n) + (f.direction === 'in' ? f.gst : -f.gst));
  }
  const out: Flow[] = [];
  let carry = 0n;
  for (const m of [...net.keys()].sort()) {
    const due = net.get(m)! + carry;
    if (due > 0n) {
      out.push({
        date: `${addMonths(`${m}-01`, 1).slice(0, 7)}-20`,
        amount: due,
        gst: 0n,
        gstMonth: m,
        direction: 'out',
        kind: 'gst',
        label: `GST for ${monthLabel(`${m}-01`)}`,
      });
      carry = 0n;
    } else carry = due;
  }
  return out;
}
