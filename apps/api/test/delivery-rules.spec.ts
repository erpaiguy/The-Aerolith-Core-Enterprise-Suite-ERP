import { describe, expect, it } from 'vitest';
import { daysBetween, slotsAgainst } from '../src/procurement/delivery-rules.js';

describe('delivery instalments (step 8e.2)', () => {
  const slots = [
    { dueOn: '2026-10-20', qty: '10' },
    { dueOn: '2026-10-05', qty: '10' },
    { dueOn: '2026-10-12', qty: '10' },
  ];

  it('sets what came against the instalments in date order', () => {
    expect(
      slotsAgainst(slots, '14', '2026-10-15').map((s) => [s.dueOn, s.came, s.short, s.state]),
    ).toEqual([
      ['2026-10-05', '10.0000', '0.0000', 'received'],
      ['2026-10-12', '4.0000', '6.0000', 'overdue'],
      ['2026-10-20', '0.0000', '10.0000', 'due'],
    ]);
  });

  it('shows a part delivery not yet due as part, and nothing come as due', () => {
    expect(slotsAgainst(slots, '15', '2026-10-01').map((s) => s.state)).toEqual([
      'received',
      'part',
      'due',
    ]);
    expect(slotsAgainst([], '5', '2026-10-01')).toEqual([]);
  });

  it('counts days between dates', () => {
    expect(daysBetween('2026-09-28', '2026-10-05')).toBe(7);
    expect(daysBetween(null, '2026-10-05')).toBeNull();
  });
});
