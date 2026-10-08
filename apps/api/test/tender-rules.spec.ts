import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CRITERIA,
  allowedMoves,
  bidScore,
  deadlineReminders,
  financialYear,
  formatNumber,
} from '../src/tender/tender-rules.js';

describe('tender rules', () => {
  it('only reaches bidding or no-bid through a decision', () => {
    expect(allowedMoves('lead')).not.toContain('bidding');
    expect(allowedMoves('evaluating')).not.toContain('bidding');
    expect(allowedMoves('evaluating')).not.toContain('no_bid');
    expect(allowedMoves('bidding')).toEqual(['submitted', 'withdrawn', 'cancelled']);
    expect(allowedMoves('submitted')).toContain('won');
    expect(allowedMoves('won')).toEqual([]);
    expect(allowedMoves('no_bid')).toEqual(['evaluating']);
  });

  it('scores 1 as 0 and 5 as 100, weighted', () => {
    const all = (score: number) => DEFAULT_CRITERIA.map((c) => ({ ...c, score }));
    expect(bidScore(all(1))).toBe(0);
    expect(bidScore(all(5))).toBe(100);
    expect(bidScore(all(3))).toBe(50);
    // weight 3 at 5, weight 1 at 1 -> 3/4 of the weight scores full marks.
    expect(
      bidScore([
        { weight: 3, score: 5 },
        { weight: 1, score: 1 },
      ]),
    ).toBe(75);
    expect(bidScore([{ weight: 0, score: 5 }])).toBe(0);
  });

  it('uses the Indian financial year in IST', () => {
    expect(financialYear(new Date('2026-04-01T00:00:00+05:30'))).toBe('2026-27');
    // 31 March 23:00 IST is still the previous year, even though it is 17:30 UTC.
    expect(financialYear(new Date('2027-03-31T23:00:00+05:30'))).toBe('2026-27');
    // 31 March 20:00 UTC is already 1 April in IST.
    expect(financialYear(new Date('2027-03-31T20:00:00Z'))).toBe('2027-28');
    expect(financialYear(new Date('2099-06-01T00:00:00Z'))).toBe('2099-00');
    expect(formatNumber('TND', '2026-27', 7, 4)).toBe('TND/2026-27/0007');
  });

  it('plans deadline reminders and skips those already past', () => {
    const now = new Date('2026-10-10T10:00:00Z');
    const plans = deadlineReminders(
      {
        number: 'TND/2026-27/0001',
        title: 'Hostel block',
        submissionDueAt: new Date('2026-10-12T09:30:00Z'), // 3-day reminder already past
        prebidAt: new Date('2026-10-15T06:00:00Z'),
      },
      now,
    );
    expect(plans.map((p) => p.dueAt.toISOString())).toEqual([
      '2026-10-11T09:30:00.000Z',
      '2026-10-14T06:00:00.000Z',
    ]);
    expect(plans[0]!.title).toBe('Tender TND/2026-27/0001 due in 1 day: Hostel block');
  });
});
