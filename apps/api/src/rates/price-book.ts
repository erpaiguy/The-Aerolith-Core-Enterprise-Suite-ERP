// Reads a tenant's own price book (resources and their rates) from rows of a spreadsheet. Pure; the service applies
// the result. Headings are recognised by name, so a supplier's or the company's existing sheet usually works as is.
import { readNumber } from '../boq/import/builder.js';
import type { ResourceKind } from './engine.js';

export type PriceField = 'code' | 'name' | 'kind' | 'unit' | 'rate' | 'effectiveFrom';

const SYNONYMS: Record<PriceField, string[]> = {
  code: ['code', 'resourcecode', 'itemcode', 'materialcode', 'matcode', 'ref', 'reference', 'id'],
  name: [
    'name',
    'description',
    'resource',
    'resourcename',
    'material',
    'materialname',
    'particulars',
    'itemname',
    'item',
  ],
  kind: ['kind', 'type', 'category', 'resourcetype', 'class', 'group'],
  unit: ['unit', 'units', 'uom', 'unitofmeasurement'],
  rate: ['rate', 'unitrate', 'price', 'rateinrs', 'raters', 'basicrate', 'cost', 'rates'],
  effectiveFrom: [
    'effectivefrom',
    'wef',
    'witheffectfrom',
    'ratedate',
    'validfrom',
    'date',
    'from',
  ],
};
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/₹/g, 'rs')
    .replace(/[^a-z0-9]/g, '');

export function priceFieldFor(text: string): PriceField | null {
  const h = norm(text);
  if (!h) return null;
  for (const f of Object.keys(SYNONYMS) as PriceField[]) if (SYNONYMS[f].includes(h)) return f;
  if (h.startsWith('rate') || h.startsWith('price')) return 'rate';
  if (h.startsWith('description') || h.startsWith('name')) return 'name';
  return null;
}

/** The first row (of the first 20) naming at least code, name and rate. */
export function detectPriceBook(rows: { rowNo: number; cells: string[] }[]) {
  for (const r of rows.slice(0, 20)) {
    const mapping: Partial<Record<PriceField, number>> = {};
    r.cells.forEach((c, i) => {
      const f = priceFieldFor(c);
      if (f && mapping[f] === undefined) mapping[f] = i;
    });
    if (mapping.code !== undefined && mapping.name !== undefined && mapping.rate !== undefined)
      return { headerRow: r.rowNo, mapping };
  }
  return null;
}

const KINDS: Record<string, ResourceKind> = {
  material: 'material',
  materials: 'material',
  mat: 'material',
  m: 'material',
  labour: 'labour',
  labor: 'labour',
  lab: 'labour',
  l: 'labour',
  manpower: 'labour',
  equipment: 'equipment',
  plant: 'equipment',
  machinery: 'equipment',
  machine: 'equipment',
  tp: 'equipment',
  tools: 'equipment',
  tandp: 'equipment',
  pm: 'equipment',
  eq: 'equipment',
  e: 'equipment',
  subcontract: 'subcontract',
  subcontractor: 'subcontract',
  sub: 'subcontract',
  sc: 'subcontract',
  s: 'subcontract',
  other: 'other',
  others: 'other',
  misc: 'other',
  miscellaneous: 'other',
  o: 'other',
};
export const kindFor = (text: string): ResourceKind | null => KINDS[norm(text)] ?? null;

/** ISO dates, and Indian day-first dates: 01-04-2026, 1/4/2026, 01.04.2026. */
export function parseDate(text: string): string | null {
  const t = text.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t)))
    [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  if (y < 1990 || y > 2100) return null;
  return date.toISOString().slice(0, 10);
}

export interface PriceEntry {
  rowNo: number;
  code: string;
  name: string;
  kind: ResourceKind;
  unit: string;
  rate: string;
  effectiveFrom: string;
}

export interface PriceIssue {
  rowNo: number;
  message: string;
}

/** One row: an entry, or an issue; blank rows give neither. */
export function readPriceRow(
  rowNo: number,
  cells: string[],
  mapping: Partial<Record<PriceField, number>>,
  defaults: { kind: ResourceKind; effectiveFrom: string },
): { entry?: PriceEntry; issue?: PriceIssue } {
  const get = (f: PriceField) =>
    mapping[f] === undefined ? '' : (cells[mapping[f]!] ?? '').trim();
  const [code, name, unit, rateText, kindText, dateText] = [
    get('code'),
    get('name'),
    get('unit'),
    get('rate'),
    get('kind'),
    get('effectiveFrom'),
  ];
  if (!code && !name && !rateText) return {};
  const fail = (message: string) => ({ issue: { rowNo, message } });
  if (!code) return fail('No code');
  if (code.length > 40) return fail(`Code "${code.slice(0, 40)}…" is longer than 40 characters`);
  if (!name) return fail(`${code}: no name`);
  if (!unit) return fail(`${code}: no unit`);
  if (unit.length > 20) return fail(`${code}: unit "${unit}" is longer than 20 characters`);
  const n = readNumber(rateText);
  if ('error' in n) return fail(`${code}: rate "${rateText.slice(0, 40)}" ${n.error}`);
  if (n.value === null) return fail(`${code}: no rate`);
  if (n.value.startsWith('-')) return fail(`${code}: rate cannot be negative`);
  let kind = defaults.kind;
  if (kindText) {
    const k = kindFor(kindText);
    if (!k)
      return fail(
        `${code}: type "${kindText}" must be material, labour, equipment, subcontract or other`,
      );
    kind = k;
  }
  let effectiveFrom = defaults.effectiveFrom;
  if (dateText) {
    const d = parseDate(dateText);
    if (!d) return fail(`${code}: date "${dateText}" is not a date (use 01-04-2026 or 2026-04-01)`);
    effectiveFrom = d;
  }
  return {
    entry: { rowNo, code, name: name.slice(0, 500), kind, unit, rate: n.value, effectiveFrom },
  };
}
