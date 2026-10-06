// Critical path method: forward and backward pass over an activity network.
// Durations and lags are in working days; calendars are not modelled in the benchmark (see the report).

export type RelationType = 'FS' | 'SS' | 'FF' | 'SF';

export interface Relation {
  pred: number;
  succ: number;
  type: RelationType;
  lag: number;
}

export interface CpmResult {
  es: Int32Array;
  ef: Int32Array;
  ls: Int32Array;
  lf: Int32Array;
  totalFloat: Int32Array;
  projectFinish: number;
}

/** Activities are indexed 0..n-1. Throws if the network contains a cycle. */
export function computeCpm(
  durations: ArrayLike<number>,
  relations: readonly Relation[],
): CpmResult {
  const n = durations.length;
  const outStart = new Int32Array(n + 1);
  const inStart = new Int32Array(n + 1);
  for (const r of relations) {
    if (r.pred < 0 || r.pred >= n || r.succ < 0 || r.succ >= n)
      throw new Error('relation out of range');
    outStart[r.pred + 1]!++;
    inStart[r.succ + 1]!++;
  }
  for (let i = 0; i < n; i++) {
    outStart[i + 1]! += outStart[i]!;
    inStart[i + 1]! += inStart[i]!;
  }
  const outRel = new Int32Array(relations.length);
  const inRel = new Int32Array(relations.length);
  const outFill = outStart.slice(0, n);
  const inFill = inStart.slice(0, n);
  relations.forEach((r, idx) => {
    outRel[outFill[r.pred]!++] = idx;
    inRel[inFill[r.succ]!++] = idx;
  });

  // Kahn topological order.
  const indegree = new Int32Array(n);
  for (let i = 0; i < n; i++) indegree[i] = inStart[i + 1]! - inStart[i]!;
  const order = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) if (indegree[i] === 0) order[tail++] = i;
  while (head < tail) {
    const a = order[head++]!;
    for (let k = outStart[a]!; k < outStart[a + 1]!; k++) {
      const s = relations[outRel[k]!]!.succ;
      if (--indegree[s]! === 0) order[tail++] = s;
    }
  }
  if (tail !== n) throw new Error('schedule network contains a cycle');

  const dur = (i: number): number => durations[i] as number;
  const es = new Int32Array(n);
  const ef = new Int32Array(n);
  for (let o = 0; o < n; o++) {
    const a = order[o]!;
    let start = 0;
    for (let k = inStart[a]!; k < inStart[a + 1]!; k++) {
      const r = relations[inRel[k]!]!;
      const p = r.pred;
      let bound: number;
      switch (r.type) {
        case 'FS':
          bound = ef[p]! + r.lag;
          break;
        case 'SS':
          bound = es[p]! + r.lag;
          break;
        case 'FF':
          bound = ef[p]! + r.lag - dur(a);
          break;
        case 'SF':
          bound = es[p]! + r.lag - dur(a);
          break;
      }
      if (bound > start) start = bound;
    }
    es[a] = start;
    ef[a] = start + dur(a);
  }

  let projectFinish = 0;
  for (let i = 0; i < n; i++) if (ef[i]! > projectFinish) projectFinish = ef[i]!;

  const ls = new Int32Array(n);
  const lf = new Int32Array(n);
  const totalFloat = new Int32Array(n);
  for (let o = n - 1; o >= 0; o--) {
    const a = order[o]!;
    let finish = projectFinish;
    for (let k = outStart[a]!; k < outStart[a + 1]!; k++) {
      const r = relations[outRel[k]!]!;
      const s = r.succ;
      let bound: number;
      switch (r.type) {
        case 'FS':
          bound = ls[s]! - r.lag;
          break;
        case 'SS':
          bound = ls[s]! - r.lag + dur(a);
          break;
        case 'FF':
          bound = lf[s]! - r.lag;
          break;
        case 'SF':
          bound = lf[s]! - r.lag + dur(a);
          break;
      }
      if (bound < finish) finish = bound;
    }
    lf[a] = finish;
    ls[a] = finish - dur(a);
    totalFloat[a] = ls[a]! - es[a]!;
  }
  return { es, ef, ls, lf, totalFloat, projectFinish };
}
