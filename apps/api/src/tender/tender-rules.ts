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
  t: {
    number: string;
    title: string;
    submissionDueAt: Date | null;
    prebidAt: Date | null;
    queriesDueAt?: Date | null;
  },
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
  if (t.queriesDueAt) {
    out.push({
      dueAt: new Date(t.queriesDueAt.getTime() - day),
      title: `Last day for pre-bid queries tomorrow, tender ${t.number}: ${t.title}`,
    });
  }
  return out.filter((r) => r.dueAt > now);
}

// --- step 8: tender management detail ---

/** 09:00 in India on a calendar date ("YYYY-MM-DD"), `daysBefore` days earlier. Date-only deadlines remind then. */
export function istMorning(date: string, daysBefore = 0): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - daysBefore, 3, 30));
}

/** Instruments that run out: their expiry needs watching while the client holds them (or before they go in). */
export const EXPIRING_FORMS: readonly string[] = ['bank_guarantee', 'fdr', 'insurance_bond'];
export const LIVE_SECURITY: readonly string[] = ['issued', 'submitted'];

/** Expiry reminders for a bank guarantee (or FDR, bond): 30 and 7 days before it runs out, at 09:00 IST. */
export function securityReminders(
  s: {
    form: string;
    status: string;
    validUntil: string | null;
    amount: string;
    bank: string | null;
  },
  tender: { number: string },
  now: Date,
): ReminderPlan[] {
  if (!s.validUntil || !EXPIRING_FORMS.includes(s.form) || !LIVE_SECURITY.includes(s.status))
    return [];
  const what = `${s.form === 'bank_guarantee' ? 'Bank guarantee' : s.form === 'fdr' ? 'FDR' : 'Insurance bond'}${s.bank ? ` (${s.bank})` : ''} for tender ${tender.number}`;
  return [30, 7]
    .map((days) => ({
      dueAt: istMorning(s.validUntil!, days),
      title: `${what} expires in ${days} days, on ${s.validUntil}: extend it or ask for its return`,
    }))
    .filter((r) => r.dueAt > now);
}

/**
 * The last day a bid security must stay valid: the bid validity counted from the submission date. Clients usually
 * ask for some days more (often 45), so a guarantee expiring before this is certainly short.
 */
export function bidValidityEnd(submissionDueAt: Date | null, validityDays: number | null) {
  if (!submissionDueAt || !validityDays) return null;
  const ist = new Date(submissionDueAt.getTime() + 330 * 60_000);
  ist.setUTCDate(ist.getUTCDate() + validityDays);
  return ist.toISOString().slice(0, 10);
}

/** Tender statuses after which an EMD still with the client should come back. */
export const EMD_RETURN_DUE: readonly TenderStatus[] = ['lost', 'cancelled', 'withdrawn', 'no_bid'];

/** Bids ranked as at an opening: qualified bids with a value, lowest first (L1); equal values share a rank. */
export function rankBids<T extends { quotedValue: string | null; qualified: boolean }>(
  bids: readonly T[],
): (T & { rank: number | null })[] {
  const ranked = bids
    .filter((b) => b.qualified && b.quotedValue !== null)
    .map((b) => Number(b.quotedValue))
    .sort((a, b) => a - b);
  return bids.map((b) => ({
    ...b,
    rank: b.qualified && b.quotedValue !== null ? ranked.indexOf(Number(b.quotedValue)) + 1 : null,
  }));
}

export type Envelope = 'technical' | 'financial' | 'other';

/**
 * Documents most Indian works tenders ask for (CPWD/state PWD style). Added on request and editable per tender;
 * items that only apply sometimes are not required.
 */
export const CHECKLIST_TEMPLATE: readonly {
  envelope: Envelope;
  title: string;
  required: boolean;
}[] = [
  { envelope: 'technical', title: 'Tender fee paid (receipt)', required: true },
  {
    envelope: 'technical',
    title: 'EMD / bid security, or MSE exemption certificate',
    required: true,
  },
  {
    envelope: 'technical',
    title: 'Tender document signed on every page, with all addenda',
    required: true,
  },
  { envelope: 'technical', title: 'Letter of bid on letterhead', required: true },
  {
    envelope: 'technical',
    title: 'Power of attorney / authorisation of the signatory',
    required: true,
  },
  { envelope: 'technical', title: 'PAN card', required: true },
  { envelope: 'technical', title: 'GST registration certificate', required: true },
  {
    envelope: 'technical',
    title: 'Contractor registration (class / category), if asked',
    required: false,
  },
  {
    envelope: 'technical',
    title: 'Udyam (MSE) certificate, if claiming exemption or preference',
    required: false,
  },
  { envelope: 'technical', title: 'Completion certificates of similar works', required: true },
  {
    envelope: 'technical',
    title: 'Annual turnover: CA certificate or audited accounts, last 3 years',
    required: true,
  },
  { envelope: 'technical', title: 'Income tax returns, last 3 years', required: true },
  { envelope: 'technical', title: 'Bank solvency certificate', required: false },
  {
    envelope: 'technical',
    title: 'Affidavit: not blacklisted, no abandoned works',
    required: true,
  },
  { envelope: 'technical', title: 'Integrity pact, if applicable', required: false },
  { envelope: 'technical', title: 'Plant and equipment list', required: false },
  { envelope: 'technical', title: 'Key staff with CVs', required: false },
  { envelope: 'technical', title: 'Construction methodology and work programme', required: false },
  { envelope: 'technical', title: 'EPF / ESI registration and labour licence', required: false },
  { envelope: 'financial', title: 'Priced BOQ / financial bid', required: true },
  { envelope: 'financial', title: 'Rate analysis of major items, if asked', required: false },
];
