import { describe, expect, it } from 'vitest';
import { quarters } from '../src/dashboard/dashboard.service.js';
import { fyRange, TILES } from '../src/dashboard/tiles.js';

describe('dashboard rules', () => {
  it('buckets by quarter of the Indian financial year, in IST', () => {
    const q = quarters([
      // 31 March 19:00 UTC is 1 April 00:30 IST: the first quarter of the new year.
      { kind: 'submitted', at: new Date('2026-03-31T19:00:00Z'), value: null },
      { kind: 'won', at: new Date('2026-07-01T00:00:00Z'), value: '1000.50' },
      { kind: 'won', at: new Date('2026-09-30T10:00:00Z'), value: '500' },
      { kind: 'lost', at: new Date('2026-12-31T20:00:00Z'), value: null }, // 1 January IST: Q4
      { kind: 'submitted', at: new Date('2027-03-31T12:00:00Z'), value: null },
    ]);
    expect(q).toEqual([
      { quarter: 'Q1', submitted: 1, won: 0, lost: 0, wonValue: '0.00' },
      { quarter: 'Q2', submitted: 0, won: 2, lost: 0, wonValue: '1500.50' },
      { quarter: 'Q3', submitted: 0, won: 0, lost: 0, wonValue: '0.00' },
      { quarter: 'Q4', submitted: 1, won: 0, lost: 1, wonValue: '0.00' },
    ]);
  });

  it('gives a financial year its IST bounds', () => {
    expect(fyRange('2026-27')).toEqual({
      from: '2026-04-01T00:00:00+05:30',
      to: '2027-04-01T00:00:00+05:30',
    });
  });

  it('has three fixed tiles per dashboard and unique keys', () => {
    expect(TILES.filter((t) => t.dashboard === 'tender' && t.fixed).map((t) => t.key)).toEqual([
      'deadlines',
      'pipeline_value',
      'security_expiries',
    ]);
    expect(TILES.filter((t) => t.dashboard === 'estimation' && t.fixed)).toHaveLength(3);
    expect(new Set(TILES.map((t) => t.key)).size).toBe(TILES.length);
  });
});
