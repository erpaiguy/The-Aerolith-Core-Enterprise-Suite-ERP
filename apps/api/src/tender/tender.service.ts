// Tender register (docs/wave1-plan.md step 1) and the party master it uses. Everything runs in the tenant's own
// database through the least-privilege app role.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { mask } from '../hr/hr-rules.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { TenderSettingsService } from './tender-settings.service.js';
import { RevisionService } from '../boq/revision.service.js';
import { nextNumber } from './numbering.js';
import { audit, event, remindEmdReturn } from './tender-records.js';
import {
  DECISION_FROM,
  EMD_RETURN_DUE,
  OPEN_STATUSES,
  REASON_REQUIRED,
  allowedMoves,
  bidScore,
  deadlineReminders,
  type Criterion,
  type TenderStatus,
} from './tender-rules.js';

/** A partial update: absent fields stay as they are. */
export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export interface PartyInput {
  name: string;
  isClient: boolean;
  isVendor: boolean;
  isSubcontractor: boolean;
  isCompetitor: boolean;
  gstin: string | null;
  pan: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string;
  tdsSection?: string | null;
  rcmCategory?: string | null;
  udyamNo?: string | null;
  msmeType?: string | null;
  bankAccountName?: string | null;
  bankAccountNo?: string | null;
  bankIfsc?: string | null;
  legalName?: string | null;
  city?: string;
  pincode?: string | null;
  stateCode?: string | null;
  tan?: string | null;
}

export interface TenderInput {
  title: string;
  clientId: string | null;
  clientRef: string | null;
  source: string;
  portalUrl: string | null;
  vertical: string;
  location: string | null;
  estimatedValue: string | null;
  emdAmount: string | null;
  tenderFee: string | null;
  publishedOn: string | null;
  prebidAt: Date | null;
  submissionDueAt: Date | null;
  openingAt: Date | null;
  queriesDueAt: Date | null;
  bidValidityDays: number | null;
  ownerId: string | null;
  description: string;
}

const PARTY_COLUMNS = `id, name, is_client AS "isClient", is_vendor AS "isVendor",
  is_subcontractor AS "isSubcontractor", is_competitor AS "isCompetitor", gstin, pan, contact_name AS "contactName", email, phone, address, notes,
  tds_section AS "tdsSection", rcm_category AS "rcmCategory", udyam_no AS "udyamNo",
  msme_type AS "msmeType", bank_account_name AS "bankAccountName", bank_account_no AS "bankAccountNo",
  bank_ifsc AS "bankIfsc", legal_name AS "legalName", city, pincode, state_code AS "stateCode", tan,
  row_version AS "rowVersion"`;

const TENDER_COLUMN: Record<keyof TenderInput, string> = {
  title: 'title',
  clientId: 'client_id',
  clientRef: 'client_ref',
  source: 'source',
  portalUrl: 'portal_url',
  vertical: 'vertical',
  location: 'location',
  estimatedValue: 'estimated_value',
  emdAmount: 'emd_amount',
  tenderFee: 'tender_fee',
  publishedOn: 'published_on',
  prebidAt: 'prebid_at',
  submissionDueAt: 'submission_due_at',
  openingAt: 'opening_at',
  queriesDueAt: 'queries_due_at',
  bidValidityDays: 'bid_validity_days',
  ownerId: 'owner_id',
  description: 'description',
};

const PARTY_COLUMN: Record<keyof PartyInput, string> = {
  name: 'name',
  isClient: 'is_client',
  isVendor: 'is_vendor',
  isSubcontractor: 'is_subcontractor',
  isCompetitor: 'is_competitor',
  gstin: 'gstin',
  pan: 'pan',
  contactName: 'contact_name',
  email: 'email',
  phone: 'phone',
  address: 'address',
  notes: 'notes',
  tdsSection: 'tds_section',
  rcmCategory: 'rcm_category',
  udyamNo: 'udyam_no',
  msmeType: 'msme_type',
  bankAccountName: 'bank_account_name',
  bankAccountNo: 'bank_account_no',
  bankIfsc: 'bank_ifsc',
  legalName: 'legal_name',
  city: 'city',
  pincode: 'pincode',
  stateCode: 'state_code',
  tan: 'tan',
};

const TENDER_SUMMARY = `t.id, t.number, t.title, t.status, t.client_ref AS "clientRef", t.vertical, t.location,
  t.estimated_value AS "estimatedValue", t.submission_due_at AS "submissionDueAt", t.updated_at AS "updatedAt",
  CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'name', c.name) END AS client,
  CASE WHEN u.id IS NULL THEN NULL ELSE json_build_object('id', u.id, 'displayName', u.display_name) END AS owner,
  (SELECT d.score FROM tender.bid_decision d WHERE d.tender_id = t.id ORDER BY d.decided_at DESC LIMIT 1) AS "latestScore"`;

const toColumns = <T extends object>(input: Patch<T>, map: Record<keyof T, string>) =>
  Object.fromEntries(
    Object.entries(input)
      .filter(([k, v]) => v !== undefined && k in map)
      .map(([k, v]) => [map[k as keyof T], v]),
  );

function uniqueViolation(err: unknown, code: string): never {
  if ((err as { code?: string }).code === '23505') throw new ConflictException({ code });
  throw err;
}

@Injectable()
export class TenderService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly revisions: RevisionService,
    private readonly settings: TenderSettingsService,
    private readonly permissions: PermissionsService,
  ) {}

  // --- parties ---

  async listParties(
    claims: TenantClaims,
    opts: {
      q?: string | undefined;
      kind?: 'client' | 'vendor' | 'subcontractor' | 'competitor' | undefined;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const q = opts.q?.trim();
    const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const kind =
      opts.kind === 'client'
        ? db`AND is_client`
        : opts.kind === 'vendor'
          ? db`AND is_vendor`
          : opts.kind === 'subcontractor'
            ? db`AND is_subcontractor`
            : opts.kind === 'competitor'
              ? db`AND is_competitor`
              : db``;
    const rows = await db<Record<string, unknown>[]>`
      SELECT ${db.unsafe(PARTY_COLUMNS)} FROM platform.party WHERE deleted_at IS NULL ${kind}
      ${pattern ? db`AND (name ILIKE ${pattern} OR gstin ILIKE ${pattern} OR contact_name ILIKE ${pattern})` : db``}
      ORDER BY lower(name) LIMIT 500`;
    // Bank account numbers in full only to those who keep parties or read the books (step 8g.4).
    if (
      !(await this.permissions.can(claims, 'tender.edit')) &&
      !(await this.permissions.can(claims, 'accounts.view'))
    )
      for (const r of rows) r.bankAccountNo = mask(r.bankAccountNo as string | null);
    return rows;
  }

  async createParty(claims: TenantClaims, input: PartyInput) {
    const db = await this.tenants.forTenant(claims.ten);
    return db
      .begin(async (tx) => {
        const cols = {
          ...toColumns(input, PARTY_COLUMN),
          created_by: claims.sub,
          updated_by: claims.sub,
        };
        const [row] =
          await tx`INSERT INTO platform.party ${tx(cols)} RETURNING ${tx.unsafe(PARTY_COLUMNS)}`;
        await audit(tx, claims.sub, 'party.create', 'party', row!.id as string, {
          name: input.name,
        });
        return row!;
      })
      .catch((err: unknown) => uniqueViolation(err, 'party_name_taken'));
  }

  async updateParty(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    input: Patch<PartyInput>,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db
      .begin(async (tx) => {
        const cols = toColumns(input, PARTY_COLUMN);
        const [row] = await tx`
          UPDATE platform.party SET ${tx({ ...cols, updated_by: claims.sub })}, updated_at = now(),
            row_version = row_version + 1
          WHERE id = ${id} AND deleted_at IS NULL AND row_version = ${rowVersion}
          RETURNING ${tx.unsafe(PARTY_COLUMNS)}`;
        if (!row) await this.staleOrMissing(tx, 'platform.party', id, 'party_not_found');
        await audit(tx, claims.sub, 'party.update', 'party', id, { fields: Object.keys(input) });
        return row!;
      })
      .catch((err: unknown) => uniqueViolation(err, 'party_name_taken'));
  }

  // --- people (for "owner" pickers; any signed-in user may see names and roles) ---

  async people(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`SELECT id, display_name AS "displayName", role FROM platform."user"
      WHERE status = 'active' ORDER BY lower(display_name)`;
  }

  // --- tenders ---

  async list(
    claims: TenantClaims,
    opts: { status?: string | undefined; q?: string | undefined; mine?: boolean | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const q = opts.q?.trim();
    const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const statusFilter =
      opts.status === 'open'
        ? db`AND t.status IN ${db(OPEN_STATUSES as string[])}`
        : opts.status === 'closed'
          ? db`AND t.status NOT IN ${db(OPEN_STATUSES as string[])}`
          : opts.status
            ? db`AND t.status = ${opts.status}`
            : db``;
    const items = await db`
      SELECT ${db.unsafe(TENDER_SUMMARY)}
      FROM tender.tender t
      LEFT JOIN platform.party c ON c.id = t.client_id
      LEFT JOIN platform."user" u ON u.id = t.owner_id
      WHERE true ${statusFilter}
        ${opts.mine ? db`AND t.owner_id = ${claims.sub}` : db``}
        ${
          pattern
            ? db`AND (t.title ILIKE ${pattern} OR t.number ILIKE ${pattern} OR t.client_ref ILIKE ${pattern}
                 OR c.name ILIKE ${pattern} OR t.location ILIKE ${pattern})`
            : db``
        }
      ORDER BY (t.status IN ${db(OPEN_STATUSES as string[])}) DESC, t.submission_due_at ASC NULLS LAST,
               t.created_at DESC
      LIMIT 500`;
    const counts = await db<{ status: string; n: number }[]>`
      SELECT status, count(*)::int AS n FROM tender.tender GROUP BY status`;
    return { items, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db`
      SELECT ${db.unsafe(TENDER_SUMMARY)}, t.source, t.portal_url AS "portalUrl", t.emd_amount AS "emdAmount",
        t.tender_fee AS "tenderFee", to_char(t.published_on, 'YYYY-MM-DD') AS "publishedOn", t.prebid_at AS "prebidAt",
        t.opening_at AS "openingAt", t.queries_due_at AS "queriesDueAt", t.bid_validity_days AS "bidValidityDays",
        t.status_reason AS "statusReason", t.description, t.created_at AS "createdAt", t.row_version AS "rowVersion",
        to_char(t.result_on, 'YYYY-MM-DD') AS "resultOn", t.result_category AS "resultCategory",
        t.awarded_value::text AS "awardedValue",
        (SELECT json_build_object('id', w.id, 'name', w.name) FROM platform.party w WHERE w.id = t.awarded_to)
          AS "awardedTo"
      FROM tender.tender t
      LEFT JOIN platform.party c ON c.id = t.client_id
      LEFT JOIN platform."user" u ON u.id = t.owner_id
      WHERE t.id = ${id}`;
    if (!t) throw new NotFoundException({ code: 'tender_not_found' });
    const [decisions, events] = await Promise.all([
      db`SELECT d.id, d.criteria, d.score, d.decision, d.reason, d.decided_at AS "decidedAt",
          u.display_name AS "decidedBy"
        FROM tender.bid_decision d JOIN platform."user" u ON u.id = d.decided_by
        WHERE d.tender_id = ${id} ORDER BY d.decided_at DESC`,
      db`SELECT e.id::text, e.kind, e.data, e.created_at AS "createdAt", u.display_name AS "actor"
        FROM tender.tender_event e LEFT JOIN platform."user" u ON u.id = e.actor_id
        WHERE e.tender_id = ${id} ORDER BY e.id DESC LIMIT 200`,
    ]);
    const status = t.status as TenderStatus;
    return {
      ...t,
      decisions,
      events,
      allowedMoves: allowedMoves(status),
      canDecide: DECISION_FROM.includes(status),
      defaultCriteria: await this.settings.criteria(db),
    };
  }

  async create(claims: TenantClaims, input: TenderInput, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db.begin(async (tx) => {
      await this.checkRefs(tx, input);
      const [entity] = await tx<{ id: string }[]>`
        SELECT id FROM platform.entity WHERE is_default LIMIT 1`;
      const number = await nextNumber(tx, 'tender', entity!.id, 'TND', now);
      const cols = {
        ...toColumns(input, TENDER_COLUMN),
        owner_id: input.ownerId ?? claims.sub,
        entity_id: entity!.id,
        number,
        created_by: claims.sub,
        updated_by: claims.sub,
      };
      const [row] = await tx<{ id: string }[]>`INSERT INTO tender.tender ${tx(cols)} RETURNING id`;
      await event(tx, row!.id, 'created', { number }, claims.sub);
      await audit(tx, claims.sub, 'tender.create', 'tender', row!.id, {
        number,
        title: input.title,
      });
      await this.reschedule(tx, row!.id, now);
      return row!.id;
    });
    return this.get(claims, id);
  }

  async update(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    input: Patch<TenderInput>,
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.checkRefs(tx, input);
      const cols = toColumns(input, TENDER_COLUMN);
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      const [row] = await tx`
        UPDATE tender.tender SET ${tx({ ...cols, updated_by: claims.sub })}, updated_at = now(),
          row_version = row_version + 1
        WHERE id = ${id} AND row_version = ${rowVersion} RETURNING id`;
      if (!row) await this.staleOrMissing(tx, 'tender.tender', id, 'tender_not_found');
      const fields = Object.keys(input).filter((k) => k in TENDER_COLUMN);
      await event(tx, id, 'updated', { fields }, claims.sub);
      await audit(tx, claims.sub, 'tender.update', 'tender', id, { fields });
      await this.reschedule(tx, id, now);
    });
    return this.get(claims, id);
  }

  async move(claims: TenantClaims, id: string, to: TenderStatus, reason: string, now = new Date()) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const from = await this.lockStatus(tx, id);
      await this.moveInTx(tx, claims.sub, id, from, to, reason, now);
    });
    return this.get(claims, id);
  }

  /** A status move inside the caller's transaction, the tender row already locked (`from` read under the lock). */
  async moveInTx(
    tx: TransactionSql,
    actorId: string,
    id: string,
    from: TenderStatus,
    to: TenderStatus,
    reason: string,
    now: Date,
  ) {
    if (!allowedMoves(from).includes(to))
      throw new BadRequestException({ code: 'invalid_status_change', from, to });
    if (REASON_REQUIRED.includes(to) && reason.trim().length < 3)
      throw new BadRequestException({ code: 'reason_required' });
    await tx`UPDATE tender.tender SET status = ${to}, status_reason = ${reason.trim() || null},
      updated_by = ${actorId}, updated_at = now(), row_version = row_version + 1 WHERE id = ${id}`;
    await event(tx, id, 'status_changed', { from, to, reason: reason.trim() }, actorId);
    await audit(tx, actorId, 'tender.status', 'tender', id, { from, to });
    // Lock on submission (E6): the BOQs as submitted are frozen; changes need a new revision.
    if (to === 'submitted') {
      const drafts = await tx<{ id: string }[]>`
        SELECT id FROM est.boq WHERE tender_id = ${id} AND status = 'draft' AND archived_at IS NULL
        ORDER BY created_at`;
      for (const b of drafts)
        await this.revisions.freezeInTx(tx, actorId, b.id, {
          kind: 'submitted',
          label: 'Submitted with the tender',
          note: reason.trim(),
        });
    }
    if (EMD_RETURN_DUE.includes(to)) await remindEmdReturn(tx, id, now);
    await this.reschedule(tx, id, now);
  }

  async decide(
    claims: TenantClaims,
    id: string,
    input: { criteria: Criterion[]; decision: 'bid' | 'no_bid'; reason: string },
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    // The company's criteria (or the built-in ones): every one scored, no other.
    const known = new Map((await this.settings.criteria(db)).map((c) => [c.key, c]));
    const keys = new Set(input.criteria.map((c) => c.key));
    if (
      keys.size !== input.criteria.length ||
      [...keys].some((k) => !known.has(k)) ||
      keys.size !== known.size
    )
      throw new BadRequestException({
        code: 'invalid_criteria',
        message: 'The bid criteria changed meanwhile. Reload and score again.',
      });
    if (input.decision === 'no_bid' && input.reason.trim().length < 3)
      throw new BadRequestException({ code: 'reason_required' });
    // Labels come from the server's list, so the stored history reads the same in every client.
    const criteria = input.criteria.map((c) => ({ ...c, label: known.get(c.key)!.label }));
    const score = bidScore(criteria);
    await db.begin(async (tx) => {
      const from = await this.lockStatus(tx, id);
      if (!DECISION_FROM.includes(from))
        throw new BadRequestException({ code: 'decision_not_allowed', status: from });
      const to: TenderStatus = input.decision === 'bid' ? 'bidding' : 'no_bid';
      await tx`INSERT INTO tender.bid_decision (tender_id, criteria, score, decision, reason, decided_by)
        VALUES (${id}, ${tx.json(criteria)}, ${score}, ${input.decision}, ${input.reason.trim()}, ${claims.sub})`;
      await tx`UPDATE tender.tender SET status = ${to},
          status_reason = ${input.decision === 'no_bid' ? input.reason.trim() : null},
          updated_by = ${claims.sub}, updated_at = now(), row_version = row_version + 1 WHERE id = ${id}`;
      await event(tx, id, 'decision', { decision: input.decision, score, from, to }, claims.sub);
      if (EMD_RETURN_DUE.includes(to)) await remindEmdReturn(tx, id, now);
      await audit(tx, claims.sub, 'tender.decision', 'tender', id, {
        decision: input.decision,
        score,
      });
      await this.reschedule(tx, id, now);
    });
    return this.get(claims, id);
  }

  // --- helpers ---

  /** Replaces the tender's future deadline reminders. Closed tenders keep none. */
  async reschedule(tx: TransactionSql, id: string, now: Date) {
    const source = `tender:${id}`;
    await tx`DELETE FROM platform.notification WHERE source = ${source} AND due_at > ${now}`;
    const [t] = await tx<
      {
        number: string;
        title: string;
        status: TenderStatus;
        owner_id: string | null;
        submission_due_at: Date | null;
        prebid_at: Date | null;
        queries_due_at: Date | null;
      }[]
    >`SELECT number, title, status, owner_id, submission_due_at, prebid_at, queries_due_at
      FROM tender.tender WHERE id = ${id}`;
    if (!t || !t.owner_id || !OPEN_STATUSES.includes(t.status) || t.status === 'submitted') return;
    const plans = deadlineReminders(
      {
        number: t.number,
        title: t.title,
        submissionDueAt: t.submission_due_at,
        prebidAt: t.prebid_at,
        queriesDueAt: t.queries_due_at,
      },
      now,
    );
    for (const p of plans) {
      await tx`INSERT INTO platform.notification (user_id, kind, title, link, due_at, source)
        VALUES (${t.owner_id}, 'tender_deadline', ${p.title}, ${`/tenders/${id}`}, ${p.dueAt}, ${source})`;
    }
  }

  async lockStatus(tx: TransactionSql, id: string): Promise<TenderStatus> {
    const [t] = await tx<{ status: TenderStatus }[]>`
      SELECT status FROM tender.tender WHERE id = ${id} FOR UPDATE`;
    if (!t) throw new NotFoundException({ code: 'tender_not_found' });
    return t.status;
  }

  private async checkRefs(tx: TransactionSql, input: Patch<TenderInput>) {
    if (input.clientId) {
      const [c] = await tx`SELECT 1 FROM platform.party
        WHERE id = ${input.clientId} AND is_client AND deleted_at IS NULL`;
      if (!c) throw new BadRequestException({ code: 'client_not_found' });
    }
    if (input.ownerId) {
      const [u] =
        await tx`SELECT 1 FROM platform."user" WHERE id = ${input.ownerId} AND status = 'active'`;
      if (!u) throw new BadRequestException({ code: 'owner_not_found' });
    }
  }

  private async staleOrMissing(
    tx: TransactionSql | Sql,
    table: 'platform.party' | 'tender.tender',
    id: string,
    missingCode: string,
  ): Promise<never> {
    const [r] = await tx.unsafe(`SELECT row_version FROM ${table} WHERE id = $1`, [id]);
    if (!r) throw new NotFoundException({ code: missingCode });
    throw new ConflictException({
      code: 'stale_row',
      message: 'Someone else changed this record. Reload to see their changes.',
    });
  }
}
