// Review workflows' rules (docs/wave5-plan.md step 1): when a stage closes and with what effect. Pure.

export type Effect = 'approve' | 'approve_comments' | 'return' | 'reject';
const RANK: Record<Effect, number> = { approve: 0, approve_comments: 1, return: 2, reject: 3 };
export const worst = (es: Effect[]): Effect =>
  es.reduce<Effect>((w, e) => (RANK[e] > RANK[w] ? e : w), 'approve');

/**
 * A stage's outcome so far: null while it is still open. "anyone" closes on its first response; "everyone" closes
 * at once on a return or a rejection (nothing anyone else says can change that), otherwise when all have answered.
 */
export function stageOutcome(mode: 'all' | 'any', responses: (Effect | null)[]): Effect | null {
  const done = responses.filter((r): r is Effect => r !== null);
  if (!done.length) return null;
  if (mode === 'any') return done[0]!;
  const w = worst(done);
  if (w === 'return' || w === 'reject') return w;
  return done.length === responses.length ? w : null;
}

export interface Reviewer {
  kind: 'user' | 'lead' | 'member' | 'designation';
  id?: string | undefined;
}
export interface Stage {
  name: string;
  mode: 'all' | 'any';
  dueDays: number;
  reviewers: Reviewer[];
}
