import { describe, expect, it } from 'vitest';
import { measuredQty, priceBid, sumQty, type Markup } from '../src/pricing/pricing.js';

const MARKUPS: Markup[] = [
  { kind: 'overhead', label: 'Site overheads', basis: 'base', pct: '7.5' },
  { kind: 'contingency', label: 'Contingency', basis: 'base', pct: '3' },
  { kind: 'profit', label: 'Profit', basis: 'running', pct: '10' },
  { kind: 'discount', label: 'Strategic discount', basis: 'running', pct: '2' },
  { kind: 'other', label: 'Contractor all-risk insurance', basis: 'base', amount: '25000' },
];

describe('bid pricing', () => {
  it('applies markups in order, on the base or the running total, then adds GST', () => {
    const p = priceBid('1000000', { markups: MARKUPS, gstPct: '18', gstMode: 'add' }, '1150000');
    // 7.5 % and 3 % of 10,00,000; 10 % of 11,05,000; −2 % of 12,15,500; ₹25,000 fixed.
    expect(p.markups.map((m) => m.amount)).toEqual([
      '75000.00',
      '30000.00',
      '110500.00',
      '-24310.00',
      '25000.00',
    ]);
    expect(p).toMatchObject({
      base: '1000000.00',
      markupTotal: '216190.00',
      beforeGst: '1216190.00',
      gst: '218914.20',
      bid: '1435104.20',
      factor: '1.216190',
      // 66,190 above an estimate of 11,50,000.
      vsEstimatePct: '5.76',
      gstIncluded: null,
    });
    expect(p.markups[4]!.pct).toBeNull();
  });

  it('handles GST included in the rates, exemption, a lower bid and no estimate', () => {
    const inc = priceBid(
      '1000000',
      { markups: MARKUPS, gstPct: '18', gstMode: 'included' },
      '1300000',
    );
    expect(inc).toMatchObject({
      gst: '0.00',
      bid: '1216190.00',
      gstIncluded: '185520.51',
      vsEstimatePct: '-6.45',
    });
    const ex = priceBid('1000000', { markups: [], gstPct: '18', gstMode: 'exempt' }, null);
    expect(ex).toMatchObject({
      beforeGst: '1000000.00',
      gst: '0.00',
      bid: '1000000.00',
      factor: '1.000000',
      vsEstimatePct: null,
    });
    expect(priceBid('0', { markups: MARKUPS, gstPct: '12', gstMode: 'add' }).factor).toBe(
      '1.000000',
    );
  });

  it('rounds each markup to paise, half away from zero', () => {
    const p = priceBid('333.33', {
      markups: [{ kind: 'profit', label: 'P', basis: 'base', pct: '1.5' }],
      gstPct: '18',
      gstMode: 'add',
    });
    expect(p.markups[0]!.amount).toBe('5.00'); // 4.99995
    expect(p.gst).toBe('60.90'); // 18 % of 338.33 = 60.8994
  });
});

describe('measurement sheets', () => {
  it('multiplies the dimensions given, skips blanks and subtracts deductions', () => {
    const wall = {
      description: 'Wall A',
      nos: '2',
      length: '10.5',
      breadth: '0.23',
      height: '3',
      deduct: false,
    };
    const door = {
      description: 'Door D1',
      nos: '1',
      length: '1.0',
      breadth: '0.23',
      height: '2.1',
      deduct: true,
    };
    const plaster = {
      description: 'Plaster',
      nos: null,
      length: '4.2',
      breadth: null,
      height: '3.0',
      deduct: false,
    };
    expect(measuredQty(wall)).toBe('14.4900');
    expect(measuredQty(door)).toBe('-0.4830');
    expect(measuredQty(plaster)).toBe('12.6000');
    expect(sumQty([measuredQty(wall), measuredQty(door)])).toBe('14.0070');
    expect(measuredQty({ ...plaster, nos: '3', length: '0.33333', height: null })).toBe('1.0000');
    expect(() => measuredQty({ ...plaster, length: null, height: null })).toThrow();
  });
});
