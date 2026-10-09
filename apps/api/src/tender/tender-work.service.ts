// Tender management detail (docs/04-features.md E7, docs/wave1-plan.md step 8): pre-bid queries, addenda, EMD and
// bank guarantees, the submission checklist, submissions, the bids read out at the opening, the result, an agenda
// of dates and the win/loss analysis. All of it hangs off a tender. Changes need `tender.edit` (checked by the
// controller), except that whoever a checklist item is assigned to may mark it ready.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt } from '../rates/decimal.js';
import { audit, event, rescheduleChecklistItem, rescheduleSecurity } from './tender-records.js';
import {
  CHECKLIST_TEMPLATE,
  EXPIRING_FORMS,
  OPEN_STATUSES,
  bidValidityEnd,
  financialYear,
  rankBids,
  type Envelope,
  type TenderStatus,
} from './tender-rules.js';
import { TenderService, type Patch } from './tender.service.js';

export type QueryStatus = 'draft' | 'sent' | 'answered' | 'withdrawn';
export type SecurityStatus =
  'planned' | 'issued' | 'submitted' | 'returned' | 'adjusted' | 'forfeited' | 'cancelled';
export type ResultCategory =
  'price' | 'technical' | 'qualification' | 'documents' | 'scope' | 'client' | 'other';

export interface QueryInput {
  reference: string;
  question: string;
  status: QueryStatus;
  sentOn: string | null;
  answer: string;
  answeredOn: string | null;
  addendumId: string | null;
}
export interface AddendumInput {
  ref: string;
  issuedOn: string;
  summary: string;
  affectsBoq: boolean;
  acknowledged: boolean;
}
export interface SecurityInput {
  purpose: 'emd' | 'performance' | 'other';
  form: string;
  amount: string;
  bank: string | null;
  instrumentNo: string | null;
  issuedOn: string | null;
  validUntil: string | null;
  claimUntil: string | null;
  status: SecurityStatus;
  returnedOn: string | null;
  notes: string;
}
export interface ChecklistInput {
  envelope: Envelope;
  title: string;
  required: boolean;
  status: 'pending' | 'ready' | 'not_applicable';
  assigneeId: string | null;
  dueOn: string | null;
  notes: string;
}
export interface SubmissionInput {
  submittedAt: Date;
  mode: 'portal' | 'physical' | 'email' | 'other';
  reference: string | null;
  bidValue: string | null;
  notes: string;
}
export interface BidInput {
  /** Our own bid. */
  us: boolean;
  partyId: string | null;
  /** A competitor not yet in the party master: found by name, or added as a competitor. */
  name: string | null;
  quotedValue: string | null;
  qualified: boolean;
  notes: string;
}
export interface ResultInput {
  outcome: 'won' | 'lost';
  on: string | null;
  category: ResultCategory | null;
  reason: string;
  /** Won: the contract value (letter of acceptance). Lost: the winning bid. */
  value: string | null;
  winnerId: string | null;
  winnerName: string | null;
}

const QUERY = `q.id, q.seq, q.reference, q.question, q.status, to_char(q.sent_on, 'YYYY-MM-DD') AS "sentOn",
  q.answer, to_char(q.answered_on, 'YYYY-MM-DD') AS "answeredOn", q.addendum_id AS "addendumId",
  q.row_version AS "rowVersion"`;
const ADDENDUM = `a.id, a.ref, to_char(a.issued_on, 'YYYY-MM-DD') AS "issuedOn", a.summary,
  a.due_before AS "dueBefore", a.due_after AS "dueAfter", a.affects_boq AS "affectsBoq", a.acknowledged,
  a.row_version AS "rowVersion"`;
const SECURITY = `s.id, s.purpose, s.form, s.amount::text AS amount, s.bank, s.instrument_no AS "instrumentNo",
  to_char(s.issued_on, 'YYYY-MM-DD') AS "issuedOn", to_char(s.valid_until, 'YYYY-MM-DD') AS "validUntil",
  to_char(s.claim_until, 'YYYY-MM-DD') AS "claimUntil", s.status, to_char(s.returned_on, 'YYYY-MM-DD') AS "returnedOn",
  s.notes, s.row_version AS "rowVersion"`;
const CHECKLIST = `c.id, c.seq, c.envelope, c.title, c.required, c.status, c.assignee_id AS "assigneeId",
  u.display_name AS "assignee", to_char(c.due_on, 'YYYY-MM-DD') AS "dueOn", c.notes, c.done_at AS "doneAt",
  c.row_version AS "rowVersion"`;

const QUERY_COLUMN: Record<keyof QueryInput, string> = {
  reference: 'reference',
  question: 'question',
  status: 'status',
  sentOn: 'sent_on',
  answer: 'answer',
  answeredOn: 'answered_on',
  addendumId: 'addendum_id',
};
const ADDENDUM_COLUMN: Record<keyof AddendumInput, string> = {
  ref: 'ref',
  issuedOn: 'issued_on',
  summary: 'summary',
  affectsBoq: 'affects_boq',
  acknowledged: 'acknowledged',
};
const SECURITY_COLUMN: Record<keyof SecurityInput, string> = {
  purpose: 'purpose',
  form: 'form',
  amount: 'amount',
  bank: 'bank',
  instrumentNo: 'instrument_no',
  issuedOn: 'issued_on',
  validUntil: 'valid_until',
  claimUntil: 'claim_until',
  status: 'status',
  returnedOn: 'returned_on',
  notes: 'notes',
};
const CHECKLIST_COLUMN: Record<keyof ChecklistInput, string> = {
  envelope: 'envelope',
  title: 'title',
  required: 'required',
  status: 'status',
  assigneeId: 'assignee_id',
  dueOn: 'due_on',
  notes: 'notes',
};

const columns = <T extends object>(input: Patch<T>, map: Record<keyof T, string>) =>
  Object.fromEntries(
    Object.entries(input)
      .filter(([k, v]) => v !== undefined && k in map)
      .map(([k, v]) => [map[k as keyof T], v]),
  );

/** Query moves: drafts are sent or dropped, sent queries are answered or withdrawn. */
const QUERY_MOVES: Record<QueryStatus, readonly QueryStatus[]> = {
  draft: ['sent', 'withdrawn'],
  sent: ['answered', 'withdrawn'],
  answered: [],
  withdrawn: [],
};

const today = (now: Date) => new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

function uniqueViolation(err: unknown, code: string): never {
  if ((err as { code?: string }).code === '23505') throw new ConflictException({ code });
  throw err;
}

@Injectable()
export class TenderWorkService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly tenders: TenderService,
  ) {}

  /** Everything below the tender's header, for its page: lists, the bids ranked, and what still stands in the way. */
  async work(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db<
      {
        status: TenderStatus;
        emd_amount: string | null;
        submission_due_at: Date | null;
        bid_validity_days: number | null;
      }[]
    >`SELECT status, emd_amount::text, submission_due_at, bid_validity_days FROM tender.tender WHERE id = ${tenderId}`;
    if (!t) throw new NotFoundException({ code: 'tender_not_found' });
    const seePricing = await this.permissions.can(claims, 'pricing.edit');
    const [queries, addenda, securities, checklist, submissions, bids] = await Promise.all([
      db`SELECT ${db.unsafe(QUERY)} FROM tender.query q WHERE q.tender_id = ${tenderId} ORDER BY q.seq`,
      db`SELECT ${db.unsafe(ADDENDUM)} FROM tender.addendum a WHERE a.tender_id = ${tenderId}
        ORDER BY a.issued_on, a.created_at`,
      db<{ form: string; purpose: string; status: string; validUntil: string | null }[]>`
        SELECT ${db.unsafe(SECURITY)} FROM tender.security_instrument s WHERE s.tender_id = ${tenderId}
        ORDER BY s.created_at`,
      db<{ required: boolean; status: string; title: string }[]>`
        SELECT ${db.unsafe(CHECKLIST)} FROM tender.checklist_item c
        LEFT JOIN platform."user" u ON u.id = c.assignee_id
        WHERE c.tender_id = ${tenderId} ORDER BY c.envelope = 'other', c.envelope DESC, c.seq`,
      db<{ bidValue: string | null }[]>`
        SELECT s.id, s.kind, s.submitted_at AS "submittedAt", s.mode, s.reference, s.bid_value::text AS "bidValue",
          s.notes, u.display_name AS "by"
        FROM tender.submission s LEFT JOIN platform."user" u ON u.id = s.created_by
        WHERE s.tender_id = ${tenderId} ORDER BY s.submitted_at`,
      db<
        {
          id: string;
          partyId: string | null;
          name: string | null;
          quotedValue: string | null;
          qualified: boolean;
          notes: string;
        }[]
      >`SELECT b.id, b.party_id AS "partyId", p.name, b.quoted_value::text AS "quotedValue", b.qualified, b.notes
        FROM tender.competitor_bid b LEFT JOIN platform.party p ON p.id = b.party_id
        WHERE b.tender_id = ${tenderId} ORDER BY b.quoted_value NULLS LAST, p.name`,
    ]);

    // The bid security must outlast the bid's validity (clients usually add some days to that).
    const validityEnd = bidValidityEnd(t.submission_due_at, t.bid_validity_days);
    const securityRows = securities.map((s) => ({
      ...s,
      shortOfValidity:
        s.purpose === 'emd' &&
        EXPIRING_FORMS.includes(s.form) &&
        !['returned', 'adjusted', 'forfeited', 'cancelled'].includes(s.status) &&
        validityEnd !== null &&
        s.validUntil !== null &&
        s.validUntil < validityEnd,
    }));
    const ranked = rankBids(bids).map((b) => ({ ...b, us: b.partyId === null }));
    const ours = ranked.find((b) => b.us);
    const l1 = ranked.find((b) => b.rank === 1);
    const pending = checklist.filter((c) => c.required && c.status === 'pending');
    const emdCovered = securities.some(
      (s) =>
        s.purpose === 'emd' &&
        (s.form === 'exempt'
          ? s.status !== 'cancelled'
          : ['issued', 'submitted'].includes(s.status)),
    );
    return {
      queries,
      addenda,
      securities: securityRows,
      checklist,
      submissions: submissions.map((s) => (seePricing ? s : { ...s, bidValue: null })),
      bids: ranked,
      opening:
        ranked.length === 0
          ? null
          : {
              bidders: ranked.length,
              ourRank: ours?.rank ?? null,
              l1: l1 ? { name: l1.us ? null : l1.name, value: l1.quotedValue, us: l1.us } : null,
              // How far our bid sits above the lowest, when we are not the lowest.
              aboveL1Pct:
                ours?.quotedValue &&
                l1?.quotedValue &&
                ours.rank !== 1 &&
                Number(l1.quotedValue) > 0
                  ? round2(
                      ((Number(ours.quotedValue) - Number(l1.quotedValue)) /
                        Number(l1.quotedValue)) *
                        100,
                    )
                  : null,
            },
      bidValidityEnd: validityEnd,
      readiness: {
        checklistRequired: checklist.filter((c) => c.required).length,
        checklistPending: pending.map((c) => c.title),
        addendaUnacknowledged: addenda.filter((a) => !a.acknowledged).length,
        emdRequired: t.emd_amount !== null && Number(t.emd_amount) > 0,
        emdCovered,
        queriesUnanswered: queries.filter((q) => q.status === 'sent').length,
      },
    };
  }

  // --- pre-bid queries ---

  async createQuery(
    claims: TenantClaims,
    tenderId: string,
    input: { reference: string; question: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      await this.tenders.lockStatus(tx, tenderId);
      const [row] = await tx<{ id: string; seq: number }[]>`
        INSERT INTO tender.query (tender_id, seq, reference, question, created_by, updated_by)
        VALUES (${tenderId},
          (SELECT coalesce(max(seq), 0) + 1 FROM tender.query WHERE tender_id = ${tenderId}),
          ${input.reference}, ${input.question}, ${claims.sub}, ${claims.sub})
        RETURNING id, seq`;
      await event(tx, tenderId, 'query_added', { seq: row!.seq }, claims.sub);
      return row!;
    });
  }

  async updateQuery(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    input: Patch<QueryInput>,
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const [q] = await tx<
        { tender_id: string; status: QueryStatus; seq: number; row_version: number }[]
      >`
        SELECT tender_id, status, seq, row_version FROM tender.query WHERE id = ${id} FOR UPDATE`;
      if (!q) throw new NotFoundException({ code: 'query_not_found' });
      if (q.row_version !== rowVersion) throw stale();
      const patch = { ...input };
      if (patch.status && patch.status !== q.status) {
        if (!QUERY_MOVES[q.status].includes(patch.status))
          throw new BadRequestException({
            code: 'invalid_query_change',
            message: `A ${q.status} query cannot become ${patch.status}.`,
          });
        if (patch.status === 'sent') patch.sentOn ??= today(now);
        if (patch.status === 'answered') {
          patch.answeredOn ??= today(now);
          if (!(patch.answer ?? '').trim())
            throw new BadRequestException({ code: 'answer_required' });
        }
      }
      if (
        patch.question !== undefined &&
        q.status !== 'draft' &&
        (patch.status ?? q.status) !== 'draft'
      )
        throw new BadRequestException({
          code: 'query_sent',
          message: 'A query already sent cannot be reworded. Withdraw it and raise a new one.',
        });
      if (patch.addendumId) await this.ownAddendum(tx, q.tender_id, patch.addendumId);
      const cols = columns(patch, QUERY_COLUMN);
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      await tx`UPDATE tender.query SET ${tx({ ...cols, updated_by: claims.sub })}, updated_at = now(),
        row_version = row_version + 1 WHERE id = ${id}`;
      if (patch.status && patch.status !== q.status)
        await event(tx, q.tender_id, `query_${patch.status}`, { seq: q.seq }, claims.sub);
      return { id };
    });
  }

  /** Only drafts can go: a query the client has seen stays on record (withdraw it instead). */
  async deleteQuery(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [row] =
      await db`DELETE FROM tender.query WHERE id = ${id} AND status = 'draft' RETURNING id`;
    if (!row) {
      const [exists] = await db`SELECT 1 FROM tender.query WHERE id = ${id}`;
      if (!exists) throw new NotFoundException({ code: 'query_not_found' });
      throw new ConflictException({
        code: 'query_sent',
        message: 'Only draft queries can be deleted. Withdraw this one instead.',
      });
    }
  }

  // --- addenda ---

  /** Records an addendum. One that moves the submission date moves the tender's date too (and its reminders). */
  async createAddendum(
    claims: TenantClaims,
    tenderId: string,
    input: AddendumInput & { newSubmissionDueAt: Date | null },
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db
      .begin(async (tx) => {
        const status = await this.tenders.lockStatus(tx, tenderId);
        let dueBefore: Date | null = null;
        if (input.newSubmissionDueAt) {
          if (!OPEN_STATUSES.includes(status) || status === 'submitted')
            throw new ConflictException({
              code: 'tender_closed',
              message: 'The submission date can only move while the tender is being prepared.',
            });
          const [t] = await tx<{ submission_due_at: Date | null }[]>`
            SELECT submission_due_at FROM tender.tender WHERE id = ${tenderId}`;
          dueBefore = t!.submission_due_at;
          await tx`UPDATE tender.tender SET submission_due_at = ${input.newSubmissionDueAt},
              updated_by = ${claims.sub}, updated_at = now(), row_version = row_version + 1
            WHERE id = ${tenderId}`;
        }
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO tender.addendum ${tx({
            ...columns<AddendumInput>(input, ADDENDUM_COLUMN),
            tender_id: tenderId,
            due_before: dueBefore,
            due_after: input.newSubmissionDueAt,
            created_by: claims.sub,
            updated_by: claims.sub,
          })} RETURNING id`;
        await event(
          tx,
          tenderId,
          'addendum',
          {
            ref: input.ref,
            ...(input.newSubmissionDueAt ? { dueBefore, dueAfter: input.newSubmissionDueAt } : {}),
          },
          claims.sub,
        );
        await audit(tx, claims.sub, 'tender.addendum', 'tender', tenderId, { ref: input.ref });
        if (input.newSubmissionDueAt) await this.tenders.reschedule(tx, tenderId, now);
        return row!;
      })
      .catch((err: unknown) => uniqueViolation(err, 'addendum_ref_taken'));
  }

  async updateAddendum(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    input: Patch<AddendumInput>,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db
      .begin(async (tx) => {
        const cols = columns(input, ADDENDUM_COLUMN);
        if (Object.keys(cols).length === 0)
          throw new BadRequestException({ code: 'nothing_to_update' });
        const [row] = await tx`
          UPDATE tender.addendum SET ${tx({ ...cols, updated_by: claims.sub })}, updated_at = now(),
            row_version = row_version + 1
          WHERE id = ${id} AND row_version = ${rowVersion} RETURNING id`;
        if (!row) await missingOrStale(tx, 'tender.addendum', id, 'addendum_not_found');
        return { id };
      })
      .catch((err: unknown) => uniqueViolation(err, 'addendum_ref_taken'));
  }

  // --- EMD and bank guarantees ---

  async createSecurity(
    claims: TenantClaims,
    tenderId: string,
    input: SecurityInput,
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      await this.tenders.lockStatus(tx, tenderId);
      const cols = this.securityColumns(input, null, now);
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO tender.security_instrument ${tx({
          ...cols,
          tender_id: tenderId,
          created_by: claims.sub,
          updated_by: claims.sub,
        })} RETURNING id`;
      await event(
        tx,
        tenderId,
        'security',
        { purpose: input.purpose, form: input.form, amount: input.amount, status: input.status },
        claims.sub,
      );
      await rescheduleSecurity(tx, row!.id, now);
      return row!;
    });
  }

  async updateSecurity(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    input: Patch<SecurityInput>,
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const [s] = await tx<{ tender_id: string; status: SecurityStatus; row_version: number }[]>`
        SELECT tender_id, status, row_version FROM tender.security_instrument WHERE id = ${id} FOR UPDATE`;
      if (!s) throw new NotFoundException({ code: 'security_not_found' });
      if (s.row_version !== rowVersion) throw stale();
      const cols = this.securityColumns(input, s.status, now);
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      await tx`UPDATE tender.security_instrument SET ${tx({ ...cols, updated_by: claims.sub })},
        updated_at = now(), row_version = row_version + 1 WHERE id = ${id}`;
      if (input.status && input.status !== s.status) {
        await event(
          tx,
          s.tender_id,
          'security_status',
          { from: s.status, to: input.status },
          claims.sub,
        );
        // Back with us (or used up): any "ask for it back" reminder is done.
        if (['returned', 'adjusted', 'forfeited', 'cancelled'].includes(input.status))
          await tx`UPDATE platform.notification SET read_at = now()
            WHERE source = ${`security-return:${id}`} AND read_at IS NULL`;
      }
      await rescheduleSecurity(tx, id, now);
      return { id };
    });
  }

  private securityColumns(input: Patch<SecurityInput>, from: SecurityStatus | null, now: Date) {
    const patch = { ...input };
    if (patch.status === 'returned' && from !== 'returned') patch.returnedOn ??= today(now);
    if (patch.form === 'exempt') patch.amount ??= '0';
    return columns(patch, SECURITY_COLUMN);
  }

  // --- submission checklist ---

  async addChecklistItem(
    claims: TenantClaims,
    tenderId: string,
    input: ChecklistInput,
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      await this.tenders.lockStatus(tx, tenderId);
      await this.activeUser(tx, input.assigneeId);
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO tender.checklist_item ${tx({
          ...columns(input, CHECKLIST_COLUMN),
          tender_id: tenderId,
          seq: tx`(SELECT coalesce(max(seq), 0) + 1 FROM tender.checklist_item WHERE tender_id = ${tenderId})`,
          created_by: claims.sub,
          updated_by: claims.sub,
        } as Record<string, unknown>)} RETURNING id`;
      await rescheduleChecklistItem(tx, row!.id, now);
      return row!;
    });
  }

  /** Adds the standard Indian works-tender documents not already on the list (by title). */
  async addStandardChecklist(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      await this.tenders.lockStatus(tx, tenderId);
      const have = new Set(
        (
          await tx<{ t: string }[]>`
            SELECT lower(title) AS t FROM tender.checklist_item WHERE tender_id = ${tenderId}`
        ).map((r) => r.t),
      );
      const [{ next }] = (await tx<{ next: number }[]>`
        SELECT coalesce(max(seq), 0) + 1 AS next FROM tender.checklist_item WHERE tender_id = ${tenderId}`) as unknown as [
        { next: number },
      ];
      const add = CHECKLIST_TEMPLATE.filter((c) => !have.has(c.title.toLowerCase())).map(
        (c, i) => ({
          tender_id: tenderId,
          seq: next + i,
          envelope: c.envelope,
          title: c.title,
          required: c.required,
          created_by: claims.sub,
          updated_by: claims.sub,
        }),
      );
      if (add.length) await tx`INSERT INTO tender.checklist_item ${tx(add)}`;
      return { added: add.length };
    });
  }

  async updateChecklistItem(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    input: Patch<ChecklistInput>,
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const [c] = await tx<{ assignee_id: string | null; status: string; row_version: number }[]>`
        SELECT assignee_id, status, row_version FROM tender.checklist_item WHERE id = ${id} FOR UPDATE`;
      if (!c) throw new NotFoundException({ code: 'checklist_item_not_found' });
      // Whoever it is assigned to may report it ready (or add a note) without the right to edit the tender.
      if (!(await this.permissions.can(claims, 'tender.edit'))) {
        const own = Object.keys(input).every((k) => k === 'status' || k === 'notes');
        if (c.assignee_id !== claims.sub || !own)
          throw new ForbiddenException({ code: 'permission_denied', permission: 'tender.edit' });
      }
      if (c.row_version !== rowVersion) throw stale();
      await this.activeUser(tx, input.assigneeId);
      const cols: Record<string, unknown> = columns(input, CHECKLIST_COLUMN);
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      if (input.status && input.status !== c.status) {
        cols.done_at = input.status === 'pending' ? null : now;
        cols.done_by = input.status === 'pending' ? null : claims.sub;
      }
      await tx`UPDATE tender.checklist_item SET ${tx({ ...cols, updated_by: claims.sub })}, updated_at = now(),
        row_version = row_version + 1 WHERE id = ${id}`;
      await rescheduleChecklistItem(tx, id, now);
      return { id };
    });
  }

  async deleteChecklistItem(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [row] = await tx`DELETE FROM tender.checklist_item WHERE id = ${id} RETURNING id`;
      if (!row) throw new NotFoundException({ code: 'checklist_item_not_found' });
      await tx`DELETE FROM platform.notification WHERE source = ${`checklist:${id}`} AND read_at IS NULL`;
    });
  }

  // --- submission ---

  /**
   * Records handing in the bid. The first one moves the tender from bidding to submitted (freezing its BOQs as
   * submitted, step 7); later ones are revised offers, say after negotiation.
   */
  async submit(claims: TenantClaims, tenderId: string, input: SubmissionInput, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const status = await this.tenders.lockStatus(tx, tenderId);
      if (status !== 'bidding' && status !== 'submitted')
        throw new ConflictException({
          code: 'not_bidding',
          message: 'A bid can be recorded while the tender is being bid or after it was submitted.',
        });
      const kind = status === 'bidding' ? 'original' : 'revised';
      await tx`INSERT INTO tender.submission (tender_id, kind, submitted_at, mode, reference, bid_value, notes,
          created_by)
        VALUES (${tenderId}, ${kind}, ${input.submittedAt}, ${input.mode}, ${input.reference}, ${input.bidValue},
          ${input.notes}, ${claims.sub})`;
      await event(
        tx,
        tenderId,
        'submission',
        { kind, mode: input.mode, reference: input.reference },
        claims.sub,
      );
      if (status === 'bidding')
        await this.tenders.moveInTx(tx, claims.sub, tenderId, 'bidding', 'submitted', '', now);
    });
    return this.tenders.get(claims, tenderId);
  }

  // --- opening and result ---

  /** The bids read out at the opening, ours included; replaces what was recorded before. */
  async setBids(claims: TenantClaims, tenderId: string, bids: BidInput[]) {
    if (bids.filter((b) => b.us).length > 1) throw new BadRequestException({ code: 'one_own_bid' });
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const status = await this.tenders.lockStatus(tx, tenderId);
      if (!['submitted', 'won', 'lost'].includes(status))
        throw new ConflictException({
          code: 'not_opened',
          message: 'Bids are recorded once the tender has been submitted.',
        });
      const rows: {
        party_id: string | null;
        quoted_value: string | null;
        qualified: boolean;
        notes: string;
      }[] = [];
      for (const b of bids) {
        const partyId = b.us ? null : await this.competitor(tx, claims, b.partyId, b.name);
        if (partyId && rows.some((r) => r.party_id === partyId))
          throw new BadRequestException({ code: 'duplicate_bidder' });
        rows.push({
          party_id: partyId,
          quoted_value: b.quotedValue,
          qualified: b.qualified,
          notes: b.notes,
        });
      }
      await tx`DELETE FROM tender.competitor_bid WHERE tender_id = ${tenderId}`;
      if (rows.length)
        await tx`INSERT INTO tender.competitor_bid ${tx(
          rows.map((r) => ({ ...r, tender_id: tenderId, created_by: claims.sub })),
        )}`;
      const ranked = rankBids(rows.map((r) => ({ ...r, quotedValue: r.quoted_value })));
      await event(
        tx,
        tenderId,
        'opening',
        { bidders: rows.length, ourRank: ranked.find((r) => r.party_id === null)?.rank ?? null },
        claims.sub,
      );
    });
    return this.work(claims, tenderId);
  }

  /** Won or lost, with why, the value and (lost) who won. From submitted it also moves the tender. */
  async recordResult(claims: TenantClaims, tenderId: string, input: ResultInput, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const status = await this.tenders.lockStatus(tx, tenderId);
      if (status === 'submitted')
        await this.tenders.moveInTx(
          tx,
          claims.sub,
          tenderId,
          status,
          input.outcome,
          input.reason,
          now,
        );
      else if (status !== input.outcome)
        throw new ConflictException({
          code: 'invalid_status_change',
          message: 'A result is recorded once the tender has been submitted.',
        });
      const winner =
        input.outcome === 'lost'
          ? await this.competitor(tx, claims, input.winnerId, input.winnerName)
          : null;
      await tx`UPDATE tender.tender SET result_on = ${input.on ?? today(now)},
          result_category = ${input.category}, awarded_value = ${input.value}, awarded_to = ${winner},
          status_reason = coalesce(${input.reason.trim() || null}, status_reason),
          updated_by = ${claims.sub}, updated_at = now(), row_version = row_version + 1
        WHERE id = ${tenderId}`;
      await event(
        tx,
        tenderId,
        'result',
        { outcome: input.outcome, category: input.category, value: input.value },
        claims.sub,
      );
    });
    return this.tenders.get(claims, tenderId);
  }

  // --- agenda ---

  /**
   * Dates coming up across tenders: submissions, pre-bid meetings, query deadlines and openings of open tenders,
   * expiring bank guarantees (also ones already expired while still with the client), and checklist items due.
   */
  async agenda(claims: TenantClaims, days: number, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    const from = new Date(now.getTime() - 7 * 86_400_000);
    const to = new Date(now.getTime() + days * 86_400_000);
    const fromDay = today(from);
    const toDay = today(to);
    const rows = await db<
      {
        at: string;
        allDay: boolean;
        kind: string;
        label: string;
        tender: { id: string; number: string; title: string };
      }[]
    >`
      WITH t AS (
        SELECT id, number, title, status, submission_due_at, prebid_at, queries_due_at, opening_at
        FROM tender.tender WHERE status IN ('lead', 'evaluating', 'bidding', 'submitted')
      ),
      dates AS (
        SELECT t.id AS tender_id, submission_due_at AS at, false AS all_day, 'submission' AS kind,
          'Submission due' AS label
          FROM t WHERE status <> 'submitted'
        UNION ALL SELECT t.id, prebid_at, false, 'prebid', 'Pre-bid meeting' FROM t WHERE status <> 'submitted'
        UNION ALL SELECT t.id, queries_due_at, false, 'queries', 'Last day for queries' FROM t
          WHERE status <> 'submitted'
        UNION ALL SELECT t.id, opening_at, false, 'opening', 'Bid opening' FROM t
        UNION ALL
          SELECT s.tender_id, (s.valid_until::text || 'T03:30:00Z')::timestamptz, true, 'security_expiry',
            CASE s.form WHEN 'bank_guarantee' THEN 'Bank guarantee expires' WHEN 'fdr' THEN 'FDR matures'
              ELSE 'Bond expires' END || ' (₹' || s.amount::text || coalesce(', ' || s.bank, '') || ')'
          FROM tender.security_instrument s
          WHERE s.status IN ('issued', 'submitted') AND s.form IN ('bank_guarantee', 'fdr', 'insurance_bond')
            AND s.valid_until <= ${toDay}::date
        UNION ALL
          SELECT c.tender_id, (c.due_on::text || 'T03:30:00Z')::timestamptz, true, 'checklist',
            c.title || coalesce(' (' || u.display_name || ')', '')
          FROM tender.checklist_item c JOIN t ON t.id = c.tender_id
          LEFT JOIN platform."user" u ON u.id = c.assignee_id
          WHERE c.status = 'pending' AND c.due_on BETWEEN ${fromDay}::date AND ${toDay}::date
      )
      SELECT d.at, d.all_day AS "allDay", d.kind, d.label,
        json_build_object('id', x.id, 'number', x.number, 'title', x.title) AS tender
      FROM dates d JOIN tender.tender x ON x.id = d.tender_id
      WHERE d.at IS NOT NULL AND d.at <= ${to}
        AND (d.at >= ${from} OR d.kind = 'security_expiry')
      ORDER BY d.at, x.number
      LIMIT 500`;
    return rows;
  }

  // --- win/loss ---

  /**
   * Win/loss over the tenders handed in, by Indian financial year of submission: win rate by count and value,
   * clients, verticals, why we lost, and how we fared against each competitor.
   */
  async analysis(claims: TenantClaims, fy: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<
      {
        id: string;
        status: TenderStatus;
        client: string | null;
        vertical: string;
        category: string | null;
        awarded_to: string | null;
        at: Date;
        our_value: string | null;
        awarded_value: string | null;
      }[]
    >`
      SELECT t.id, t.status, c.name AS client, t.vertical, t.result_category AS category, t.awarded_to,
        coalesce((SELECT min(s.submitted_at) FROM tender.submission s WHERE s.tender_id = t.id),
          t.submission_due_at, t.created_at) AS at,
        coalesce(
          (SELECT s.bid_value::text FROM tender.submission s WHERE s.tender_id = t.id AND s.bid_value IS NOT NULL
            ORDER BY s.submitted_at DESC LIMIT 1),
          (SELECT b.quoted_value::text FROM tender.competitor_bid b WHERE b.tender_id = t.id AND b.party_id IS NULL)
        ) AS our_value,
        t.awarded_value::text AS awarded_value
      FROM tender.tender t LEFT JOIN platform.party c ON c.id = t.client_id
      WHERE t.status IN ('submitted', 'won', 'lost')`;
    const years = [...new Set(rows.map((r) => financialYear(r.at)))].sort().reverse();
    const picked = fy ? rows.filter((r) => financialYear(r.at) === fy) : rows;
    const ids = picked.map((r) => r.id);
    interface OpenedBid {
      tender_id: string;
      party_id: string | null;
      name: string | null;
      value: string | null;
      qualified: boolean;
    }
    const bids: OpenedBid[] = ids.length
      ? [
          ...(await db<OpenedBid[]>`
            SELECT b.tender_id, b.party_id, p.name, b.quoted_value::text AS value, b.qualified
            FROM tender.competitor_bid b LEFT JOIN platform.party p ON p.id = b.party_id
            WHERE b.tender_id = ANY(${ids}::uuid[])`),
        ]
      : [];

    const money = (xs: (string | null)[]) =>
      fmt(
        xs.reduce((a, x) => a + dec(x ?? '0'), 0n),
        2,
      );
    const tally = (rs: typeof picked) => {
      const won = rs.filter((r) => r.status === 'won');
      const lost = rs.filter((r) => r.status === 'lost');
      const decidedValue = [...won, ...lost].reduce((a, r) => a + Number(r.our_value ?? 0), 0);
      return {
        submitted: rs.length,
        won: won.length,
        lost: lost.length,
        pending: rs.filter((r) => r.status === 'submitted').length,
        winRatePct:
          won.length + lost.length ? round2((won.length / (won.length + lost.length)) * 100) : null,
        bidValue: money(rs.map((r) => r.our_value)),
        wonValue: money(won.map((r) => r.awarded_value ?? r.our_value)),
        winRateByValuePct: decidedValue
          ? round2((won.reduce((a, r) => a + Number(r.our_value ?? 0), 0) / decidedValue) * 100)
          : null,
      };
    };
    const groupBy = (key: (r: (typeof picked)[number]) => string) => {
      const m = new Map<string, typeof picked>();
      for (const r of picked) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
      return [...m.entries()]
        .map(([name, rs]) => ({ name, ...tally(rs) }))
        .sort((a, b) => b.submitted - a.submitted || a.name.localeCompare(b.name));
    };

    // Head to head: tenders where a competitor and we both had a value read out.
    const byTender = new Map<string, typeof bids>();
    for (const b of bids) byTender.set(b.tender_id, [...(byTender.get(b.tender_id) ?? []), b]);
    const rivals = new Map<
      string,
      {
        id: string;
        name: string;
        met: number;
        beatUs: number;
        weBeat: number;
        won: number;
        gaps: number[];
      }
    >();
    let l1 = 0;
    const aboveL1: number[] = [];
    for (const r of picked) {
      const tb = byTender.get(r.id) ?? [];
      const ours = tb.find((b) => b.party_id === null);
      const ranked = rankBids(tb.map((b) => ({ ...b, quotedValue: b.value })));
      const ourRank = ranked.find((b) => b.party_id === null)?.rank ?? null;
      const low = ranked.find((b) => b.rank === 1);
      if (ourRank === 1) l1++;
      else if (ours?.value && low?.value && Number(low.value) > 0)
        aboveL1.push(((Number(ours.value) - Number(low.value)) / Number(low.value)) * 100);
      for (const b of tb) {
        if (!b.party_id) continue;
        const x = rivals.get(b.party_id) ?? {
          id: b.party_id,
          name: b.name ?? '',
          met: 0,
          beatUs: 0,
          weBeat: 0,
          won: 0,
          gaps: [],
        };
        x.met++;
        if (r.awarded_to === b.party_id) x.won++;
        if (ours?.value && b.value && ours.qualified && b.qualified) {
          if (Number(b.value) < Number(ours.value)) x.beatUs++;
          else if (Number(b.value) > Number(ours.value)) x.weBeat++;
          if (Number(ours.value) > 0)
            x.gaps.push(((Number(b.value) - Number(ours.value)) / Number(ours.value)) * 100);
        }
        rivals.set(b.party_id, x);
      }
    }
    const reasons = new Map<string, number>();
    for (const r of picked.filter((x) => x.status === 'lost'))
      reasons.set(
        r.category ?? 'not_recorded',
        (reasons.get(r.category ?? 'not_recorded') ?? 0) + 1,
      );

    return {
      years,
      fy,
      totals: tally(picked),
      byClient: groupBy((r) => r.client ?? '(no client)'),
      byVertical: groupBy((r) => r.vertical),
      lossReasons: [...reasons.entries()]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count),
      position: {
        opened: picked.filter((r) => byTender.get(r.id)?.some((b) => b.party_id === null)).length,
        l1,
        avgAboveL1Pct: aboveL1.length
          ? round2(aboveL1.reduce((a, x) => a + x, 0) / aboveL1.length)
          : null,
      },
      competitors: [...rivals.values()]
        .map(({ gaps, ...x }) => ({
          ...x,
          // Their price against ours, on average: negative means they bid lower.
          avgGapPct: gaps.length ? round2(gaps.reduce((a, g) => a + g, 0) / gaps.length) : null,
        }))
        .sort((a, b) => b.met - a.met || a.name.localeCompare(b.name)),
    };
  }

  // --- helpers ---

  /** A competitor party by id, or by name (an existing party is marked a competitor; a new one is added). */
  private async competitor(
    tx: TransactionSql,
    claims: TenantClaims,
    partyId: string | null,
    name: string | null,
  ): Promise<string | null> {
    if (partyId) {
      const [p] = await tx<{ id: string }[]>`
        UPDATE platform.party SET is_competitor = true WHERE id = ${partyId} AND deleted_at IS NULL RETURNING id`;
      if (!p) throw new BadRequestException({ code: 'party_not_found' });
      return p.id;
    }
    const n = name?.trim();
    if (!n) return null;
    const [found] = await tx<{ id: string }[]>`
      UPDATE platform.party SET is_competitor = true
      WHERE lower(name) = lower(${n}) AND deleted_at IS NULL RETURNING id`;
    if (found) return found.id;
    const [made] = await tx<{ id: string }[]>`
      INSERT INTO platform.party (name, is_competitor, created_by, updated_by)
      VALUES (${n}, true, ${claims.sub}, ${claims.sub}) RETURNING id`;
    await audit(tx, claims.sub, 'party.create', 'party', made!.id, { name: n, competitor: true });
    return made!.id;
  }

  private async ownAddendum(tx: TransactionSql, tenderId: string, addendumId: string) {
    const [a] =
      await tx`SELECT 1 FROM tender.addendum WHERE id = ${addendumId} AND tender_id = ${tenderId}`;
    if (!a) throw new BadRequestException({ code: 'addendum_not_found' });
  }

  private async activeUser(tx: TransactionSql, userId: string | null | undefined) {
    if (!userId) return;
    const [u] = await tx`SELECT 1 FROM platform."user" WHERE id = ${userId} AND status = 'active'`;
    if (!u) throw new BadRequestException({ code: 'assignee_not_found' });
  }
}

const round2 = (x: number) => Math.round(x * 100) / 100;

const stale = () =>
  new ConflictException({
    code: 'stale_row',
    message: 'Someone else changed this record. Reload to see their changes.',
  });

async function missingOrStale(tx: TransactionSql | Sql, table: string, id: string, code: string) {
  const [r] = await tx.unsafe(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  if (!r) throw new NotFoundException({ code });
  throw stale();
}
