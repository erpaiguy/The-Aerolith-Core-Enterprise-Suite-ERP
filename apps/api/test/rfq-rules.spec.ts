// The comparative statement (src/rfq/rfq-rules.ts), worked by hand: three vendors quoting GST extra, GST included
// and GST exempt; a tie for L1; a line without a quantity; a vendor who did not price every line.
import { describe, expect, it } from 'vitest';
import {
  basicRate,
  comparativeStatement,
  rateToApply,
  type CsLine,
  type CsQuote,
} from '../src/rfq/rfq-rules.js';
import { fmt } from '../src/rates/decimal.js';

const lines: CsLine[] = [
  {
    id: 'l1',
    seq: 1,
    code: '2.1',
    description: 'Waterproofing of terrace',
    unit: 'sqm',
    qty: '100',
    ourRate: '340',
    selectedPartyId: 'A',
  },
  {
    id: 'l2',
    seq: 2,
    code: '2.2',
    description: 'Waterproofing of toilets',
    unit: 'sqm',
    qty: '40',
    ourRate: null,
    selectedPartyId: 'B',
  },
  {
    id: 'l3',
    seq: 3,
    code: '2.3',
    description: 'Extra for coving',
    unit: 'm',
    qty: null,
    ourRate: null,
    selectedPartyId: null,
  },
];
const quote = (
  partyId: string,
  gstMode: CsQuote['gstMode'],
  rates: Record<string, string>,
): CsQuote => ({
  partyId,
  name: `Vendor ${partyId}`,
  gstMode,
  gstPct: '18',
  rates: new Map(Object.entries(rates).map(([k, rate]) => [k, { rate, remark: '' }])),
});
const quotes = [
  quote('A', 'extra', { l1: '350', l2: '200', l3: '50' }),
  quote('B', 'included', { l1: '413', l2: '212.40' }), // 350 and 180 before GST
  quote('C', 'exempt', { l1: '360', l2: '190', l3: '45' }),
];

describe('comparative statement', () => {
  const cs = comparativeStatement(lines, quotes);

  it('compares rates before GST: a quote that includes GST is divided back', () => {
    expect(fmt(basicRate('413', 'included', '18'), 4)).toBe('350.0000');
    expect(fmt(basicRate('350', 'extra', '18'), 4)).toBe('350.0000');
    expect(cs.lines[0]!.cells.B).toMatchObject({
      rate: '413.0000',
      basic: '350.0000',
      amount: '35000.00',
    });
  });

  it('ranks each line, lowest first; a tie names no single L1', () => {
    expect(
      Object.fromEntries(Object.entries(cs.lines[0]!.cells).map(([k, c]) => [k, c.rank])),
    ).toEqual({
      A: 1,
      B: 1,
      C: 2,
    });
    expect(cs.lines[0]!.l1).toBeNull();
    expect(cs.lines[1]!.l1).toBe('B');
    expect(cs.lines[2]!.l1).toBe('C');
    expect(cs.lines[2]!.cells.C!.amount).toBeNull(); // no quantity: rate only
  });

  it('totals each vendor with its own GST, and ranks only the quotes that price every line', () => {
    expect(cs.vendors).toEqual([
      expect.objectContaining({
        partyId: 'A',
        basicTotal: '43000.00',
        gst: '7740.00',
        total: '50740.00',
        complete: true,
        rank: 1,
        linesL1: 1,
      }),
      expect.objectContaining({
        partyId: 'B',
        basicTotal: '42200.00',
        gst: '7596.00',
        total: '49796.00',
        complete: false,
        rank: null,
        linesL1: 2,
      }),
      expect.objectContaining({
        partyId: 'C',
        basicTotal: '43600.00',
        gst: '0.00',
        total: '43600.00',
        complete: true,
        rank: 2,
        linesL1: 1,
      }),
    ]);
  });

  it('adds up the line-wise lowest, the chosen vendors, and the estimate for the same quantities', () => {
    expect(cs.totals).toEqual({
      splitL1: '42200.00', // 350 × 100 + 180 × 40
      selected: '42200.00', // A for line 1, B for line 2
      linesSelected: 2,
      estimate: '34000.00', // 340 × 100; line 2 has no estimate rate
      linesUnpriced: 0,
    });
    expect(cs.lines[0]!.selected).toEqual({ partyId: 'A', basic: '350.0000', amount: '35000.00' });
  });

  it('puts the chosen rate into the estimate before GST, to the paisa', () => {
    expect(rateToApply(fmt(basicRate('100', 'included', '18'), 4))).toBe('84.75');
  });
});
