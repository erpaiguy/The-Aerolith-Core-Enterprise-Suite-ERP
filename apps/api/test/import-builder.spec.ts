import { describe, expect, it } from 'vitest';
import {
  LineBuilder,
  amountPaise,
  detectSettings,
  fieldForHeader,
  paiseToString,
  readNumber,
  type Settings,
} from '../src/boq/import/builder.js';

const UNITS = new Map([
  ['cum', 'cum'],
  ['m3', 'cum'],
  ['cu.m', 'cum'],
  ['sqm', 'sqm'],
  ['nos', 'nos'],
  ['no.', 'nos'],
  ['ls', 'LS'],
]);

const run = (settings: Partial<Settings>, rows: string[][]) => {
  const b = new LineBuilder(
    {
      sheet: 0,
      headerRow: 1,
      mapping: {},
      structure: 'headings',
      normaliseUnits: true,
      ...settings,
    },
    UNITS,
  );
  const out = rows.map((cells, i) => b.push(i + 2, cells));
  return {
    b,
    lines: out.map((o) => o.line).filter((l) => l !== null),
    issues: out.flatMap((o) => o.issues),
  };
};

describe('reading numbers from spreadsheets', () => {
  it('accepts Indian grouping, currency marks, exponents and blanks', () => {
    expect(readNumber('1,25,000.50')).toMatchObject({ value: '125000.5' });
    expect(readNumber('₹ 350')).toMatchObject({ value: '350' });
    expect(readNumber('Rs. 42.10')).toMatchObject({ value: '42.1' });
    expect(readNumber('1.2E+3')).toMatchObject({ value: '1200' });
    expect(readNumber('-')).toEqual({ value: null });
    expect(readNumber('')).toEqual({ value: null });
  });

  it('rounds beyond 4 decimals and says so only when it matters', () => {
    expect(readNumber('2.123456')).toEqual({ value: '2.1235', rounded: true });
    expect(readNumber('120.50000000000001')).toEqual({ value: '120.5', rounded: false });
    expect(readNumber('-0.00005')).toEqual({ value: '-0.0001', rounded: true });
  });

  it('rejects text and absurd sizes', () => {
    expect(readNumber('LS')).toHaveProperty('error');
    expect(readNumber('12 nos')).toHaveProperty('error');
    expect(readNumber('1e20')).toHaveProperty('error');
    expect(readNumber('1.200,5')).toHaveProperty('error'); // European decimal comma
  });

  it('computes amounts exactly like Postgres round(qty × rate, 2)', () => {
    expect(paiseToString(amountPaise('120.5', '350'))).toBe('42175.00');
    expect(paiseToString(amountPaise('0.005', '1'))).toBe('0.01'); // half away from zero
    expect(paiseToString(amountPaise('-0.005', '1'))).toBe('-0.01');
    expect(paiseToString(amountPaise('3.3333', '3'))).toBe('10.00');
    expect(paiseToString(amountPaise('9999999999999999', '9999.9999'))).toBe(
      '99999998999999990000.00',
    );
  });
});

describe('finding the header', () => {
  it('recognises common Indian BOQ headings', () => {
    expect(fieldForHeader('Sl. No.')).toBe('code');
    expect(fieldForHeader('Description of Item')).toBe('description');
    expect(fieldForHeader('Particulars')).toBe('description');
    expect(fieldForHeader('UOM')).toBe('unit');
    expect(fieldForHeader('Qty.')).toBe('qty');
    expect(fieldForHeader('Rate (₹)')).toBe('rate');
    expect(fieldForHeader('Amount in Rs.')).toBe('amount');
    expect(fieldForHeader('Contractor signature')).toBeNull();
  });

  it('skips title rows, maps columns and suggests numbering when codes are dotted', () => {
    const rows = [
      ['Name of work: G+4 hostel block'],
      ['Schedule B'],
      ['S.No', 'Description of item', 'Unit', 'Qty', 'Rate', 'Amount'],
      ['1', 'Earthwork'],
      ['1.1', 'Excavation', 'cum', '10', '350', '3500'],
      ['1.2', 'Backfill', 'cum', '5', '210', '1050'],
      ['2', 'Concrete'],
      ['2.1', 'PCC', 'cum', '2', '5000', '10000'],
    ].map((cells, i) => ({ rowNo: i + 1, cells }));
    expect(detectSettings(rows)).toEqual({
      headerRow: 3,
      mapping: { code: 0, description: 1, unit: 2, qty: 3, rate: 4, amount: 5 },
      structure: 'numbering',
    });
  });

  it('suggests the level structure for our own export', () => {
    const rows = [
      ['Level', 'Type', 'Code', 'Description', 'Unit', 'Qty', 'Rate', 'Amount', 'Notes'],
    ].map((cells) => ({ rowNo: 1, cells }));
    expect(detectSettings(rows)).toMatchObject({ headerRow: 1, structure: 'level' });
  });
});

describe('building lines', () => {
  const mapping = { code: 0, description: 1, unit: 2, qty: 3, rate: 4, amount: 5 };

  it('headings: rows without figures are sections; units are normalised', () => {
    const { lines, b } = run({ mapping }, [
      ['', 'EARTHWORK'],
      ['1', 'Excavation', 'Cu.M', '120.5', '350'],
      ['2', 'Backfill', 'm3', '80', '210.25'],
      [],
      ['', 'CONCRETE'],
      ['3', 'PCC 1:4:8', 'cum', '2', '5000'],
    ]);
    expect(lines.map((l) => [l.type, l.depth, l.unit, l.amountPaise])).toEqual([
      ['section', 0, null, null],
      ['item', 1, 'cum', 4217500n],
      ['item', 1, 'cum', 1682000n],
      ['section', 0, null, null],
      ['item', 1, 'cum', 1000000n],
    ]);
    expect(b.counts).toMatchObject({ sections: 2, items: 3, skipped: 1, unitsNormalised: 2 });
    expect(paiseToString(b.totalPaise)).toBe('68995.00');
  });

  it('numbering: depth from the item number; (a) goes under the current section; text rows are notes', () => {
    const { lines } = run({ mapping, structure: 'numbering' }, [
      ['1', 'Earthwork'],
      ['1.1', 'Excavation', 'cum', '1', '1'],
      ['1.2', 'Filling'],
      ['(a)', 'with earth', 'cum', '1', '1'],
      ['(b)', 'with sand', 'cum', '1', '1'],
      ['', 'Rates include lead up to 50 m'],
      ['2', 'Concrete'],
      ['2.1.1', 'PCC (level skipped in file)', 'cum', '1', '1'],
    ]);
    expect(lines.map((l) => `${'  '.repeat(l.depth)}${l.type}:${l.code ?? ''}`)).toEqual([
      'section:1',
      '  item:1.1',
      '  section:1.2',
      '    item:(a)',
      '    item:(b)',
      '    note:',
      'section:2',
      '  item:2.1.1',
    ]);
  });

  it('level: our export round-trips, and a skipped level is placed safely with a warning', () => {
    const m = { level: 0, type: 1, code: 2, description: 3, unit: 4, qty: 5, rate: 6 };
    const { lines, issues } = run({ mapping: m, structure: 'level' }, [
      ['0', 'section', 'A', 'Civil'],
      ['1', 'item', 'A.1', 'Excavation', 'cum', '1', '2'],
      ['1', 'note', '', 'Spec note'],
      ['3', 'item', 'A.2', 'Too deep', 'cum', '1', '1'],
      ['0', 'heading', 'B', 'Finishes'],
    ]);
    expect(lines.map((l) => [l.type, l.depth])).toEqual([
      ['section', 0],
      ['item', 1],
      ['note', 1],
      ['item', 1],
      ['section', 0],
    ]);
    expect(issues).toEqual([
      expect.objectContaining({ rowNo: 5, severity: 'warning', field: 'level' }),
    ]);
  });

  it('reports errors that block a row, and warnings that do not', () => {
    const { lines, issues, b } = run({ mapping: { ...mapping, type: 6 } }, [
      ['1', 'Rate only item', 'LS', 'Rate only', '500'],
      ['2', 'Heading with qty', '', '5', '', '', 'section'],
      ['3', 'Weird type', 'nos', '1', '1', '', 'thing'],
      ['4', 'Mismatch', 'no.', '2', '10', '25'],
      ['5', 'Odd unit', 'bundle', '1', '1'],
      ['6', 'Odd unit again', 'bundle', '1', '1'],
    ]);
    expect(issues.map((i) => [i.rowNo, i.severity, i.field ?? '-'])).toEqual([
      [2, 'error', 'qty'],
      [3, 'error', '-'],
      [4, 'error', 'type'],
      [5, 'warning', 'amount'],
      [6, 'warning', 'unit'],
    ]);
    expect(issues[0]!.message).toBe('Quantity "Rate only" is not a number');
    expect(lines.map((l) => l.code)).toEqual(['4', '5', '6']);
    expect(b.counts).toMatchObject({ errors: 3, warnings: 2 });
    expect(b.unknownUnits.get('bundle')).toBe(2);
  });

  it('flat: everything at the top level', () => {
    const { lines } = run({ mapping, structure: 'flat' }, [
      ['', 'General notes'],
      ['1', 'Item', 'nos', '1', '1'],
    ]);
    expect(lines.map((l) => [l.type, l.depth])).toEqual([
      ['note', 0],
      ['item', 0],
    ]);
  });
});
