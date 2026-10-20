import { describe, expect, it } from 'vitest';
import { percentile } from '../src/load.js';

describe('load test figures', () => {
  it('picks the nearest-rank percentile', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
  });
});
