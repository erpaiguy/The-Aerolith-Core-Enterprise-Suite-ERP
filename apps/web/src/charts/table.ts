// A chart's figures as a table (docs/wave9-plan.md step 9a.6): read from the same option the chart draws, so the two
// never disagree. One row per category (or pie slice), one column per series; and the same table as CSV.
import type { T } from '../i18n/i18n';
import type { ChartOption } from './EChart';
import { formatFull, unitOf, type Measure } from './measure';

export type Measures = Measure | Record<string, Measure>;

export interface ChartTableData {
  /** The first column's heading: what the categories are (Stage, Month, Week). */
  heading: string;
  columns: { name: string; measure: Measure }[];
  rows: { label: string; values: (number | null)[] }[];
}

type Series = { name?: string; type?: string; data?: unknown[] };
type Axis = { type?: string; data?: unknown[] };

const first = <T>(x: T | T[] | undefined): T | undefined => (Array.isArray(x) ? x[0] : x);
const label = (v: unknown) =>
  v !== null && typeof v === 'object' && 'value' in v ? String(v.value) : String(v ?? '');
const value = (v: unknown): number | null => {
  const raw = v !== null && typeof v === 'object' && 'value' in v ? v.value : v;
  const n =
    typeof raw === 'number' ? raw : typeof raw === 'string' && raw !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** The measure of a series: one for the whole chart, or by series name (the first one when it is not named). */
export function measureFor(measures: Measures, series: string): Measure {
  if (typeof measures === 'string' || 'unit' in measures) return measures as Measure;
  const m = measures as Record<string, Measure>;
  return m[series] ?? Object.values(m)[0] ?? { unit: '' };
}

/** The table behind a bar, line or pie chart option. */
export function chartTable(option: ChartOption, measures: Measures, heading = ''): ChartTableData {
  const series = (
    (Array.isArray(option.series) ? option.series : [option.series]) as Series[]
  ).filter((s): s is Series => !!s && Array.isArray(s.data));
  const pie = series.find((s) => s.type === 'pie');
  if (pie) {
    const name = pie.name || 'Value';
    return {
      heading,
      columns: [{ name, measure: measureFor(measures, name) }],
      rows: pie.data!.map((d) => ({
        label: d !== null && typeof d === 'object' && 'name' in d ? String(d.name) : '',
        values: [value(d)],
      })),
    };
  }
  const x = first(option.xAxis as Axis | Axis[] | undefined);
  const y = first(option.yAxis as Axis | Axis[] | undefined);
  const cat = x?.type === 'category' ? x : y?.type === 'category' ? y : x;
  const categories = (cat?.data ?? []).map(label);
  const named = series.map((s, i) => s.name || (series.length === 1 ? 'Value' : `Series ${i + 1}`));
  return {
    heading,
    columns: named.map((name) => ({ name, measure: measureFor(measures, name) })),
    rows: categories.map((c, i) => ({ label: c, values: series.map((s) => value(s.data![i])) })),
  };
}

/** Each cell as the table shows it: in full, with its unit. */
export const formatCell = (v: number | null, m: Measure) => formatFull(v, m);

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/**
 * The table as CSV for a spreadsheet: plain numbers (no grouping, no symbol) with the unit in the column heading,
 * blank where there is no figure; lines end CRLF (RFC 4180).
 */
export function toCsv(t: ChartTableData): string {
  const head = [
    t.heading,
    ...t.columns.map((c) => (unitOf(c.measure) ? `${c.name} (${unitOf(c.measure)})` : c.name)),
  ];
  const lines = [
    head,
    ...t.rows.map((r) => [r.label, ...r.values.map((v) => (v === null ? '' : String(v)))]),
  ];
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** A one-sentence summary for screen readers: what is shown and the largest figure of each series. */
export function summarise(t: ChartTableData, tr: T = (s, v) => fill(s, v)): string {
  if (!t.rows.length) return tr('No figures.');
  const parts = t.columns.slice(0, 4).map((c, i) => {
    let best: { label: string; v: number } | null = null;
    for (const r of t.rows) {
      const v = r.values[i];
      if (v !== null && v !== undefined && (!best || v > best.v)) best = { label: r.label, v };
    }
    return best
      ? tr('{name} highest at {label}, {value}', {
          name: c.name,
          label: best.label,
          value: formatFull(best.v, c.measure),
        })
      : null;
  });
  const said = parts.filter(Boolean).join('; ');
  const n = tr(t.rows.length === 1 ? '{n} entry' : '{n} entries', { n: t.rows.length });
  return `${n}${said ? `. ${said}` : ''}.`;
}

const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
