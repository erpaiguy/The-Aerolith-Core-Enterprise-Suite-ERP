import { describe, expect, it } from 'vitest';
import { dec, fmt, mul, plusPct } from '../src/rates/decimal.js';
import {
  CostingEngine,
  CycleError,
  MAX_NESTING,
  TooDeepError,
  type AnalysisDef,
  type LineDef,
  type ResourceInfo,
} from '../src/rates/engine.js';

const res = (
  id: string,
  kind: ResourceInfo['kind'],
  rate: string | null,
  unit = 'nos',
): ResourceInfo => ({
  id,
  code: id.toUpperCase(),
  name: id,
  kind,
  unit,
  rate,
});
const R = (lineNo: number, resourceId: string, qty: string, wastagePct = '0'): LineDef => ({
  lineNo,
  kind: 'resource',
  resourceId,
  subAnalysisId: null,
  description: '',
  qty,
  wastagePct,
  amount: null,
});
const A = (lineNo: number, subAnalysisId: string, qty: string): LineDef => ({
  lineNo,
  kind: 'analysis',
  resourceId: null,
  subAnalysisId,
  description: '',
  qty,
  wastagePct: '0',
  amount: null,
});
const L = (lineNo: number, amount: string): LineDef => ({
  lineNo,
  kind: 'lump_sum',
  resourceId: null,
  subAnalysisId: null,
  description: 'Sundries',
  qty: '0',
  wastagePct: '0',
  amount,
});
const analysis = (id: string, lines: LineDef[], extra: Partial<AnalysisDef> = {}): AnalysisDef => ({
  id,
  code: id.toUpperCase(),
  description: id,
  unit: 'cum',
  outputQty: '1',
  additions: [],
  lines,
  ...extra,
});
const engine = (analyses: AnalysisDef[], resources: ResourceInfo[]) =>
  new CostingEngine(
    new Map(analyses.map((a) => [a.id, a])),
    new Map(resources.map((r) => [r.id, r])),
  );

const RESOURCES = [
  res('cement', 'material', '400', 'bag'),
  res('agg', 'material', '1500', 'cum'),
  res('sand', 'material', '1800', 'cum'),
  res('mason', 'labour', '900', 'day'),
  res('beldar', 'labour', '650', 'day'),
  res('mixer', 'equipment', '1200', 'day'),
  res('brick', 'material', '8', 'nos'),
];

describe('decimal arithmetic', () => {
  it('is exact and rounds half away from zero', () => {
    expect(fmt(mul(dec('3.468'), dec('400')), 2)).toBe('1387.20');
    expect(fmt(plusPct(dec('3.4'), dec('2')), 4, 0)).toBe('3.468');
    expect(fmt(dec('0.125'), 2)).toBe('0.13');
    expect(fmt(dec('-0.125'), 2)).toBe('-0.13');
    expect(fmt(dec('5687.51705'), 4)).toBe('5687.5171');
    expect(fmt(dec('12.5'), 4, 0)).toBe('12.5');
    expect(fmt(dec('0.1').valueOf() * 3n, 12, 0)).toBe('0.3'); // no binary floating point
  });
});

describe('rate analysis costing', () => {
  // PCC 1:4:8 per cum, CPWD style: materials with 2 % wastage on cement, labour, mixer, sundries; water charges 1 %
  // then contractor's profit and overheads 15 % on the running total.
  const pcc = analysis(
    'pcc',
    [
      R(1, 'cement', '3.4', '2'),
      R(2, 'agg', '0.94'),
      R(3, 'sand', '0.47'),
      R(4, 'mason', '0.1'),
      R(5, 'beldar', '1.63'),
      R(6, 'mixer', '0.07'),
      L(7, '20'),
    ],
    {
      additions: [
        { label: 'Water charges', pct: '1' },
        { label: "Contractor's profit and overheads", pct: '15' },
      ],
    },
  );

  it('costs lines, wastage and compounding additions exactly', () => {
    const c = engine([pcc], RESOURCES).cost('pcc');
    expect(c.lines.map((l) => l.cost)).toEqual([
      '1387.20',
      '1410.00',
      '846.00',
      '90.00',
      '1059.50',
      '84.00',
      '20.00',
    ]);
    expect(c.subtotal).toBe('4896.70');
    expect(c.additions).toEqual([
      { label: 'Water charges', pct: '1', amount: '48.97' },
      { label: "Contractor's profit and overheads", pct: '15', amount: '741.85' },
    ]);
    expect(c.unitRate).toBe('5687.5171');
    expect(c.boqRate).toBe('5687.52');
    expect(c.byKind).toEqual({
      material: '3643.2000',
      labour: '1149.5000',
      equipment: '84.0000',
      subcontract: '0.0000',
      other: '20.0000',
    });
    expect(c.additionsPerUnit).toBe('790.8171');
    expect(c.missing).toEqual([]);
  });

  it('nests analyses (mortar inside brickwork) and divides by the output quantity', () => {
    const mortar = analysis('mortar', [R(1, 'cement', '4.4'), R(2, 'sand', '1.2')]);
    const brickwork = analysis(
      'brickwork',
      [R(1, 'brick', '5000'), A(2, 'mortar', '2.5'), R(3, 'mason', '7')],
      { outputQty: '10', additions: [{ label: 'Profit and overheads', pct: '15' }] },
    );
    const c = engine([mortar, brickwork], RESOURCES).cost('brickwork');
    expect(c.lines.map((l) => [l.unitCost, l.cost])).toEqual([
      ['8.0000', '40000.00'],
      ['3920.0000', '9800.00'],
      ['900.0000', '6300.00'],
    ]);
    expect(c.total).toBe('64515.00');
    expect(c.unitRate).toBe('6451.5000');
    // The mortar's cement and sand count as materials of the brickwork.
    expect(c.byKind.material).toBe('4980.0000');
    expect(c.byKind.labour).toBe('630.0000');
    expect(c.additionsPerUnit).toBe('841.5000');
  });

  it('carries additions of sub-analyses into the breakdown', () => {
    const sub = analysis('sub', [R(1, 'mason', '1')], {
      additions: [{ label: 'OH', pct: '10' }],
    });
    const top = analysis('top', [A(1, 'sub', '2')]);
    const c = engine([sub, top], RESOURCES).cost('top');
    expect(c.unitRate).toBe('1980.0000');
    expect(c.byKind.labour).toBe('1800.0000');
    expect(c.additionsPerUnit).toBe('180.0000');
  });

  it('reports resources without a rate on the date, also from sub-analyses', () => {
    const resources = [...RESOURCES, res('steel', 'material', null, 'kg')];
    const rcc = analysis('rcc', [R(1, 'steel', '80'), A(2, 'pcc', '1')]);
    const c = engine([pcc, rcc], resources).cost('rcc');
    expect(c.missing).toEqual([{ id: 'steel', code: 'STEEL', name: 'steel' }]);
    expect(c.lines[0]).toEqual({ lineNo: 1, unitCost: null, cost: '0.00' });
    expect(c.unitRate).toBe('5687.5171');
  });

  it('refuses analyses that refer to each other, and nesting beyond the limit', () => {
    const a = analysis('a', [A(1, 'b', '1')]);
    const b = analysis('b', [A(1, 'c', '1')]);
    const c = analysis('c', [A(1, 'a', '1')]);
    expect(() => engine([a, b, c], RESOURCES).cost('a')).toThrow(CycleError);
    try {
      engine([a, b, c], RESOURCES).cost('a');
    } catch (e) {
      expect((e as CycleError).path).toEqual(['A', 'B', 'C', 'A']);
    }

    const chain = Array.from({ length: MAX_NESTING + 2 }, (_, i) =>
      analysis(`n${i}`, i === MAX_NESTING + 1 ? [R(1, 'mason', '1')] : [A(1, `n${i + 1}`, '1')]),
    );
    expect(() => engine(chain, RESOURCES).cost('n0')).toThrow(TooDeepError);
    expect(engine(chain, RESOURCES).cost('n1').unitRate).toBe('900.0000');
  });
});
