// Matching a revised BOQ file to the BOQ it revises, and the least change that turns one into the other
// (src/boq/import/revise.ts). No database: the plan is checked as data.
import { describe, expect, it } from 'vitest';
import { amountPaise, type Line } from '../src/boq/import/builder.js';
import {
  longestIncreasing,
  planRevision,
  type Existing,
  type Mapped,
} from '../src/boq/import/revise.js';

const ALL: Mapped = {
  code: true,
  description: true,
  notes: false,
  unit: true,
  qty: true,
  rate: true,
};
const NO_RATE: Mapped = { ...ALL, rate: false };

let row = 0;
const line = (
  depth: number,
  type: Line['type'],
  code: string | null,
  description: string,
  unit: string | null = null,
  qty: string | null = null,
  rate: string | null = null,
): Line => ({
  rowNo: ++row,
  type,
  depth,
  code,
  description,
  notes: '',
  unit,
  qty,
  rate,
  amountPaise: qty !== null && rate !== null ? amountPaise(qty, rate) : null,
});

/** The BOQ as stored: ids 1.., sort keys from the position, parents from the depth. */
function boq(lines: Line[], measured: string[] = []): Existing[] {
  const out: Existing[] = [];
  const stack: { id: string; key: string; next: number }[] = [];
  let top = 0;
  lines.forEach((l, i) => {
    stack.length = l.depth;
    const parent = l.depth ? stack[l.depth - 1]! : null;
    const seg = String(parent ? parent.next++ : top++).padStart(3, '0');
    const key = parent ? `${parent.key}!${seg}` : seg;
    const id = String(i + 1);
    out.push({
      id,
      parentId: parent?.id ?? null,
      sortKey: key,
      type: l.type,
      code: l.code,
      description: l.description,
      notes: '',
      unit: l.unit,
      qty: l.qty === null ? null : Number(l.qty).toFixed(4),
      rate: l.rate === null ? null : Number(l.rate).toFixed(4),
      measured: measured.includes(l.code ?? ''),
    });
    if (l.type === 'section') stack.push({ id, key, next: 0 });
  });
  return out;
}

const base = () => [
  line(0, 'section', 'A', 'Earthwork'),
  line(1, 'item', 'A.1', 'Excavation in ordinary soil', 'cum', '100', '350'),
  line(1, 'item', 'A.2', 'Backfilling in layers', 'cum', '40', '210'),
  line(0, 'section', 'B', 'Concrete'),
  line(1, 'item', 'B.1', 'PCC 1:4:8 below footings', 'cum', '12', '5200'),
  line(1, 'item', 'B.2', 'RCC M25 in footings', 'cum', '30', '7400'),
];

describe('longest increasing run', () => {
  it('keeps the most lines in their order', () => {
    expect(longestIncreasing(['a', 'b', 'c'])).toEqual([0, 1, 2]);
    expect(longestIncreasing(['b', 'a', 'c'])).toHaveLength(2);
    expect(longestIncreasing(['d', 'a', 'b', 'c'])).toEqual([1, 2, 3]);
    expect(longestIncreasing([])).toEqual([]);
  });
});

describe('planRevision', () => {
  it('changes nothing when the file is the BOQ', () => {
    const p = planRevision(boq(base()), base(), ALL);
    expect(p.ops).toEqual([]);
    expect(p.fields).toEqual([]);
    expect(p.summary).toMatchObject({
      matchedByCode: 6,
      unchanged: 6,
      added: 0,
      removed: 0,
      moved: 0,
    });
    expect(p.summary.total).toBe('327800.00');
  });

  it("keeps the BOQ's rates when the client's file has none, and takes its quantities", () => {
    const file = base().map((l) => ({ ...l, rate: null, amountPaise: null }));
    file[1] = { ...file[1]!, qty: '120' };
    const p = planRevision(boq(base()), file, ALL);
    expect(p.ops).toEqual([]);
    expect(p.fields).toEqual([
      expect.objectContaining({
        id: '2',
        qty: '120',
        rate: null,
        unmeasure: false,
        textChanged: false,
      }),
    ]);
    expect(p.summary).toMatchObject({ changed: 1, ratesKept: 4, ratesFromFile: 0 });
    // 120 × 350 instead of 100 × 350.
    expect(p.summary.total).toBe('334800.00');
    expect(p.summary.samples).toEqual([
      expect.objectContaining({ change: 'changed', code: 'A.1', detail: 'qty 100.0000 → 120' }),
    ]);
  });

  it('takes a new rate from the file (which unlinks the analysis) but not a blank one', () => {
    const file = base();
    file[4] = { ...file[4]!, rate: '5400' };
    const p = planRevision(boq(base()), file, ALL);
    expect(p.fields).toEqual([expect.objectContaining({ id: '5', rate: '5400' })]);
    expect(planRevision(boq(base()), file, NO_RATE).fields).toEqual([]);
  });

  it('inserts a new item after its neighbour and deletes a missing one', () => {
    const file = base();
    file.splice(2, 0, line(1, 'item', 'A.1a', 'Extra for hard rock', 'cum', '15', '900'));
    file.splice(5, 1); // B.1 gone
    const p = planRevision(boq(base()), file, ALL);
    expect(p.ops).toEqual([
      expect.objectContaining({
        op: 'insert',
        tempId: 'f2',
        parentId: '1',
        afterId: '2',
        code: 'A.1a',
        qty: '15',
      }),
      { op: 'delete', id: '5', rowVersion: 0 },
    ]);
    expect(p.summary).toMatchObject({ added: 1, removed: 1, moved: 0, changed: 0 });
  });

  it('moves only what left its place: a swap is one move', () => {
    const file = base();
    [file[1], file[2]] = [file[2]!, file[1]!];
    const p = planRevision(boq(base()), file, ALL);
    expect(p.ops).toHaveLength(1);
    expect(p.ops[0]).toMatchObject({ op: 'move', parentId: '1' });
    expect(p.summary.moved).toBe(1);
  });

  it('matches by description among the children of a matched section when codes were renumbered', () => {
    const file = base().map((l) =>
      l.code?.startsWith('B.') ? { ...l, code: l.code.replace('B.', 'B-') } : l,
    );
    const p = planRevision(boq(base()), file, ALL);
    expect(p.summary).toMatchObject({
      matchedByCode: 4,
      matchedByDescription: 2,
      added: 0,
      removed: 0,
    });
    expect(p.fields.map((f) => f.code)).toEqual(['B-1', 'B-2']);
  });

  it('finds an item moved to another section under a new code by its description and unit', () => {
    const file = base();
    const [moved] = file.splice(2, 1); // A.2 Backfilling
    file.push({ ...moved!, code: 'B.3' });
    const p = planRevision(boq(base()), file, ALL);
    expect(p.summary).toMatchObject({
      matchedByDescription: 1,
      added: 0,
      removed: 0,
      moved: 1,
      changed: 1,
    });
    expect(p.ops).toEqual([
      expect.objectContaining({ op: 'move', id: '3', parentId: '4', afterId: '6' }),
    ]);
  });

  it('places the children of a new section into it, and deletes a dropped section in one step', () => {
    const file = [
      ...base().slice(0, 3),
      line(0, 'section', 'C', 'Masonry'),
      line(1, 'item', 'C.1', 'Brickwork in CM 1:6', 'cum', '50', '6100'),
    ];
    const p = planRevision(boq(base()), file, ALL);
    expect(p.ops).toEqual([
      expect.objectContaining({
        op: 'insert',
        tempId: 'f3',
        parentId: null,
        afterId: '1',
        type: 'section',
      }),
      expect.objectContaining({
        op: 'insert',
        tempId: 'f4',
        parentId: 'f3',
        afterId: null,
        type: 'item',
      }),
      { op: 'delete', id: '4', rowVersion: 0 },
    ]);
    expect(p.summary).toMatchObject({ added: 2, removed: 3 });
  });

  it('does not guess between duplicates: two items with one code fall back to their descriptions', () => {
    const lines = [
      line(0, 'section', 'A', 'Earthwork'),
      line(1, 'item', '1', 'Excavation in ordinary soil', 'cum', '100', '350'),
      line(1, 'item', '1', 'Excavation in hard soil', 'cum', '20', '480'),
    ];
    const p = planRevision(boq(lines), lines, ALL);
    expect(p.summary).toMatchObject({
      matchedByCode: 1,
      matchedByDescription: 2,
      added: 0,
      removed: 0,
    });
    expect(p.ops).toEqual([]);
  });

  it('releases a measured quantity the file changes, and counts it', () => {
    const file = base();
    file[5] = { ...file[5]!, qty: '32' };
    const p = planRevision(boq(base(), ['B.2']), file, ALL);
    expect(p.fields).toEqual([expect.objectContaining({ id: '6', qty: '32', unmeasure: true })]);
    expect(p.summary.measuredOverridden).toBe(1);
  });

  it('notices a new description but never clears one with a blank cell', () => {
    const file = base();
    file[1] = { ...file[1]!, description: 'Excavation in all soils' };
    file[2] = { ...file[2]!, description: '' };
    const p = planRevision(boq(base()), file, ALL);
    expect(p.fields).toEqual([
      expect.objectContaining({
        id: '2',
        description: 'Excavation in all soils',
        textChanged: true,
      }),
    ]);
  });
});
