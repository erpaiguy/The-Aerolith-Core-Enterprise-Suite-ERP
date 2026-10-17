// The weekly work plan's arithmetic (docs/wave8-plan.md step 8d.2), by hand.
import { describe, expect, it } from 'vitest';
import { mondayOf, ppc } from '../src/schedule/make-ready.service.js';

describe('make-ready', () => {
  it('takes the Monday of the week', () => {
    expect([mondayOf('2026-10-14'), mondayOf('2026-10-12'), mondayOf('2026-10-18')]).toEqual([
      '2026-10-12',
      '2026-10-12',
      '2026-10-12',
    ]);
  });

  it('works the percent plan complete over the decided commitments', () => {
    expect(ppc([{ done: true }, { done: false }, { done: true }, { done: null }])).toBe(66.7);
    expect(ppc([{ done: null }])).toBeNull();
  });
});
