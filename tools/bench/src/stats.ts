export interface Timing {
  runs: number;
  first: number;
  p50: number;
  p95: number;
  max: number;
}

export function summarize(samples: number[]): Timing {
  if (samples.length === 0) throw new Error('no samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return {
    runs: samples.length,
    first: samples[0]!,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1]!,
  };
}

export async function timeIt<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

export async function sample(runs: number, fn: (i: number) => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) samples.push((await timeIt(() => fn(i))).ms);
  return summarize(samples);
}

/** First row of a query that must return exactly one row. */
export function one<T>(rows: readonly T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('expected one row, got none');
  return row;
}
