// Turns raw spreadsheet rows into BOQ lines (docs/wave1-plan.md step 4). Pure and streaming: one row in, at most one
// line out, plus any issues. The same builder runs for the dry run and for the import, so they cannot disagree.

export type Field =
  'code' | 'description' | 'unit' | 'qty' | 'rate' | 'amount' | 'level' | 'type' | 'notes';
export const FIELDS: Field[] = [
  'code',
  'description',
  'unit',
  'qty',
  'rate',
  'amount',
  'level',
  'type',
  'notes',
];

/** Column index (0-based) per field. */
export type Mapping = Partial<Record<Field, number>>;

/**
 * How sections are recognised:
 * - headings: a row without quantity, rate and unit is a section heading; lines below it belong to it.
 * - numbering: depth from the item number (1 / 1.1 / 1.1.1); rows without a number or figures are notes.
 * - level: depth from a Level column (0, 1, 2 ...), as written by our own export.
 * - flat: no sections; rows without figures are notes.
 */
export type Structure = 'headings' | 'numbering' | 'level' | 'flat';
export const STRUCTURES: Structure[] = ['headings', 'numbering', 'level', 'flat'];

export interface Settings {
  sheet: number;
  /** File row number of the header (rows up to and including it are skipped); null when there is none. */
  headerRow: number | null;
  mapping: Mapping;
  structure: Structure;
  normaliseUnits: boolean;
}

export type LineType = 'section' | 'item' | 'note';

export interface Line {
  rowNo: number;
  type: LineType;
  depth: number;
  code: string | null;
  description: string;
  notes: string;
  unit: string | null;
  qty: string | null;
  rate: string | null;
  /** round(qty × rate, 2) in paise, exactly as Postgres computes it; null unless both are present. */
  amountPaise: bigint | null;
}

export interface Issue {
  rowNo: number;
  field?: Field;
  severity: 'error' | 'warning';
  message: string;
}

export const MAX_DEPTH = 30;
const MAX = { code: 40, unit: 20, description: 10_000, notes: 10_000 };

// --- numbers ---

/**
 * Reads a quantity or rate as written in a spreadsheet: "1,25,000.50", "₹ 350", "Rs. 42", "1.2E+3". Values with more
 * than 4 decimals are rounded (half away from zero); `rounded` tells whether that changed the value materially.
 */
export function readNumber(
  text: string,
): { value: string | null; rounded?: boolean } | { error: string } {
  // "1.200,5" is a European decimal comma; guessing would silently turn it into 1.2005.
  if (/\.\d*,/.test(text)) return { error: 'is not a number' };
  const t = text
    .replace(/₹|rs\.?|inr/gi, '')
    .replace(/[,\s]/g, '')
    .trim();
  if (t === '' || t === '-' || t === '--') return { value: null };
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return { error: 'is not a number' };
  const n = Number(t);
  if (!Number.isFinite(n) || Math.abs(n) >= 1e16) return { error: 'is too large' };
  const fixed = toFixed4(t, n);
  return { value: fixed, rounded: Math.abs(Number(fixed) - n) > 1e-9 };
}

/** Exact 4-decimal string. Plain decimals are rounded on their digits; exponent forms go through the number. */
function toFixed4(t: string, n: number): string {
  const m = /^([-+]?)(\d*)\.?(\d*)$/.exec(t);
  if (!m) return trimZeros(roundHalfAway(n, 4));
  const sign = m[1] === '-' ? '-' : '';
  const int = m[2] || '0';
  const frac = m[3] ?? '';
  if (frac.length <= 4) return trimZeros(`${sign}${BigInt(int)}.${frac.padEnd(4, '0')}`);
  let scaled = BigInt(int + frac.slice(0, 4));
  if (Number(frac[4]) >= 5) scaled += 1n;
  const s = scaled.toString().padStart(5, '0');
  return trimZeros(`${sign}${s.slice(0, -4)}.${s.slice(-4)}`);
}

function roundHalfAway(n: number, places: number): string {
  const f = 10 ** places;
  return ((Math.sign(n) * Math.round(Math.abs(n) * f + 1e-9)) / f).toFixed(places);
}

function trimZeros(s: string): string {
  const t = s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  return t === '-0' || t === '' ? '0' : t;
}

/** A decimal string with up to 4 places as an integer of ten-thousandths. */
const scaled4 = (v: string): bigint => {
  const neg = v.startsWith('-');
  const [i, f = ''] = (neg ? v.slice(1) : v).split('.');
  const n = BigInt((i || '0') + f.padEnd(4, '0'));
  return neg ? -n : n;
};

/** round(qty × rate, 2) in paise, half away from zero, like Postgres numeric round(). */
export function amountPaise(qty: string, rate: string): bigint {
  const p = scaled4(qty) * scaled4(rate); // 10^-8
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const paise = (abs + 500_000n) / 1_000_000n;
  return neg ? -paise : paise;
}

export const paiseToString = (p: bigint): string => {
  const neg = p < 0n;
  const s = (neg ? -p : p).toString().padStart(3, '0');
  return `${neg ? '-' : ''}${s.slice(0, -2)}.${s.slice(-2)}`;
};

// --- headers ---

const SYNONYMS: Record<Field, string[]> = {
  code: [
    'itemno',
    'item',
    'sno',
    'slno',
    'srno',
    'serialno',
    'code',
    'itemcode',
    'no',
    'ref',
    'reference',
    'boqno',
    'boqref',
  ],
  description: [
    'description',
    'particulars',
    'itemdescription',
    'descriptionofitem',
    'descriptionofwork',
    'descriptionofitems',
    'workdescription',
    'details',
    'nameofwork',
  ],
  unit: ['unit', 'units', 'uom', 'unitofmeasurement', 'unitofmeasure'],
  qty: ['qty', 'quantity', 'qnty', 'quantities', 'qnt', 'estimatedquantity', 'estqty', 'boqqty'],
  rate: [
    'rate',
    'unitrate',
    'raters',
    'rateinrs',
    'rateinr',
    'rateinrupees',
    'quotedrate',
    'rateperunit',
  ],
  amount: ['amount', 'amountrs', 'amountinrs', 'amountinr', 'total', 'totalamount', 'value'],
  level: ['level', 'outlinelevel', 'indent', 'depth'],
  type: ['type', 'linetype', 'rowtype'],
  notes: ['notes', 'note', 'remarks', 'remark'],
};

const normaliseHeader = (s: string) =>
  s
    .toLowerCase()
    .replace(/₹/g, 'rs')
    .replace(/[^a-z0-9]/g, '');

/** Which field a header cell names, if any. */
export function fieldForHeader(text: string): Field | null {
  const h = normaliseHeader(text);
  if (!h) return null;
  for (const f of FIELDS) if (SYNONYMS[f].includes(h)) return f;
  // "Description of item (as per specification)", "Rate (Rs.)" and the like.
  for (const f of ['description', 'qty', 'rate', 'amount', 'unit'] as Field[])
    if (SYNONYMS[f].some((s) => s.length >= 4 && h.startsWith(s))) return f;
  return null;
}

/**
 * Finds the header row among the first rows of a sheet: the row naming the most distinct fields (at least two,
 * one of them description, quantity or rate). Suggests a mapping and a structure.
 */
export function detectSettings(rows: { rowNo: number; cells: string[] }[]): {
  headerRow: number | null;
  mapping: Mapping;
  structure: Structure;
} {
  let best: { rowNo: number; mapping: Mapping; score: number } | null = null;
  for (const r of rows.slice(0, 30)) {
    const mapping: Mapping = {};
    r.cells.forEach((c, i) => {
      const f = fieldForHeader(c);
      if (f && mapping[f] === undefined) mapping[f] = i;
    });
    const score = Object.keys(mapping).length;
    const useful =
      mapping.description !== undefined || mapping.qty !== undefined || mapping.rate !== undefined;
    if (score >= 2 && useful && (!best || score > best.score))
      best = { rowNo: r.rowNo, mapping, score };
  }
  if (!best) return { headerRow: null, mapping: {}, structure: 'headings' };
  const { mapping } = best;
  let structure: Structure = 'headings';
  if (mapping.level !== undefined) structure = 'level';
  else if (mapping.code !== undefined) {
    const codes = rows
      .filter((r) => r.rowNo > best.rowNo)
      .map((r) => (r.cells[mapping.code!] ?? '').trim())
      .filter(Boolean);
    if (
      codes.length >= 3 &&
      codes.filter((c) => /^\w+(\.\w+)+\.?$/.test(c)).length >= codes.length * 0.3
    )
      structure = 'numbering';
  }
  return { headerRow: best.rowNo, mapping, structure };
}

// --- the builder ---

/** Sub-item markers that belong under the current line rather than at a depth of their own: (a), b), (iv). */
const SUB_ITEM = /^\(?([a-z]{1,2}|[ivx]{1,5})\)\.?$/i;

export class LineBuilder {
  private readonly open: number[] = []; // depths (as requested by the file) of open sections, outermost first
  readonly counts = {
    rows: 0,
    sections: 0,
    items: 0,
    notes: 0,
    skipped: 0,
    errors: 0,
    warnings: 0,
    unitsNormalised: 0,
  };
  totalPaise = 0n;
  readonly unknownUnits = new Map<string, number>();

  constructor(
    private readonly settings: Settings,
    /** lower-case alias or code -> unit code */
    private readonly units: Map<string, string>,
  ) {}

  /** One file row. Returns the line it becomes (null when skipped or invalid) and its issues. */
  push(rowNo: number, cells: string[]): { line: Line | null; issues: Issue[] } {
    const { mapping, structure } = this.settings;
    if (this.settings.headerRow !== null && rowNo <= this.settings.headerRow)
      return { line: null, issues: [] };
    const get = (f: Field) => (mapping[f] === undefined ? '' : (cells[mapping[f]!] ?? '').trim());
    const issues: Issue[] = [];
    const error = (field: Field | undefined, message: string) =>
      issues.push({ rowNo, ...(field ? { field } : {}), severity: 'error', message });
    const warn = (field: Field | undefined, message: string) =>
      issues.push({ rowNo, ...(field ? { field } : {}), severity: 'warning', message });

    const raw = {
      code: get('code'),
      description: get('description'),
      unit: get('unit'),
      notes: get('notes'),
    };
    const numbers: Partial<Record<'qty' | 'rate' | 'amount', string | null>> = {};
    for (const f of ['qty', 'rate', 'amount'] as const) {
      const text = get(f);
      const r = readNumber(text);
      if ('error' in r) error(f, `${label(f)} "${text.slice(0, 40)}" ${r.error}`);
      else {
        numbers[f] = r.value;
        if (r.rounded && f !== 'amount')
          warn(f, `${label(f)} ${text} rounded to 4 decimals (${r.value})`);
      }
    }
    const blank =
      !raw.code &&
      !raw.description &&
      !raw.unit &&
      !raw.notes &&
      !get('qty') &&
      !get('rate') &&
      !get('amount');
    if (blank) {
      this.counts.skipped++;
      return { line: null, issues: [] };
    }
    this.counts.rows++;

    // Type: an explicit Type column wins; otherwise inferred from whether the row has figures.
    const hasFigures = Boolean(numbers.qty ?? numbers.rate ?? raw.unit);
    let type: LineType;
    const typeText = get('type').toLowerCase();
    if (mapping.type !== undefined && typeText) {
      const t = typeText === 'heading' ? 'section' : typeText;
      if (t !== 'section' && t !== 'item' && t !== 'note') {
        error('type', `Type "${get('type')}" must be section, item or note`);
        type = hasFigures ? 'item' : 'section';
      } else type = t;
    } else if (hasFigures) type = 'item';
    else if (structure === 'flat') type = 'note';
    else if (structure === 'numbering') type = raw.code ? 'section' : 'note';
    else type = 'section';
    if (type !== 'item' && (numbers.qty || numbers.rate))
      error(undefined, `A ${type} cannot have a quantity or rate`);

    // Depth.
    let requested: number;
    if (structure === 'flat') requested = 0;
    else if (structure === 'headings') requested = type === 'section' ? 0 : this.open.length;
    else if (structure === 'level') {
      const lv = get('level');
      if (!/^\d{1,3}$/.test(lv)) {
        error('level', `Level "${lv}" must be a whole number (0 for top level)`);
        requested = this.open.length;
      } else requested = Number(lv);
    } else {
      const code = raw.code.replace(/\.$/, '');
      requested =
        !code || SUB_ITEM.test(code) ? this.open.length : Math.max(0, code.split('.').length - 1);
    }
    // Close sections at or below the requested depth; a line can only go one level below the open sections.
    while (this.open.length > requested) this.open.pop();
    const depth = this.open.length;
    if (structure === 'level' && requested > depth)
      warn(
        'level',
        `Level ${requested} has no level ${depth} section above it; placed at level ${depth}`,
      );
    if (depth > MAX_DEPTH) error(undefined, `Nesting deeper than ${MAX_DEPTH} levels`);

    // Text limits.
    const clip = (f: 'code' | 'unit' | 'description' | 'notes', v: string) => {
      if (v.length <= MAX[f]) return v;
      warn(f, `${label(f)} shortened to ${MAX[f]} characters`);
      return v.slice(0, MAX[f]);
    };
    const code = clip('code', raw.code) || null;
    const description = clip('description', raw.description);
    const notes = clip('notes', raw.notes);
    let unit = clip('unit', raw.unit) || null;
    if (unit) {
      const known = this.units.get(unit.toLowerCase());
      if (known) {
        if (known !== unit && this.settings.normaliseUnits) {
          unit = known;
          this.counts.unitsNormalised++;
        }
      } else {
        const n = this.unknownUnits.get(unit) ?? 0;
        this.unknownUnits.set(unit, n + 1);
        if (n === 0) warn('unit', `Unit "${unit}" is not in the units list (kept as written)`);
      }
    }
    if (type === 'item' && !description && !code)
      warn('description', 'Item has no code or description');

    let amount: bigint | null = null;
    if (type === 'item' && numbers.qty && numbers.rate) {
      amount = amountPaise(numbers.qty, numbers.rate);
      if (numbers.amount) {
        const diff = amount - BigInt(Math.round(Number(numbers.amount) * 100));
        if (diff > 100n || diff < -100n)
          warn(
            'amount',
            `Amount in the file (${numbers.amount}) differs from quantity × rate (${paiseToString(amount)})`,
          );
      }
    }

    const errors = issues.filter((i) => i.severity === 'error').length;
    this.counts.errors += errors;
    this.counts.warnings += issues.length - errors;
    if (errors > 0) return { line: null, issues };

    if (type === 'section') this.open.push(requested);
    this.counts[type === 'section' ? 'sections' : type === 'item' ? 'items' : 'notes']++;
    if (amount !== null) this.totalPaise += amount;
    return {
      line: {
        rowNo,
        type,
        depth,
        code,
        description,
        notes,
        unit,
        qty: type === 'item' ? (numbers.qty ?? null) : null,
        rate: type === 'item' ? (numbers.rate ?? null) : null,
        amountPaise: amount,
      },
      issues,
    };
  }
}

const label = (f: Field) =>
  ({
    code: 'Code',
    description: 'Description',
    unit: 'Unit',
    qty: 'Quantity',
    rate: 'Rate',
    amount: 'Amount',
    level: 'Level',
    type: 'Type',
    notes: 'Notes',
  })[f];
