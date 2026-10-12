// Cost control's arithmetic (docs/wave4-plan.md step 1): each row's cost to complete, forecast and variance, and the
// roll-up of rows into a tree. Money in paise (bigint). Pure.

export interface Figures {
  original: bigint;
  budget: bigint;
  committed: bigint;
  actual: bigint;
}
export interface Worked extends Figures {
  changes: bigint;
  ctc: bigint;
  ctcComputed: boolean;
  forecast: bigint;
  variance: bigint;
}

/** Where planning has entered nothing: the budget still unspent, or what is already ordered, whichever is larger. */
export function ctcDefault(f: Pick<Figures, 'budget' | 'committed' | 'actual'>): bigint {
  const left = f.budget - f.actual;
  const want = left > f.committed ? left : f.committed;
  return want > 0n ? want : 0n;
}

export function work(f: Figures, entered: bigint | null): Worked {
  const ctc = entered ?? ctcDefault(f);
  const forecast = f.actual + ctc;
  return {
    ...f,
    changes: f.budget - f.original,
    ctc,
    ctcComputed: entered === null,
    forecast,
    variance: f.budget - forecast,
  };
}

export const FIELDS = [
  'original',
  'budget',
  'changes',
  'committed',
  'actual',
  'ctc',
  'forecast',
  'variance',
] as const;
export type Field = (typeof FIELDS)[number];
export type Sums = Record<Field, bigint>;
export const zero = (): Sums => Object.fromEntries(FIELDS.map((k) => [k, 0n])) as Sums;
export function addInto(to: Sums, from: Partial<Record<Field, bigint>>) {
  for (const k of FIELDS) to[k] += from[k] ?? 0n;
}

/**
 * Sums rows into tree nodes (given in tree order, children after their parent) and every ancestor. Rows whose key is
 * not a node (or null) land in `none`.
 */
export function rollUp<N extends { id: string; parentId: string | null }>(
  nodes: N[],
  rows: { key: string | null; sums: Partial<Record<Field, bigint>> }[],
) {
  const total = new Map(nodes.map((n) => [n.id, zero()]));
  const none = zero();
  for (const r of rows) addInto((r.key && total.get(r.key)) || none, r.sums);
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
  for (const n of [...nodes].reverse()) {
    const p = parentOf.get(n.id);
    const pt = p ? total.get(p) : undefined;
    if (pt) addInto(pt, total.get(n.id)!);
  }
  return { nodes: nodes.map((n) => ({ node: n, sums: total.get(n.id)! })), none };
}

export const rowKey = (wbsId: string | null, costCodeId: string | null) =>
  `${wbsId ?? ''}|${costCodeId ?? ''}`;
export const splitKey = (k: string) => {
  const [w = '', c = ''] = k.split('|');
  return { wbsId: w || null, costCodeId: c || null };
};
