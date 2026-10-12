// CRM rules (docs/wave6-plan.md step 1): each stage's default probability, the weighted value of a lead, and the
// stage a converted lead takes from its tender.

export type Stage =
  'new' | 'qualified' | 'proposal' | 'negotiation' | 'tender' | 'won' | 'lost' | 'dropped';
export const OPEN: Stage[] = ['new', 'qualified', 'proposal', 'negotiation', 'tender'];

/** What a stage is usually worth, in per cent. */
export const DEFAULT_PROBABILITY: Record<Stage, number> = {
  new: 10,
  qualified: 25,
  proposal: 40,
  negotiation: 60,
  tender: 30,
  won: 100,
  lost: 0,
  dropped: 0,
};

/** A converted lead's stage follows its tender. */
export function stageFromTender(status: string): Stage {
  if (status === 'won') return 'won';
  if (['lost', 'no_bid', 'withdrawn', 'cancelled'].includes(status)) return 'lost';
  return 'tender';
}

/** The probability in use: the lead's own, else its stage's (won and lost are always 100 and 0). */
export function probabilityOf(stage: Stage, own: number | null): number {
  if (stage === 'won' || stage === 'lost' || stage === 'dropped') return DEFAULT_PROBABILITY[stage];
  return own ?? DEFAULT_PROBABILITY[stage];
}

/** Value × probability, in paise to stay exact; null value counts as nothing. */
export function weighted(valuePaise: bigint | null, probability: number): bigint {
  if (valuePaise === null) return 0n;
  return (valuePaise * BigInt(probability) + 50n) / 100n;
}

/** Moves a person may make by hand; conversion and the tender's outcome make the others. */
export function mayMove(from: Stage, to: Stage): boolean {
  if (from === to) return false;
  if (from === 'tender' || to === 'tender') return false;
  if (from === 'won' || from === 'lost') return false;
  if (from === 'dropped') return to === 'new' || to === 'qualified';
  return true;
}
