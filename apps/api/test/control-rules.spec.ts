// Cost control's arithmetic by hand (docs/wave4-plan.md step 1).
import { describe, expect, it } from 'vitest';
import { ctcDefault, rollUp, rowKey, splitKey, work } from '../src/control/control-rules.js';

describe('cost control rules', () => {
  it('computes cost to complete, forecast and variance', () => {
    // Budget 1,000, spent 400, ordered 200 still open: 600 left to spend, more than the 200 ordered.
    expect(ctcDefault({ budget: 1000n, actual: 400n, committed: 200n })).toBe(600n);
    // Ordered 800 more with 600 left: the commitment wins.
    expect(ctcDefault({ budget: 1000n, actual: 400n, committed: 800n })).toBe(800n);
    // Overspent and nothing ordered: nothing more.
    expect(ctcDefault({ budget: 1000n, actual: 1200n, committed: 0n })).toBe(0n);
    expect(work({ original: 900n, budget: 1000n, committed: 200n, actual: 400n }, null)).toEqual({
      original: 900n,
      budget: 1000n,
      committed: 200n,
      actual: 400n,
      changes: 100n,
      ctc: 600n,
      ctcComputed: true,
      forecast: 1000n,
      variance: 0n,
    });
    // Planning says 750 more: forecast 1,150, 150 over.
    expect(
      work({ original: 1000n, budget: 1000n, committed: 200n, actual: 400n }, 750n),
    ).toMatchObject({
      ctc: 750n,
      ctcComputed: false,
      forecast: 1150n,
      variance: -150n,
    });
  });

  it('rolls rows up a tree, and keeps what is not on it apart', () => {
    const nodes = [
      { id: 'a', parentId: null },
      { id: 'a1', parentId: 'a' },
      { id: 'a2', parentId: 'a' },
      { id: 'b', parentId: null },
    ];
    const r = rollUp(nodes, [
      { key: 'a1', sums: { budget: 100n, actual: 30n } },
      { key: 'a2', sums: { budget: 50n } },
      { key: 'a', sums: { actual: 5n } },
      { key: null, sums: { actual: 7n } },
      { key: 'gone', sums: { actual: 1n } },
    ]);
    expect(r.nodes.map((n) => [n.node.id, n.sums.budget, n.sums.actual])).toEqual([
      ['a', 150n, 35n],
      ['a1', 100n, 30n],
      ['a2', 50n, 0n],
      ['b', 0n, 0n],
    ]);
    expect(r.none.actual).toBe(8n);
    expect(splitKey(rowKey(null, 'c'))).toEqual({ wbsId: null, costCodeId: 'c' });
    expect(splitKey(rowKey('w', null))).toEqual({ wbsId: 'w', costCodeId: null });
  });
});
