import { describe, expect, it } from 'vitest';
import { canonicalJson, compareVersions } from './release.js';

describe('releases', () => {
  it('orders versions as people read them', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('0.9.0', '1.0.0-rc.1')).toBe(-1);
    expect(compareVersions('2.0.0-rc.2', '2.0.0-rc.1')).toBe(1);
  });

  it('writes the same JSON however the keys were ordered', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});
