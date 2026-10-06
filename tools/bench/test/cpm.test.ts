import { describe, expect, it } from 'vitest';
import { computeCpm, type Relation } from '../src/cpm.js';

describe('computeCpm', () => {
  it('computes dates and float for a small network', () => {
    // 0 -> 1 -> 3 (critical, 10 days), 0 -> 2 -> 3 (2 has 3 days float)
    const durations = [2, 5, 2, 3];
    const relations: Relation[] = [
      { pred: 0, succ: 1, type: 'FS', lag: 0 },
      { pred: 0, succ: 2, type: 'FS', lag: 0 },
      { pred: 1, succ: 3, type: 'FS', lag: 0 },
      { pred: 2, succ: 3, type: 'FS', lag: 0 },
    ];
    const r = computeCpm(durations, relations);
    expect(Array.from(r.es)).toEqual([0, 2, 2, 7]);
    expect(Array.from(r.ef)).toEqual([2, 7, 4, 10]);
    expect(r.projectFinish).toBe(10);
    expect(Array.from(r.totalFloat)).toEqual([0, 0, 3, 0]);
  });

  it('applies SS, FF and SF relations with lags', () => {
    const durations = [4, 3, 6, 2];
    const relations: Relation[] = [
      { pred: 0, succ: 1, type: 'SS', lag: 1 }, // 1 starts >= 1
      { pred: 0, succ: 2, type: 'FF', lag: 2 }, // 2 finishes >= 6 -> starts >= 0
      { pred: 1, succ: 3, type: 'SF', lag: 5 }, // 3 finishes >= es1 + 5 = 6 -> starts >= 4
    ];
    const r = computeCpm(durations, relations);
    expect(Array.from(r.es)).toEqual([0, 1, 0, 4]);
    expect(r.projectFinish).toBe(6);
    expect(Array.from(r.totalFloat).every((f) => f >= 0)).toBe(true);
  });

  it('rejects cycles', () => {
    expect(() =>
      computeCpm(
        [1, 1],
        [
          { pred: 0, succ: 1, type: 'FS', lag: 0 },
          { pred: 1, succ: 0, type: 'FS', lag: 0 },
        ],
      ),
    ).toThrow(/cycle/);
  });
});
