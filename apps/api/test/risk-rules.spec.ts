// The risk register's arithmetic by hand (docs/wave4-plan.md step 6).
import { describe, expect, it } from 'vitest';
import { band, DEFAULT_SCALES, expectedValue, heatMap, score } from '../src/control/risk-rules.js';

describe('risk rules', () => {
  it('scores, bands and expected value', () => {
    expect([score(2, 2), score(3, 3), score(4, 4), score(5, 4)].map(band)).toEqual([
      'low',
      'medium',
      'high',
      'extreme',
    ]);
    expect(band(score(5, 5))).toBe('extreme');
    // Likely (75%) × ₹2,00,000 = ₹1,50,000; possible (50%) × ₹33,333.33 = ₹16,666.67 (half up).
    expect(expectedValue(20_000_000n, 4, DEFAULT_SCALES)).toBe(15_000_000n);
    expect(expectedValue(3_333_333n, 3, DEFAULT_SCALES)).toBe(1_666_667n);
  });

  it('counts the heat map with the worst impact on top', () => {
    expect(
      heatMap([
        { probability: 4, impact: 5 },
        { probability: 4, impact: 5 },
        { probability: 1, impact: 1 },
      ]),
    ).toEqual([
      [0, 0, 0, 2, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [1, 0, 0, 0, 0],
    ]);
  });
});
