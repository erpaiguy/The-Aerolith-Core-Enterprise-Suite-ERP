// Pure BOQ grid logic: types, number entry and display, and the sliding window of loaded rows.
// The grid never holds the whole BOQ (docs/03-architecture.md §13): it keeps a contiguous slice in tree order and
// extends or trims it as the user scrolls.

export type NodeType = 'section' | 'item' | 'note';

export interface BoqRow {
  id: string;
  parentId: string | null;
  sortKey: string;
  depth: number;
  type: NodeType;
  code: string | null;
  description: string;
  notes: string;
  unit: string | null;
  qty: string | null;
  rate: string | null;
  amount: string | null;
  subtotal: string;
  childCount: number;
  rowVersion: number;
  /** The rate analysis this item's rate came from (the rate is copied, not live). */
  rateAnalysisId?: string | null;
  /** The quantity is the total of the item's measurement sheet. */
  measured?: boolean;
}

export interface BoqHeader {
  id: string;
  tenderId: string;
  name: string;
  status: 'draft' | 'locked' | 'submitted';
  /** The version being drafted, or the last one frozen. */
  versionNo?: number;
  currency: string;
  nodeCount: number;
  itemCount: number;
  total: string;
  notes: string;
  rowVersion: number;
  /** Rates from analyses are taken as on this date. */
  rateDate?: string;
  /** Set when the BOQ was archived (made by mistake): read only, left out of the bid. */
  archivedAt?: string | null;
  tender?: { id: string; number: string; title: string };
}

export interface Changes {
  header: BoqHeader;
  rows: BoqRow[];
  deletedIds: string[];
  idMap: Record<string, string>;
  reload: boolean;
}

export type EditableColumn = 'code' | 'description' | 'unit' | 'qty' | 'rate';
export const COLUMNS: EditableColumn[] = ['code', 'description', 'unit', 'qty', 'rate'];

// --- numbers ---

const DECIMAL = /^-?\d{1,16}(\.\d{1,4})?$/;

/**
 * Parses what a user typed into a quantity or rate cell. Accepts "1,250.5", "  42 ", and simple formulas such as
 * "=12*3.5+(2/4)". Returns a plain decimal string (4 places at most), null for an empty cell, or an error message.
 */
export function parseDecimal(input: string): { value: string | null } | { error: string } {
  const raw = input.trim();
  if (raw === '') return { value: null };
  let n: number;
  if (raw.startsWith('=')) {
    const r = evaluate(raw.slice(1));
    if (r === null) return { error: 'Formula not understood. Use numbers, + - * / and brackets.' };
    n = r;
  } else {
    const plain = raw.replace(/[,\s]/g, '').replace(/^(-?)\./, '$10.');
    if (!/^-?\d*\.?\d+$/.test(plain)) return { error: 'Enter a number.' };
    if (!DECIMAL.test(plain)) return { error: 'Up to 16 digits and 4 decimal places.' };
    return { value: trimZeros(plain) };
  }
  if (!Number.isFinite(n)) return { error: 'The result is not a number.' };
  const fixed = trimZeros(n.toFixed(4));
  return DECIMAL.test(fixed) ? { value: fixed } : { error: 'The result is too large.' };
}

function trimZeros(s: string): string {
  const t = s.includes('.') ? s.replace(/\.?0+$/, '') : s;
  return t === '-0' ? '0' : t;
}

/** Arithmetic on + - * / and brackets, without eval. Returns null on anything else. */
export function evaluate(expr: string): number | null {
  const tokens = expr.replace(/,/g, '').match(/\d*\.?\d+|[-+*/()]|\S/g);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const term = (): number | null => {
    let left = factor();
    while (left !== null && (peek() === '*' || peek() === '/')) {
      const op = tokens[i++];
      const right = factor();
      if (right === null) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  };
  const sum = (): number | null => {
    let left = term();
    while (left !== null && (peek() === '+' || peek() === '-')) {
      const op = tokens[i++];
      const right = term();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  };
  function factor(): number | null {
    const t = tokens![i++];
    if (t === undefined) return null;
    if (t === '-') {
      const v = factor();
      return v === null ? null : -v;
    }
    if (t === '(') {
      const v = sum();
      return tokens![i++] === ')' ? v : null;
    }
    return /^\d*\.?\d+$/.test(t) ? Number(t) : null;
  }
  const result = sum();
  return i === tokens.length ? result : null;
}

const grouped = (min: number, max: number) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: min, maximumFractionDigits: max });
const QTY = grouped(0, 4);
const RATE = grouped(2, 4);
const AMOUNT = grouped(2, 2);

export const formatQty = (v: string | null): string => (v === null ? '' : QTY.format(Number(v)));
export const formatRate = (v: string | null): string => (v === null ? '' : RATE.format(Number(v)));
export const formatAmount = (v: string | null): string =>
  v === null ? '' : AMOUNT.format(Number(v));

/** The value shown in a cell editor: the stored value without trailing zeros. */
export function editValue(row: BoqRow, col: EditableColumn): string {
  const v = row[col];
  if (v === null) return '';
  return col === 'qty' || col === 'rate' ? trimZeros(v) : v;
}

// --- the sliding window ---

/** Rows kept in memory at most; beyond this the far end is dropped (and re-read if the user scrolls back). */
export const MAX_ROWS = 2400;

export interface Slice {
  rows: BoqRow[];
  hasBefore: boolean;
  hasAfter: boolean;
}

/** Appends rows read after the slice; drops rows from the top if the slice grows too long. */
export function appendRows(s: Slice, more: BoqRow[], hasMore: boolean) {
  const rows = s.rows.concat(more);
  const drop = Math.max(0, rows.length - MAX_ROWS);
  return {
    slice: { rows: rows.slice(drop), hasBefore: s.hasBefore || drop > 0, hasAfter: hasMore },
    droppedTop: drop,
  };
}

/** Prepends rows read before the slice; drops rows from the bottom if the slice grows too long. */
export function prependRows(s: Slice, more: BoqRow[], hasMore: boolean): Slice {
  const rows = more.concat(s.rows);
  const keep = Math.min(rows.length, MAX_ROWS);
  return {
    rows: rows.slice(0, keep),
    hasBefore: hasMore,
    hasAfter: s.hasAfter || keep < rows.length,
  };
}

/**
 * Applies the server's answer to a batch of edits: fresh rows replace stale ones, deleted rows go, and new rows are
 * placed by sort key when they fall inside the loaded range. Rows hidden under a collapsed section are not added.
 */
export function mergeChanges(
  s: Slice,
  fresh: BoqRow[],
  deletedIds: string[],
  collapsedKeys: Set<string>,
): Slice {
  const gone = new Set(deletedIds);
  const byId = new Map(fresh.map((r) => [r.id, r]));
  const rows = s.rows.filter((r) => !gone.has(r.id)).map((r) => byId.get(r.id) ?? r);
  const present = new Set(rows.map((r) => r.id));
  const first = rows[0]?.sortKey;
  const last = rows.at(-1)?.sortKey;
  for (const r of fresh) {
    if (present.has(r.id) || isHidden(r.sortKey, collapsedKeys)) continue;
    const inRange =
      rows.length === 0 ||
      ((first === undefined || r.sortKey > first || !s.hasBefore) &&
        (last === undefined || r.sortKey < last || !s.hasAfter));
    if (!inRange) continue;
    rows.splice(insertionIndex(rows, r.sortKey), 0, r);
  }
  return { ...s, rows };
}

/** Index where a row with this key belongs (binary search; keys compare byte-wise, like COLLATE "C"). */
export function insertionIndex(rows: BoqRow[], key: string): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid]!.sortKey < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Is a line under any collapsed section? (Keys of collapsed sections.) */
export function isHidden(key: string, collapsedKeys: Set<string>): boolean {
  let i = key.indexOf('!');
  while (i >= 0) {
    if (collapsedKeys.has(key.slice(0, i))) return true;
    i = key.indexOf('!', i + 1);
  }
  return false;
}

/** Where "add a line below" puts the new line: inside an open section, otherwise as the next sibling. */
export function insertTarget(
  active: BoqRow | undefined,
  collapsed: boolean,
): { parentId: string | null; afterId: string | null } {
  if (!active) return { parentId: null, afterId: null };
  if (active.type === 'section' && !collapsed) return { parentId: active.id, afterId: null };
  return { parentId: active.parentId, afterId: active.id };
}

/** Tab-separated text from Excel or Google Sheets into rows of cells. Drops a trailing empty line. */
export function parseClipboard(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((l) => l.split('\t'));
}
