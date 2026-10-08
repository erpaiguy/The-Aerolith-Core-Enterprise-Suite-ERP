import { describe, expect, it } from 'vitest';
import { ancestorKeys, childKey, midpoint, segmentFor, splitKey, SUBTREE_END } from './sort-key.js';

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // byte order, like COLLATE "C"

describe('midpoint', () => {
  it('always lands strictly between its bounds', () => {
    let keys = [segmentFor(1), segmentFor(2)];
    // Insert repeatedly between the first two keys, the worst case for key growth.
    for (let i = 0; i < 200; i++) {
      const m = midpoint(keys[0]!, keys[1]!);
      expect(keys[0]! < m && m < keys[1]!).toBe(true);
      expect(m.endsWith('0')).toBe(false);
      keys = [keys[0]!, m, ...keys.slice(1)];
    }
    expect([...keys].sort(cmp)).toEqual(keys);
  });

  it('handles open bounds', () => {
    const first = segmentFor(0);
    expect(midpoint('', first) < first).toBe(true);
    expect(midpoint(first, null) > first).toBe(true);
  });

  it('rejects inverted bounds', () => {
    expect(() => midpoint(segmentFor(2), segmentFor(1))).toThrow();
  });
});

describe('hierarchical keys', () => {
  it('sort depth-first and bound subtrees', () => {
    const a = segmentFor(1);
    const b = segmentFor(2);
    const a1 = childKey(a, segmentFor(1));
    const a1x = childKey(a1, segmentFor(7));
    const a2 = childKey(a, segmentFor(2));
    const between = midpoint(a, b); // a sibling inserted after a
    const ordered = [a, a1, a1x, a2, between, b];
    expect([...ordered].sort(cmp)).toEqual(ordered);
    // Everything in a's subtree is < a + SUBTREE_END, and the next sibling is not.
    for (const k of [a1, a1x, a2]) expect(k < a + SUBTREE_END).toBe(true);
    expect(between > a + SUBTREE_END).toBe(true);
    expect(splitKey(a1x)).toEqual({ parent: a1, segment: segmentFor(7) });
  });
});

describe('ancestorKeys', () => {
  it('lists every ancestor, root first', () => {
    expect(ancestorKeys('a!b!c')).toEqual(['a', 'a!b']);
    expect(ancestorKeys('a')).toEqual([]);
  });
});
