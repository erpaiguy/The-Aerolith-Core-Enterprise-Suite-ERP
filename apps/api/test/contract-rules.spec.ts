// Contracts' arithmetic by hand (docs/wave4-plan.md step 5).
import { describe, expect, it } from 'vitest';
import { eotDays, reminderDates } from '../src/control/contract-rules.js';

describe('contract rules', () => {
  it('counts days lost from hindrances', () => {
    const r = eotDays([
      // 3 Sep: drawings 3 h and rain 2 h: 5 h, one day, to drawings.
      { date: '2026-09-03', cause: 'drawings', hours: 3, account: 'client' },
      { date: '2026-09-03', cause: 'rain', hours: 2, account: 'neutral' },
      // 4 Sep: 3 h only: not a day.
      { date: '2026-09-04', cause: 'client_decision', hours: 3, account: 'client' },
      // 5 Sep: 8 h of rain.
      { date: '2026-09-05', cause: 'rain', hours: 8, account: 'neutral' },
      // 6 Sep: the contractor's own: not counted.
      { date: '2026-09-06', cause: 'labour', hours: 8, account: 'contractor' },
    ]);
    expect(r).toEqual({
      days: 2,
      byCause: { drawings: 1, rain: 1 },
      dates: ['2026-09-03', '2026-09-05'],
    });
  });

  it('plans reminders ahead of a date', () => {
    const now = new Date('2026-10-12T10:00:00+05:30');
    expect(
      reminderDates('2026-11-30', [30, 7], now).map((r) => [r.days, r.at.toISOString()]),
    ).toEqual([
      [30, '2026-10-31T03:30:00.000Z'],
      [7, '2026-11-23T03:30:00.000Z'],
    ]);
    // 30 days before 1 November has passed: only the 7-day one.
    expect(reminderDates('2026-11-01', [30, 7], now).map((r) => r.days)).toEqual([7]);
  });
});
