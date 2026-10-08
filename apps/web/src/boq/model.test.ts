import { describe, expect, it } from 'vitest';
import {
  MAX_ROWS,
  appendRows,
  evaluate,
  formatAmount,
  formatQty,
  formatRate,
  insertTarget,
  isHidden,
  mergeChanges,
  parseClipboard,
  parseDecimal,
  prependRows,
  type BoqRow,
} from './model';

const row = (id: string, sortKey: string, extra: Partial<BoqRow> = {}): BoqRow => ({
  id,
  parentId: null,
  sortKey,
  depth: sortKey.split('!').length - 1,
  type: 'item',
  code: id,
  description: '',
  notes: '',
  unit: null,
  qty: null,
  rate: null,
  amount: null,
  subtotal: '0.00',
  childCount: 0,
  rowVersion: 1,
  ...extra,
});

describe('number entry', () => {
  it('accepts grouped numbers, blanks and simple formulas', () => {
    expect(parseDecimal('1,250.50')).toEqual({ value: '1250.5' });
    expect(parseDecimal(' 42 ')).toEqual({ value: '42' });
    expect(parseDecimal('.5')).toEqual({ value: '0.5' });
    expect(parseDecimal('-3')).toEqual({ value: '-3' });
    expect(parseDecimal('')).toEqual({ value: null });
    expect(parseDecimal('=12*3.5+(2/4)')).toEqual({ value: '42.5' });
    expect(parseDecimal('=10/3')).toEqual({ value: '3.3333' });
    expect(parseDecimal('=-(2+3)*2')).toEqual({ value: '-10' });
  });

  it('explains what is wrong', () => {
    expect(parseDecimal('12.34567')).toHaveProperty('error');
    expect(parseDecimal('abc')).toHaveProperty('error');
    expect(parseDecimal('=2+')).toHaveProperty('error');
    expect(parseDecimal('=alert(1)')).toHaveProperty('error');
    expect(parseDecimal('=1/0')).toHaveProperty('error');
    expect(evaluate('2*(3')).toBeNull();
  });

  it('formats with Indian grouping', () => {
    expect(formatQty('125000.5')).toBe('1,25,000.5');
    expect(formatRate('350')).toBe('350.00');
    expect(formatRate('42.1255')).toBe('42.1255');
    expect(formatAmount('12345678.9')).toBe('1,23,45,678.90');
    expect(formatAmount(null)).toBe('');
  });
});

describe('sliding window', () => {
  const many = (n: number, start = 0) =>
    Array.from({ length: n }, (_, i) => row(`r${start + i}`, String(start + i).padStart(8, '0')));

  it('appends and drops the far top when too long', () => {
    const s = { rows: many(MAX_ROWS - 10), hasBefore: false, hasAfter: true };
    const { slice, droppedTop } = appendRows(s, many(50, MAX_ROWS - 10), true);
    expect(droppedTop).toBe(40);
    expect(slice.rows).toHaveLength(MAX_ROWS);
    expect(slice.hasBefore).toBe(true);
    expect(slice.rows[0]!.id).toBe('r40');
  });

  it('prepends and drops the far bottom when too long', () => {
    const s = { rows: many(MAX_ROWS, 100), hasBefore: true, hasAfter: false };
    const out = prependRows(s, many(100), false);
    expect(out.rows).toHaveLength(MAX_ROWS);
    expect(out.rows[0]!.id).toBe('r0');
    expect(out).toMatchObject({ hasBefore: false, hasAfter: true });
  });

  it('merges server changes: replaces, deletes, and places new rows by key', () => {
    const s = {
      rows: [row('a', 'a'), row('b', 'b'), row('c', 'c')],
      hasBefore: false,
      hasAfter: false,
    };
    const out = mergeChanges(
      s,
      [row('b', 'b', { qty: '2' }), row('n', 'bm'), row('h', 'b!x')],
      ['c'],
      new Set(['b']),
    );
    // 'b!x' is under the collapsed section 'b', so it stays hidden.
    expect(out.rows.map((r) => r.id)).toEqual(['a', 'b', 'n']);
    expect(out.rows[1]!.qty).toBe('2');
  });

  it('does not add rows outside the loaded range when more rows exist there', () => {
    const s = { rows: [row('b', 'b'), row('c', 'c')], hasBefore: true, hasAfter: true };
    const out = mergeChanges(s, [row('a', 'a'), row('z', 'z'), row('bb', 'bb')], [], new Set());
    expect(out.rows.map((r) => r.id)).toEqual(['b', 'bb', 'c']);
  });

  it('knows which lines a collapsed section hides', () => {
    const collapsed = new Set(['0a!1b']);
    expect(isHidden('0a!1b!2c', collapsed)).toBe(true);
    expect(isHidden('0a!1b', collapsed)).toBe(false);
    expect(isHidden('0a!1bb', collapsed)).toBe(false);
  });
});

describe('editing helpers', () => {
  it('adds inside an open section, otherwise as the next sibling', () => {
    const section = row('s', 'a', { type: 'section', parentId: 'p' });
    expect(insertTarget(section, false)).toEqual({ parentId: 's', afterId: null });
    expect(insertTarget(section, true)).toEqual({ parentId: 'p', afterId: 's' });
    expect(insertTarget(row('i', 'a!b', { parentId: 's' }), false)).toEqual({
      parentId: 's',
      afterId: 'i',
    });
    expect(insertTarget(undefined, false)).toEqual({ parentId: null, afterId: null });
  });

  it('reads tab-separated rows pasted from a spreadsheet', () => {
    expect(parseClipboard('1.1\tExcavation\tcum\t120\r\n1.2\tBackfill\tcum\t80\r\n')).toEqual([
      ['1.1', 'Excavation', 'cum', '120'],
      ['1.2', 'Backfill', 'cum', '80'],
    ]);
  });
});
