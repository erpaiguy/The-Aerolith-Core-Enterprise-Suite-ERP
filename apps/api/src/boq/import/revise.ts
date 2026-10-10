// Importing a client's revised BOQ into a draft that already has lines (docs/wave1-plan.md step 8, with addenda).
//
// 1. Match the file's lines to the BOQ's: by item code first (unique on both sides), then by description among the
//    children of a matched section, then by description and unit anywhere (items with a real description only).
// 2. Plan the least change that turns the BOQ into the file: lines whose order under the same section is unchanged
//    stay where they are (longest run in order); the rest move; new lines are inserted after their file neighbour;
//    lines missing from the file are deleted. These go through the BOQ engine like edits in the grid, so a revision
//    keeps only what changed and compare reads "changed", not "removed and re-added".
// 3. Field changes of matched lines are applied in one statement. A blank cell in the file never clears what the BOQ
//    has: a revised client BOQ usually has no rates, and the estimator's priced rates (and their analysis links) stay.
import type { NodeType, Op } from '../boq.service.js';
import { counted, KIND_LABEL, type ItemKind } from '../kinds.js';
import { amountPaise, paiseToString, type Line } from './builder.js';

export interface Existing {
  id: string;
  parentId: string | null;
  sortKey: string;
  type: NodeType;
  code: string | null;
  description: string;
  notes: string;
  unit: string | null;
  qty: string | null;
  rate: string | null;
  measured: boolean;
  kind: ItemKind;
}

/** Which columns the file has: a column that is not mapped changes nothing. */
export interface Mapped {
  code: boolean;
  description: boolean;
  notes: boolean;
  unit: boolean;
  qty: boolean;
  rate: boolean;
  /** The file has a Type column, which can say an item is a provisional sum, rate only or an alternate. */
  kind?: boolean | undefined;
}

export interface FieldChange {
  id: string;
  code: string | null;
  description: string;
  notes: string;
  unit: string | null;
  qty: string | null;
  /** A new rate from the file (unlinks its analysis); null keeps the BOQ's rate. */
  rate: string | null;
  kind: ItemKind;
  /** The quantity was measured and the file changes it: the sheet stays but no longer drives the quantity. */
  unmeasure: boolean;
  textChanged: boolean;
}

export type SampleChange = {
  change: 'added' | 'removed' | 'changed' | 'moved';
  code: string | null;
  description: string;
  detail: string;
};

export interface RevisionSummary {
  /** Lines of the BOQ before the import. */
  before: number;
  matchedByCode: number;
  matchedByDescription: number;
  unchanged: number;
  changed: number;
  moved: number;
  added: number;
  removed: number;
  measuredOverridden: number;
  /** Matched items with no rate in the file that keep the BOQ's rate. */
  ratesKept: number;
  ratesFromFile: number;
  /** The BOQ total after the import. */
  total: string;
  samples: SampleChange[];
}

export interface RevisionPlan {
  ops: Op[];
  fields: FieldChange[];
  summary: RevisionSummary;
}

const SAMPLES = 40;
/** Matching by description anywhere in the BOQ needs a description that says something. */
const GLOBAL_DESCRIPTION_MIN = 12;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const normCode = (c: string) => norm(c).replace(/\.+$/, '');

/** Same number, whatever the formatting ("10" and "10.0000"). Both null counts as equal. */
function sameNumber(a: string | null, b: string | null) {
  if (a === null || b === null) return a === b;
  return a === b || Number(a) === Number(b);
}

/** Indexes (into `values`) of a longest strictly increasing subsequence. */
export function longestIncreasing(values: string[]): number[] {
  const tails: number[] = []; // index of the smallest tail of each length
  const prev = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]!]! < values[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) out.push(i);
  return out.reverse();
}

export function planRevision(existing: Existing[], file: Line[], mapped: Mapped): RevisionPlan {
  // The file as a tree: each line's parent is the nearest section above it at a smaller depth.
  const fileParent: number[] = [];
  const fileChildren = new Map<number, number[]>(); // -1 = top level
  const stack: number[] = [];
  file.forEach((l, i) => {
    stack.length = l.depth;
    const p = l.depth > 0 ? (stack[l.depth - 1] ?? -1) : -1;
    fileParent.push(p);
    (fileChildren.get(p) ?? fileChildren.set(p, []).get(p)!).push(i);
    if (l.type === 'section') stack.push(i);
  });
  const byId = new Map(existing.map((e) => [e.id, e]));
  const existingChildren = new Map<string | null, Existing[]>();
  for (const e of existing)
    (
      existingChildren.get(e.parentId) ?? existingChildren.set(e.parentId, []).get(e.parentId)!
    ).push(e);

  // --- 1. matching ---
  const match = new Map<number, string>();
  const used = new Set<string>();
  let byCode = 0;
  let byDescription = 0;
  const pair = (i: number, id: string, how: 'code' | 'description') => {
    match.set(i, id);
    used.add(id);
    if (how === 'code') byCode++;
    else byDescription++;
  };
  const groups = <T>(xs: T[], key: (x: T) => string | null) => {
    const m = new Map<string, T[]>();
    for (const x of xs) {
      const k = key(x);
      if (k !== null) (m.get(k) ?? m.set(k, []).get(k)!).push(x);
    }
    return m;
  };
  const indexes = file.map((_, i) => i);

  if (mapped.code) {
    const codeKey = (type: string, code: string | null) =>
      code && normCode(code) ? `${type}|${normCode(code)}` : null;
    const ex = groups(existing, (e) => codeKey(e.type, e.code));
    for (const [k, fs] of groups(indexes, (i) => codeKey(file[i]!.type, file[i]!.code))) {
      const es = ex.get(k);
      if (fs.length === 1 && es?.length === 1) pair(fs[0]!, es[0]!.id, 'code');
    }
  }

  // Siblings with the same description, under a section that matched (or both at the top level). Parents come
  // before their children in the file, so a section matched here lets its children match next.
  const descKey = (type: string, d: string) => (norm(d) ? `${type}|${norm(d)}` : null);
  const siblingGroups = new Map<number, Map<string, number[]>>();
  const existingGroups = new Map<string | null, Map<string, Existing[]>>();
  for (const i of indexes) {
    if (match.has(i)) continue;
    const p = fileParent[i]!;
    const ep = p === -1 ? null : match.get(p);
    if (ep === undefined) continue;
    const k = descKey(file[i]!.type, file[i]!.description);
    if (k === null) continue;
    if (!siblingGroups.has(p))
      siblingGroups.set(
        p,
        groups(
          (fileChildren.get(p) ?? []).filter((j) => !match.has(j)),
          (j) => descKey(file[j]!.type, file[j]!.description),
        ),
      );
    if (!existingGroups.has(ep))
      existingGroups.set(
        ep,
        groups(
          (existingChildren.get(ep) ?? []).filter((e) => !used.has(e.id)),
          (e) => descKey(e.type, e.description),
        ),
      );
    const fs = siblingGroups.get(p)!.get(k);
    const es = existingGroups.get(ep)!.get(k);
    if (fs?.length === 1 && es?.length === 1 && !used.has(es[0]!.id))
      pair(i, es[0]!.id, 'description');
  }

  // Items that moved to another section with their code changed: same description and unit, unique everywhere.
  const globalKey = (type: string, d: string, unit: string | null) =>
    type === 'item' && norm(d).length >= GLOBAL_DESCRIPTION_MIN
      ? `${norm(d)}|${(unit ?? '').toLowerCase()}`
      : null;
  {
    const ex = groups(
      existing.filter((e) => !used.has(e.id)),
      (e) => globalKey(e.type, e.description, e.unit),
    );
    const fs = groups(
      indexes.filter((i) => !match.has(i)),
      (i) => globalKey(file[i]!.type, file[i]!.description, file[i]!.unit),
    );
    for (const [k, f] of fs) {
      const es = ex.get(k);
      if (f.length === 1 && es?.length === 1) pair(f[0]!, es[0]!.id, 'description');
    }
  }

  // --- 2. structure ---
  // Under each section of the file, the matched children that were already under the same section and stay in
  // the same order keep their place; everything else is placed after its neighbour in the file.
  const anchors = new Set<number>();
  for (const [p, kids] of fileChildren) {
    const ep = p === -1 ? null : match.get(p);
    if (ep === undefined) continue; // a new section: all its children are placed into it
    const stay = kids.filter((i) => {
      const id = match.get(i);
      return id !== undefined && byId.get(id)!.parentId === ep;
    });
    for (const k of longestIncreasing(stay.map((i) => byId.get(match.get(i)!)!.sortKey)))
      anchors.add(stay[k]!);
  }
  const ref = (i: number) => match.get(i) ?? `f${i}`;
  const ops: Op[] = [];
  const samples: SampleChange[] = [];
  const sample = (s: SampleChange) => samples.length < SAMPLES && samples.push(s);
  let moved = 0;
  let added = 0;
  const prevSibling = new Map<number, number>();
  for (const [, kids] of fileChildren)
    kids.forEach((k, j) => j > 0 && prevSibling.set(k, kids[j - 1]!));

  file.forEach((l, i) => {
    const p = fileParent[i]!;
    const parentId = p === -1 ? null : ref(p);
    const prev = prevSibling.get(i);
    const afterId = prev === undefined ? null : ref(prev);
    const id = match.get(i);
    if (id === undefined) {
      added++;
      sample({ change: 'added', code: l.code, description: l.description, detail: '' });
      ops.push({
        op: 'insert',
        tempId: `f${i}`,
        parentId,
        afterId,
        type: l.type,
        code: l.code,
        description: l.description,
        notes: l.notes,
        unit: l.type === 'item' ? l.unit : null,
        qty: l.type === 'item' ? l.qty : null,
        rate: l.type === 'item' ? l.rate : null,
        kind: l.type === 'item' ? l.kind : 'normal',
      });
    } else if (!anchors.has(i)) {
      moved++;
      const e = byId.get(id)!;
      sample({ change: 'moved', code: e.code, description: e.description, detail: '' });
      ops.push({ op: 'move', id, rowVersion: 0, parentId, afterId });
    }
  });

  // Lines not in the file go, after the moves (a deleted section takes only lines nobody kept with it).
  const gone = new Set<string>();
  let removed = 0;
  for (const e of existing) {
    if (used.has(e.id)) continue;
    removed++;
    sample({ change: 'removed', code: e.code, description: e.description, detail: '' });
    if (e.parentId !== null && gone.has(e.parentId)) {
      gone.add(e.id);
      continue;
    }
    gone.add(e.id);
    ops.push({ op: 'delete', id: e.id, rowVersion: 0 });
  }

  // --- 3. fields ---
  const fields: FieldChange[] = [];
  let measuredOverridden = 0;
  let ratesKept = 0;
  let ratesFromFile = 0;
  let total = 0n;
  file.forEach((f, i) => {
    const id = match.get(i);
    if (id === undefined) {
      if (f.amountPaise !== null) total += f.amountPaise;
      return;
    }
    const e = byId.get(id)!;
    const item = e.type === 'item';
    const code = mapped.code && f.code ? f.code : e.code;
    const description = mapped.description && f.description ? f.description : e.description;
    const notes = mapped.notes && f.notes ? f.notes : e.notes;
    const unit = item && mapped.unit && f.unit ? f.unit : e.unit;
    const qty = item && mapped.qty && f.qty !== null ? f.qty : e.qty;
    const fileRate = item && mapped.rate && f.rate !== null ? f.rate : null;
    const newRate = fileRate !== null && !sameNumber(fileRate, e.rate) ? fileRate : null;
    if (item && fileRate === null && e.rate !== null) ratesKept++;
    if (newRate !== null) ratesFromFile++;
    const kind = item && mapped.kind ? f.kind : e.kind;
    const qtyChanged = !sameNumber(qty, e.qty);
    const textChanged = description !== e.description || notes !== e.notes;
    const what = [
      code !== e.code && `code ${e.code ?? '-'} → ${code ?? '-'}`,
      unit !== e.unit && `unit ${e.unit ?? '-'} → ${unit ?? '-'}`,
      qtyChanged && `qty ${e.qty ?? '-'} → ${qty ?? '-'}`,
      newRate !== null && `rate ${e.rate ?? '-'} → ${newRate}`,
      kind !== e.kind && `${KIND_LABEL[e.kind]} → ${KIND_LABEL[kind]}`,
      description !== e.description && 'description',
      notes !== e.notes && 'notes',
    ].filter(Boolean) as string[];
    const rate = newRate ?? e.rate;
    if (item && counted(kind) && qty !== null && rate !== null) total += amountPaise(qty, rate);
    if (what.length === 0) return;
    const unmeasure = e.measured && qtyChanged;
    if (unmeasure) measuredOverridden++;
    sample({ change: 'changed', code, description, detail: what.join(', ') });
    fields.push({
      id,
      code,
      description,
      notes,
      unit,
      qty,
      rate: newRate,
      kind,
      unmeasure,
      textChanged,
    });
  });

  return {
    ops,
    fields,
    summary: {
      before: existing.length,
      matchedByCode: byCode,
      matchedByDescription: byDescription,
      unchanged: match.size - fields.length,
      changed: fields.length,
      moved,
      added,
      removed,
      measuredOverridden,
      ratesKept,
      ratesFromFile,
      total: paiseToString(total),
      samples,
    },
  };
}
