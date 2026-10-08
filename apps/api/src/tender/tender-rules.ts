// Pure tender rules (docs/wave1-plan.md "Step 1 decisions"): status flow, bid/no-bid scoring, numbering, reminders.

export const TENDER_STATUSES = [
  'lead',
  'evaluating',
  'bidding',
  'submitted',
  'won',
  'lost',
  'no_bid',
  'withdrawn',
  'cancelled',
] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

/** Statuses where the tender is still being worked on (deadlines matter, reminders are live). */
export const OPEN_STATUSES: readonly TenderStatus[] = [
  'lead',
  'evaluating',
  'bidding',
  'submitted',
];

/**
 * Manual moves. `bidding` and `no_bid` are deliberately missing as targets from `lead`/`evaluating`: they happen only
 * by recording a bid/no-bid decision, so every bid has a scored reason.
 */
const MANUAL: Record<TenderStatus, readonly TenderStatus[]> = {
  lead: ['evaluating', 'cancelled'],
  evaluating: ['lead', 'cancelled'],
  bidding: ['submitted', 'withdrawn', 'cancelled'],
  submitted: ['won', 'lost', 'withdrawn', 'cancelled'],
  no_bid: ['evaluating'],
  won: [],
  lost: [],
  withdrawn: [],
  cancelled: [],
};

export const allowedMoves = (from: TenderStatus): readonly TenderStatus[] => MANUAL[from];

/** Moves that need a written reason (shown in the activity log and win/loss analysis). */
export const REASON_REQUIRED: readonly TenderStatus[] = ['lost', 'withdrawn', 'cancelled'];

/** A decision can be recorded while the tender is not yet being priced, or reconsidered after a no-bid. */
export const DECISION_FROM: readonly TenderStatus[] = ['lead', 'evaluating', 'no_bid', 'bidding'];

export interface Criterion {
  key: string;
  label: string;
  weight: number;
  /** 1 (poor) .. 5 (excellent), from the contractor's point of view. */
  score: number;
}

export const DEFAULT_CRITERIA: readonly Omit<Criterion, 'score'>[] = [
  { key: 'strategic_fit', label: 'Strategic fit (vertical, size, client type)', weight: 3 },
  { key: 'client_payment', label: 'Client payment record', weight: 3 },
  { key: 'technical', label: 'Technical capability and experience', weight: 2 },
  { key: 'resources', label: 'Staff and resources available in time', weight: 2 },
  { key: 'competition', label: 'Competition (5 = few strong rivals)', weight: 1 },
  { key: 'margin', label: 'Margin potential', weight: 3 },
  { key: 'contract_risk', label: 'Contract terms and risk (5 = low risk)', weight: 2 },
  { key: 'location', label: 'Location and logistics', weight: 1 },
];

/** Weighted score as 0-100: each criterion scales 1..5 onto 0..1. One decimal place. */
export function bidScore(criteria: readonly Pick<Criterion, 'weight' | 'score'>[]): number {
  const total = criteria.reduce((a, c) => a + c.weight, 0);
  if (total <= 0) return 0;
  const got = criteria.reduce((a, c) => a + c.weight * ((c.score - 1) / 4), 0);
  return Math.round((got / total) * 1000) / 10;
}

/** Indian financial year (April-March) of an instant, in IST: "2026-27". */
export function financialYear(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export const formatNumber = (prefix: string, fy: string, n: number, padding: number): string =>
  `${prefix}/${fy}/${String(n).padStart(padding, '0')}`;

export interface ReminderPlan {
  dueAt: Date;
  title: string;
}

/** Deadline reminders for an open tender. Reminders whose time has already passed are skipped. */
export function deadlineReminders(
  t: { number: string; title: string; submissionDueAt: Date | null; prebidAt: Date | null },
  now: Date,
): ReminderPlan[] {
  const out: ReminderPlan[] = [];
  const day = 86_400_000;
  if (t.submissionDueAt) {
    for (const days of [3, 1]) {
      out.push({
        dueAt: new Date(t.submissionDueAt.getTime() - days * day),
        title: `Tender ${t.number} due in ${days} day${days === 1 ? '' : 's'}: ${t.title}`,
      });
    }
  }
  if (t.prebidAt) {
    out.push({
      dueAt: new Date(t.prebidAt.getTime() - day),
      title: `Pre-bid meeting tomorrow for tender ${t.number}: ${t.title}`,
    });
  }
  return out.filter((r) => r.dueAt > now);
}
