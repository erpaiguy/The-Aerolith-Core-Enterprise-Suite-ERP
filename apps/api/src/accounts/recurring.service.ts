// Recurring entries (docs/wave7-plan.md step 7d.7): a voucher or a supplier bill set to come round monthly, quarterly
// or yearly from a start date (to an end date, if any), on a day of the month. Each due day up to today gets a draft;
// accounts post it (a voucher as set; a bill with the supplier's invoice number for that month) or skip it.
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
import { fromDb, type VoucherType } from './accounts-rules.js';
import { LedgerService, type LineInput } from './ledger.service.js';
import { PayableService, type VendorBillInput } from './payable.service.js';

type Db = Sql | TransactionSql;
type Frequency = 'monthly' | 'quarterly' | 'yearly';
const STEP: Record<Frequency, number> = { monthly: 1, quarterly: 3, yearly: 12 };

export interface VoucherBody {
  type: VoucherType;
  narration: string;
  reference: string;
  lines: LineInput[];
}
export interface BillBody {
  partyId: string;
  projectId: string | null;
  tdsSection: string | null;
  narration: string;
  dueDays: number;
  lines: VendorBillInput['lines'];
}
export interface RecurringInput {
  entityId: string;
  kind: 'voucher' | 'bill';
  name: string;
  frequency: Frequency;
  dayOfMonth: number;
  startsOn: string;
  endsOn: string | null;
  voucher: VoucherBody | null;
  bill: BillBody | null;
}

const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The due days from the start to `upto` (and the end, if any). */
export function dueDays(
  r: { frequency: Frequency; dayOfMonth: number; startsOn: string; endsOn: string | null },
  upto: string,
) {
  const out: string[] = [];
  const last = r.endsOn && r.endsOn < upto ? r.endsOn : upto;
  let [y, m] = [Number(r.startsOn.slice(0, 4)), Number(r.startsOn.slice(5, 7))];
  for (let i = 0; i < 1200; i++) {
    const day = `${y}-${String(m).padStart(2, '0')}-${String(r.dayOfMonth).padStart(2, '0')}`;
    if (day > last) break;
    if (day >= r.startsOn) out.push(day);
    m += STEP[r.frequency];
    while (m > 12) [y, m] = [y + 1, m - 12];
  }
  return out;
}

@Injectable()
export class RecurringService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
    private readonly payables: PayableService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          p === 'accounts.view'
            ? 'Recurring entries need the accounts permission.'
            : 'Posting needs the permission to post.',
      });
  }

  /** Drafts for every due day up to today that has none yet. */
  private async draftDue(db: Db, entityId: string) {
    const today = indiaToday();
    const rows = await db<
      { id: string; frequency: Frequency; day: number; starts: string; ends: string | null }[]
    >`
      SELECT id, frequency, day_of_month AS day, to_char(starts_on, 'YYYY-MM-DD') AS starts,
        to_char(ends_on, 'YYYY-MM-DD') AS ends
      FROM acc.recurring WHERE entity_id = ${entityId} AND active AND starts_on <= ${today}`;
    for (const r of rows) {
      const days = dueDays(
        { frequency: r.frequency, dayOfMonth: r.day, startsOn: r.starts, endsOn: r.ends },
        today,
      );
      if (days.length)
        await db`
          INSERT INTO acc.recurring_draft (recurring_id, due_on)
          SELECT ${r.id}, d::date FROM unnest(${days}::text[]) AS d
          ON CONFLICT (recurring_id, due_on) DO NOTHING`;
    }
  }

  async list(claims: TenantClaims, entityId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    await this.draftDue(db, entityId);
    const today = indiaToday();
    const templates = await db<
      {
        id: string;
        kind: string;
        name: string;
        frequency: Frequency;
        dayOfMonth: number;
        startsOn: string;
        endsOn: string | null;
        active: boolean;
        amount: string;
        party: string | null;
        due: number;
      }[]
    >`
      SELECT r.id, r.kind, r.name, r.frequency, r.day_of_month AS "dayOfMonth",
        to_char(r.starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(r.ends_on, 'YYYY-MM-DD') AS "endsOn", r.active,
        CASE WHEN r.kind = 'voucher'
          THEN (SELECT coalesce(sum((l->>'debit')::numeric), 0) FROM jsonb_array_elements(r.body->'lines') l)
          ELSE (SELECT coalesce(sum((l->>'qty')::numeric * (l->>'rate')::numeric), 0)
            FROM jsonb_array_elements(r.body->'lines') l) END::numeric(20,2)::text AS amount,
        pa.name AS party,
        (SELECT count(*)::int FROM acc.recurring_draft d WHERE d.recurring_id = r.id AND d.status = 'due') AS due
      FROM acc.recurring r LEFT JOIN platform.party pa ON pa.id = (r.body->>'partyId')::uuid
      WHERE r.entity_id = ${entityId} ORDER BY r.name`;
    const drafts = await db`
      SELECT d.id, d.recurring_id AS "recurringId", r.name, r.kind, to_char(d.due_on, 'YYYY-MM-DD') AS "dueOn",
        d.status, d.note, v.number AS voucher, b.bill_no AS bill
      FROM acc.recurring_draft d JOIN acc.recurring r ON r.id = d.recurring_id
      LEFT JOIN acc.voucher v ON v.id = d.voucher_id LEFT JOIN acc.vendor_bill b ON b.id = d.bill_id
      WHERE r.entity_id = ${entityId} AND (d.status = 'due' OR d.done_at > now() - interval '45 days')
      ORDER BY d.status = 'due' DESC, d.due_on DESC, r.name LIMIT 200`;
    return {
      today,
      templates: templates.map((t) => ({
        ...t,
        next: dueDays(t, addDays(today, 400)).find((d) => d > today) ?? null,
      })),
      drafts,
      mayPost: await this.permissions.can(claims, 'accounts.post'),
    };
  }

  async create(claims: TenantClaims, b: RecurringInput) {
    await this.may(claims, 'accounts.post');
    const body = b.kind === 'voucher' ? b.voucher : b.bill;
    if (!body)
      throw new BadRequestException({
        code: 'no_body',
        message: b.kind === 'voucher' ? 'Give the voucher.' : 'Give the bill.',
      });
    if (b.kind === 'voucher') {
      const v = b.voucher!;
      const sum = (k: 'debit' | 'credit') => v.lines.reduce((t, l) => t + Number(l[k] || 0), 0);
      if (v.lines.length < 2 || Math.abs(sum('debit') - sum('credit')) > 0.004)
        throw new BadRequestException({
          code: 'unbalanced',
          message: 'The debits and credits must be equal.',
        });
    }
    const db = await this.tenants.forTenant(claims.ten);
    await db`
      INSERT INTO acc.recurring (entity_id, kind, name, frequency, day_of_month, starts_on, ends_on, body, created_by)
      VALUES (${b.entityId}, ${b.kind}, ${b.name}, ${b.frequency}, ${b.dayOfMonth}, ${b.startsOn}, ${b.endsOn},
        ${db.json(JSON.parse(JSON.stringify(body)))}, ${claims.sub})`;
    return this.list(claims, b.entityId);
  }

  async setActive(claims: TenantClaims, id: string, active: boolean) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await db<{ entity_id: string }[]>`
      UPDATE acc.recurring SET active = ${active} WHERE id = ${id} RETURNING entity_id`;
    if (!r) throw new NotFoundException({ code: 'not_found' });
    return this.list(claims, r.entity_id);
  }

  private async draft(db: Db, id: string) {
    const [d] = await db<
      {
        status: string;
        due_on: string;
        entity_id: string;
        kind: 'voucher' | 'bill';
        name: string;
        body: VoucherBody & BillBody;
        recurring_id: string;
      }[]
    >`
      SELECT d.status, to_char(d.due_on, 'YYYY-MM-DD') AS due_on, r.entity_id, r.kind, r.name, r.body, r.id AS recurring_id
      FROM acc.recurring_draft d JOIN acc.recurring r ON r.id = d.recurring_id WHERE d.id = ${id}`;
    if (!d) throw new NotFoundException({ code: 'not_found' });
    if (d.status !== 'due')
      throw new ConflictException({ code: 'done', message: 'That draft is already dealt with.' });
    return d;
  }

  /** A due draft posted: a voucher as set, dated its due day; a bill with the supplier's number for it. */
  async post(claims: TenantClaims, id: string, b: { billNo: string | null }) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const d = await this.draft(db, id);
    const month = d.due_on.slice(0, 7);
    if (d.kind === 'voucher') {
      await db
        .begin(async (tx) => {
          const [lock] = await tx`
            SELECT 1 FROM acc.recurring_draft WHERE id = ${id} AND status = 'due' FOR UPDATE`;
          if (!lock) throw new ConflictException({ code: 'done' });
          const v = await this.ledger.post(
            tx,
            claims,
            {
              entityId: d.entity_id,
              type: d.body.type,
              date: d.due_on,
              narration: `${d.body.narration || d.name} (${month})`,
              reference: d.body.reference,
              lines: d.body.lines,
            },
            { kind: 'recurring', id: d.recurring_id },
          );
          await tx`
            UPDATE acc.recurring_draft SET status = 'posted', voucher_id = ${v!.id}, done_at = now(),
              done_by = ${claims.sub}
            WHERE id = ${id}`;
        })
        .catch(fromDb);
    } else {
      if (!b.billNo)
        throw new BadRequestException({
          code: 'bill_no',
          message: "Give the supplier's invoice number for this month.",
        });
      const bill = await this.payables.createBill(claims, {
        entityId: d.entity_id,
        partyId: d.body.partyId,
        orderId: null,
        projectId: d.body.projectId,
        billNo: b.billNo,
        billDate: d.due_on,
        dueDate: addDays(d.due_on, d.body.dueDays),
        tdsSection: d.body.tdsSection,
        narration: `${d.body.narration || d.name} (${month})`,
        // A bill line needs a description; a blank one takes the entry's name.
        lines: (d.body as BillBody).lines.map((l) => ({
          ...l,
          description: l.description.trim() || d.name,
        })),
      });
      await db`
        UPDATE acc.recurring_draft SET status = 'posted', bill_id = ${(bill as unknown as { id: string }).id},
          done_at = now(), done_by = ${claims.sub}
        WHERE id = ${id} AND status = 'due'`;
    }
    return this.list(claims, d.entity_id);
  }

  async skip(claims: TenantClaims, id: string, note: string) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const d = await this.draft(db, id);
    await db`
      UPDATE acc.recurring_draft SET status = 'skipped', note = ${note}, done_at = now(), done_by = ${claims.sub}
      WHERE id = ${id} AND status = 'due'`;
    return this.list(claims, d.entity_id);
  }
}
