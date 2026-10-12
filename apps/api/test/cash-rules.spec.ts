// Cash flow's arithmetic by hand (docs/wave4-plan.md step 2).
import { describe, expect, it } from 'vitest';
import {
  addDays,
  billCash,
  gstPayments,
  monthEnd,
  periods,
  placeForecast,
  spreadBy,
  spreadEven,
  type Flow,
} from '../src/control/cash-rules.js';

describe('cash flow rules', () => {
  it('makes periods back and ahead, splitting the current one at the date', () => {
    const m = periods('2026-10-12', 'month');
    expect(m.filter((p) => p.actual).map((p) => [p.label, p.from, p.to])).toEqual([
      ['Apr 2026', '2026-04-01', '2026-04-30'],
      ['May 2026', '2026-05-01', '2026-05-31'],
      ['Jun 2026', '2026-06-01', '2026-06-30'],
      ['Jul 2026', '2026-07-01', '2026-07-31'],
      ['Aug 2026', '2026-08-01', '2026-08-31'],
      ['Sep 2026', '2026-09-01', '2026-09-30'],
      ['Oct 2026 to date', '2026-10-01', '2026-10-11'],
    ]);
    const f = m.filter((p) => !p.actual);
    expect(f).toHaveLength(12);
    expect([f[0]!.from, f[0]!.to, f[11]!.label, f[11]!.to]).toEqual([
      '2026-10-12',
      '2026-10-31',
      'Sep 2027',
      '2027-09-30',
    ]);
    // On the first of a month there is nothing of it to date.
    expect(periods('2026-10-01', 'month').filter((p) => p.actual)).toHaveLength(6);
    // Weeks run Monday to Sunday: 12 October 2026 is a Monday.
    const w = periods('2026-10-14', 'week');
    expect(
      w
        .filter((p) => !p.actual)
        .map((p) => [p.from, p.to])
        .slice(0, 2),
    ).toEqual([
      ['2026-10-14', '2026-10-18'],
      ['2026-10-19', '2026-10-25'],
    ]);
    expect(w.find((p) => p.actual && p.to === '2026-10-13')!.from).toBe('2026-10-12');
  });

  it('moves dates by terms and places what is overdue as due now', () => {
    expect(addDays(monthEnd('2026-10-12'), 30 + 30)).toBe('2026-12-30');
    expect(monthEnd('2027-02-10')).toBe('2027-02-28');
    const ps = periods('2026-10-12', 'month');
    expect(placeForecast('2026-08-01', ps)!.label).toBe('Oct 2026');
    expect(placeForecast('2027-01-15', ps)!.label).toBe('Jan 2027');
    expect(placeForecast('2027-10-01', ps)).toBeNull();
  });

  it("works a bill's cash, spreads, and GST to the government", () => {
    // ₹1,00,000 of work: + 18% GST, − 5% retention, − 10% advance recovery, − 2% TDS = ₹1,01,000.
    expect(
      billCash(10_000_000n, { gstPct: '18', retentionPct: '5', advancePct: '10', tdsPct: '2' }),
    ).toEqual({ amount: 10_100_000n, gst: 1_800_000n });
    expect(spreadEven(1000n, 3)).toEqual([333n, 333n, 334n]);
    expect(spreadBy(1000n, [1n, 0n, 2n])).toEqual([333n, 0n, 667n]);
    expect(spreadBy(1000n, [0n, 0n])).toEqual([0n, 0n]);
    const f = (direction: 'in' | 'out', gstMonth: string, gst: bigint): Flow => ({
      date: `${gstMonth}-15`,
      amount: gst * 10n,
      gst,
      gstMonth,
      direction,
      kind: 'x',
      label: '',
    });
    // October: 18,000 out on bills, 5,000 in on purchases: 13,000 on 20 November. November: 2,000 out, 6,000 in: a
    // credit of 4,000 carried. December: 10,000 out less the 4,000: 6,000 on 20 January.
    expect(
      gstPayments(
        [
          f('in', '2026-10', 18_000n),
          f('out', '2026-10', 5_000n),
          f('in', '2026-11', 2_000n),
          f('out', '2026-11', 6_000n),
          f('in', '2026-12', 10_000n),
          f('in', '2026-09', 99_000n),
        ],
        '2026-10-12',
      ).map((g) => [g.date, g.amount]),
    ).toEqual([
      ['2026-11-20', 13_000n],
      ['2027-01-20', 6_000n],
    ]);
  });
});
