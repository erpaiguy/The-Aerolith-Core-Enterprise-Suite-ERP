import { describe, expect, it } from 'vitest';
import { bidScore } from '../screens/TenderDetail';
import { daysUntil, formatInr, formatInrShort, fromLocalInput, toLocalInput } from './format';

describe('formatting', () => {
  it('formats rupees with Indian grouping and compact crore/lakh', () => {
    expect(formatInr('125000000.00')).toBe('₹12,50,00,000');
    expect(formatInr(null)).toBe('-');
    expect(formatInrShort('125000000')).toBe('₹12.5 Cr');
    expect(formatInrShort('4500000')).toBe('₹45 L');
    expect(formatInrShort('2000000000')).toBe('₹200 Cr');
    expect(formatInrShort('80000')).toBe('₹80,000');
  });

  it('round-trips datetime-local values', () => {
    const iso = '2026-11-03T09:30:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput('')).toBeNull();
  });

  it('counts calendar days to a date, whatever the time of day', () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
    const morning = new Date(2026, 9, 9, 9, 30);
    const night = new Date(2026, 9, 9, 23, 30);
    expect(daysUntil(at(19, 15), morning)).toBe(10);
    expect(daysUntil(at(19, 15), night)).toBe(10);
    expect(daysUntil(at(9, 18), morning)).toBe(0);
    expect(daysUntil(at(8, 18), morning)).toBe(-1);
    expect(daysUntil(new Date(2026, 10, 1, 0, 5).toISOString(), night)).toBe(23); // across a month end
  });

  it('scores bids exactly like the server', () => {
    expect(
      bidScore([
        { weight: 3, score: 5 },
        { weight: 1, score: 1 },
      ]),
    ).toBe(75);
    expect(bidScore([{ weight: 2, score: 4 }])).toBe(75);
    expect(bidScore([])).toBe(0);
  });
});
