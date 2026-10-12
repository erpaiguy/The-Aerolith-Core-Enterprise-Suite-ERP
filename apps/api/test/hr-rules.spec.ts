// HR's rules by hand (docs/wave3-plan.md step 11): weekdays and holidays, leave accrued in a year, a biometric
// device's punches made into days, and a phone's distance from its site.
import { describe, expect, it } from 'vitest';
import { accrued, dayKind, distanceM, punchDays, weekdayBit } from '../src/hr/hr-rules.js';

describe('HR rules', () => {
  it('reads weekdays and holidays by a calendar', () => {
    expect(weekdayBit('2026-09-07')).toBe(1); // a Monday
    expect(weekdayBit('2026-09-12')).toBe(32); // a Saturday
    expect(weekdayBit('2026-09-13')).toBe(64); // a Sunday
    const holidays = new Set(['2026-10-02']);
    expect(dayKind('2026-10-02', 63, holidays)).toBe('holiday');
    expect(dayKind('2026-10-03', 63, holidays)).toBe('work'); // Saturday in a six-day week
    expect(dayKind('2026-10-03', 31, holidays)).toBe('week_off'); // not in a five-day week
    expect(dayKind('2026-10-04', 63, holidays)).toBe('week_off');
  });

  it('accrues leave by the year or the month, to half days', () => {
    const casual = { daysPerYear: '12', accrual: 'annual' as const };
    const earned = { daysPerYear: '15', accrual: 'monthly' as const };
    expect(accrued(casual, 2026, '2024-06-01', '2026-01-01')).toBe(12);
    // Joined in April: nine months of twelve.
    expect(accrued(casual, 2026, '2026-04-15', '2026-04-15')).toBe(9);
    expect(accrued(casual, 2026, '2026-04-15', '2026-04-14')).toBe(0);
    // 15 a year by the month: 1.25 a month, so 1 by January, 2.5 by February, 11.25 → 11 by September.
    expect(accrued(earned, 2026, '2020-01-01', '2026-01-31')).toBe(1);
    expect(accrued(earned, 2026, '2020-01-01', '2026-02-01')).toBe(2.5);
    expect(accrued(earned, 2026, '2020-01-01', '2026-09-10')).toBe(11);
    expect(accrued(earned, 2026, '2020-01-01', '2027-03-01')).toBe(15);
    // Joined 20 March: March to September, seven months, 8.75 → 8.5.
    expect(accrued(earned, 2026, '2026-03-20', '2026-09-10')).toBe(8.5);
    expect(accrued(earned, 2026, '2020-01-01', '2025-12-31')).toBe(0);
  });

  it('measures how far the phone was', () => {
    expect(distanceM(19.076, 72.8777, 19.076, 72.8777)).toBe(0);
    // 0.001° of latitude is about 111 metres anywhere.
    expect(distanceM(19.076, 72.8777, 19.077, 72.8777)).toBe(111);
    // 0.001° of longitude at 19° north is cos(19.076°) × 111 ≈ 105 metres.
    expect(distanceM(19.076, 72.8777, 19.076, 72.8787)).toBe(105);
  });

  it('makes a device’s punches into days', () => {
    const { days, skipped } = punchDays([
      ['Attendance log'],
      ['Emp Name', 'Emp Code', 'Date', 'Time'],
      ['Ravi', 'E001', '01/09/2026', '09:02'],
      ['Ravi', 'E001', '01/09/2026', '13:10'],
      ['Ravi', 'E001', '01/09/2026', '18:05'],
      ['Ravi', 'e001', '02/09/2026', '09:00'],
      ['Ravi', 'E001', '02/09/2026', '12:30'],
      ['Asha', 'E002', '2026-09-01', '8:55 AM'],
      ['Asha', 'E002', '2026-09-01', '05:40 PM'],
      ['Asha', 'E002', '03-09-2026', '10:00'],
      ['Nobody', '', '01/09/2026', '09:00'],
      ['Asha', 'E002', '31/02/2026', '09:00'],
      ['', '', '', ''],
    ]);
    expect(skipped).toEqual([11, 12]);
    expect(days).toEqual([
      {
        code: 'E001',
        day: '2026-09-01',
        first: '09:02',
        last: '18:05',
        punches: 3,
        status: 'present',
        flag: null,
      },
      {
        code: 'E001',
        day: '2026-09-02',
        first: '09:00',
        last: '12:30',
        punches: 2,
        status: 'half_day',
        flag: null,
      },
      {
        code: 'E002',
        day: '2026-09-01',
        first: '08:55',
        last: '17:40',
        punches: 2,
        status: 'present',
        flag: null,
      },
      {
        code: 'E002',
        day: '2026-09-03',
        first: '10:00',
        last: '10:00',
        punches: 1,
        status: 'present',
        flag: 'single_punch',
      },
    ]);
  });

  it('reads one date-and-time column too, and refuses a file without codes', () => {
    const { days } = punchDays([
      ['Code', 'Punch time'],
      ['E9', '2026-09-04 08:00'],
      ['E9', '2026-09-04 12:00'],
    ]);
    expect(days).toEqual([
      {
        code: 'E9',
        day: '2026-09-04',
        first: '08:00',
        last: '12:00',
        punches: 2,
        status: 'present',
        flag: null,
      },
    ]);
    expect(() => punchDays([['Date', 'Time']])).toThrow();
  });
});
