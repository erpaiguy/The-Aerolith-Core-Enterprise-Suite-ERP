// The risk register's arithmetic (docs/wave4-plan.md step 6): scores and their bands, expected value, the heat map.
// Pure. Money in paise.

export interface Scales {
  probability: { level: number; label: string; pct: number }[];
  impact: { level: number; label: string }[];
}
export const DEFAULT_SCALES: Scales = {
  probability: [
    { level: 1, label: 'Rare', pct: 5 },
    { level: 2, label: 'Unlikely', pct: 20 },
    { level: 3, label: 'Possible', pct: 50 },
    { level: 4, label: 'Likely', pct: 75 },
    { level: 5, label: 'Almost certain', pct: 95 },
  ],
  impact: [
    { level: 1, label: 'Negligible' },
    { level: 2, label: 'Minor' },
    { level: 3, label: 'Moderate' },
    { level: 4, label: 'Major' },
    { level: 5, label: 'Severe' },
  ],
};

export type Band = 'low' | 'medium' | 'high' | 'extreme';
export const score = (probability: number, impact: number) => probability * impact;
export const band = (s: number): Band =>
  s <= 4 ? 'low' : s <= 9 ? 'medium' : s <= 16 ? 'high' : 'extreme';

/** Probability % × cost impact, to the paisa (half up). */
export function expectedValue(costPaise: bigint, probability: number, scales: Scales) {
  const pct = scales.probability.find((p) => p.level === probability)?.pct ?? 0;
  return (costPaise * BigInt(Math.round(pct * 100)) + 5_000n) / 10_000n;
}

/** Open risks counted by impact (rows, 5 down to 1) and probability (columns, 1 to 5). */
export function heatMap(risks: { probability: number; impact: number }[]) {
  const grid = [5, 4, 3, 2, 1].map(() => [0, 0, 0, 0, 0]);
  for (const r of risks) grid[5 - r.impact]![r.probability - 1]! += 1;
  return grid;
}
