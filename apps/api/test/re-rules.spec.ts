import { describe, expect, it } from 'vitest';
import {
  agreementValue,
  allocate,
  daysLate,
  delayInterest,
  demandOf,
  reraShare,
  rupees,
  withdrawable,
  withinTenPercent,
} from '../src/realestate/re-rules.js';

describe('real estate rules', () => {
  it('prices a unit: carpet × rate + parking + charges', () => {
    // 65.5 m² at ₹1,20,000 = ₹78,60,000; parking ₹3,00,000; charges ₹1,50,000.
    expect(
      rupees(
        agreementValue({
          carpetSqm: '65.5',
          ratePerSqm: '120000',
          parking: '300000',
          charges: '150000',
        }),
      ),
    ).toBe('8310000.00');
  });

  it('raises a stage with GST split in halves', () => {
    const d = demandOf(831_000_000n, '30', '5');
    expect([rupees(d.base), rupees(d.cgst), rupees(d.sgst), rupees(d.total)]).toEqual([
      '2493000.00',
      '62325.00',
      '62325.00',
      '2617650.00',
    ]);
    const odd = demandOf(10_010n, '100', '5');
    expect(odd.cgst - odd.sgst).toBe(1n);
  });

  it('keeps demands before the agreement within 10%', () => {
    expect(withinTenPercent(831_000_000n, 0n, 83_100_000n)).toBe(true);
    expect(withinTenPercent(831_000_000n, 83_100_000n, 1n)).toBe(false);
  });

  it('charges simple interest by day', () => {
    // ₹26,17,650 for 30 days at 10.75%: 26,17,650 × 0.1075 × 30 / 365 = ₹23,128.55
    expect(rupees(delayInterest(261_765_000n, '10.75', 30))).toBe('23128.55');
    expect(delayInterest(100n, '10', 0)).toBe(0n);
    expect(daysLate('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysLate('2026-10-01', '2026-09-30')).toBe(0);
  });

  it('puts 70% of what is not GST in the designated account, and limits withdrawals', () => {
    expect(rupees(reraShare(2_617_650_00n, 124_650_00n, '70'))).toBe('1745100.00');
    expect(rupees(withdrawable(1_000_000_00n, '35', 200_000_00n))).toBe('150000.00');
    expect(withdrawable(1_000_000_00n, '10', 200_000_00n)).toBe(0n);
  });

  it('allocates oldest first with the GST in proportion', () => {
    const r = allocate(150_000n, [
      { id: 'a', base: 100_000n, gst: 5_000n, open: 105_000n },
      { id: 'b', base: 100_000n, gst: 5_000n, open: 105_000n },
    ]);
    expect(r.allocations).toEqual([
      { id: 'a', amount: 105_000n, gst: 5_000n },
      { id: 'b', amount: 45_000n, gst: 2_143n },
    ]);
    expect(r.unallocated).toBe(0n);
    expect(allocate(10n, []).unallocated).toBe(10n);
  });
});
