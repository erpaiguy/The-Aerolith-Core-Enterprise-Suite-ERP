import { describe, expect, it } from 'vitest';
import {
  formatLink,
  parsePredecessors,
  predecessorOps,
  shortDate,
  type ProgrammeLink,
} from './model';

const codes = ['A1000', 'A1010', 'A1020', 'CIVFS'];

describe('predecessors as typed', () => {
  it('reads IDs with link types and lags, ignoring case and spaces', () => {
    expect(parsePredecessors('a1000, A1010SS+2; A1020 ff -1', codes)).toEqual({
      links: [
        { code: 'A1000', type: 'FS', lag: 0 },
        { code: 'A1010', type: 'SS', lag: 2 },
        { code: 'A1020', type: 'FF', lag: -1 },
      ],
      errors: [],
    });
  });

  it('understands an ID that ends in a link type, and reports unknown IDs', () => {
    expect(parsePredecessors('CIVFS, B9', codes)).toEqual({
      links: [{ code: 'CIVFS', type: 'FS', lag: 0 }],
      errors: ['"B9" is not an activity ID in this programme.'],
    });
  });

  it('writes them back the way they are typed', () => {
    expect(formatLink('A1010', { type: 'FS', lag: 0 })).toBe('A1010');
    expect(formatLink('A1010', { type: 'SS', lag: 2 })).toBe('A1010SS+2');
    expect(formatLink('A1010', { type: 'FS', lag: -3 })).toBe('A1010FS-3');
    expect(shortDate('2026-11-09')).toBe('9 Nov 26');
  });

  it('turns a changed list into link and unlink edits only for what changed', () => {
    const links: ProgrammeLink[] = [
      { pred: '1', succ: '9', type: 'FS', lag: 0 },
      { pred: '2', succ: '9', type: 'FS', lag: 0 },
    ];
    const ids: Record<string, string> = { A1000: '1', A1010: '2', A1020: '3' };
    const typed = parsePredecessors('A1000, A1010SS, A1020', codes).links;
    expect(predecessorOps('9', typed, links, (c) => ids[c]!)).toEqual([
      { op: 'link', pred: '2', succ: '9', type: 'SS', lag: 0 },
      { op: 'link', pred: '3', succ: '9', type: 'FS', lag: 0 },
    ]);
    expect(predecessorOps('9', [], links, (c) => ids[c]!)).toEqual([
      { op: 'unlink', pred: '1', succ: '9' },
      { op: 'unlink', pred: '2', succ: '9' },
    ]);
  });
});
