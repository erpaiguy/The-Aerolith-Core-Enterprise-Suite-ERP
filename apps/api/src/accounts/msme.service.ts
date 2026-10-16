// MSME suppliers (docs/wave8-plan.md step 8b.4). A micro or small enterprise (registered on Udyam) is to be paid
// within the agreed term, and never beyond 45 days of acceptance (MSMED Act section 15; the bill's date is taken as the
// day of acceptance). Payables warns of bills nearing that day; at the year end, what was not paid in time is
// disallowed under section 43B(h) of the Income-tax Act until it is paid; and twice a year, MSME-1 reports what is owed
// beyond 45 days. Medium enterprises are listed but not counted: the 45 days do not bind them.
// [Guessing] The tax treatment is the CA's to confirm.
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt } from '../rates/decimal.js';

type Db = Sql | TransactionSql;
const money = (v: bigint) => fmt(v, 2);

export interface MsmeBill {
  billId: string;
  billNo: string;
  billDate: string;
  partyId: string;
  party: string;
  pan: string | null;
  udyamNo: string | null;
  msmeType: 'micro' | 'small' | 'medium';
  dueDate: string;
  /** The 45th day from the bill, or the agreed due date if earlier. */
  limitDate: string;
  total: string;
  /** What was paid, applied or noted by the limit date. */
  paidInTime: string;
  outstanding: string;
}

/** The last day a supplier may be paid on: the agreed date, but never beyond the 45th day. */
export function limitDate(billDate: string, dueDate: string) {
  const d = new Date(`${billDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 45);
  const l = d.toISOString().slice(0, 10);
  return dueDate < l ? dueDate : l;
}

@Injectable()
export class MsmeService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  private async may(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'accounts.view')))
      throw new ForbiddenException({ code: 'forbidden', message: 'Only accounts may see this.' });
  }

  /** Posted bills of MSME suppliers dated up to the day, with what was settled by the limit and is left. */
  private async bills(db: Db, entityId: string, asOf: string): Promise<MsmeBill[]> {
    const rows = await db<Omit<MsmeBill, 'limitDate' | 'paidInTime' | 'outstanding'>[]>`
      SELECT b.id AS "billId", b.bill_no AS "billNo", to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
        p.id AS "partyId", p.name AS party, coalesce(p.pan, substr(p.gstin, 3, 10)) AS pan, p.udyam_no AS "udyamNo",
        p.msme_type AS "msmeType", to_char(b.due_date, 'YYYY-MM-DD') AS "dueDate", b.payable::text AS total
      FROM acc.vendor_bill b JOIN platform.party p ON p.id = b.party_id
      WHERE b.entity_id = ${entityId} AND b.status = 'posted' AND p.msme_type IS NOT NULL
        AND b.bill_date <= ${asOf}
      ORDER BY b.bill_date, p.name, b.bill_no`;
    if (!rows.length) return [];
    // What settled each bill, and when: payments, advances applied, debit notes.
    const settled = await db<{ billId: string; settledOn: string; amount: string }[]>`
      SELECT l.bill_id AS "billId", to_char(r.paid_on, 'YYYY-MM-DD') AS "settledOn", l.amount::text AS amount
      FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id AND r.status = 'paid'
      WHERE l.bill_id = ANY(${rows.map((r) => r.billId)}::uuid[])
      UNION ALL
      SELECT a.bill_id, to_char(a.applied_on, 'YYYY-MM-DD'), a.amount::text FROM acc.advance_application a
      WHERE a.bill_id = ANY(${rows.map((r) => r.billId)}::uuid[])
      UNION ALL
      SELECT d.bill_id, to_char(d.note_date, 'YYYY-MM-DD'), d.total::text FROM acc.debit_note d
      WHERE d.bill_id = ANY(${rows.map((r) => r.billId)}::uuid[])`;
    return rows.map((r) => {
      const limit = limitDate(r.billDate, r.dueDate);
      const mine = settled.filter((s) => s.billId === r.billId && s.settledOn <= asOf);
      const inTime = mine
        .filter((s) => s.settledOn <= limit)
        .reduce((t, s) => t + dec(s.amount), 0n);
      const all = mine.reduce((t, s) => t + dec(s.amount), 0n);
      return {
        ...r,
        limitDate: limit,
        paidInTime: money(inTime),
        outstanding: money(dec(r.total) - all),
      };
    });
  }

  /** For payables: unpaid bills past their limit, and those reaching it within the week. */
  async alerts(claims: TenantClaims, q: { entityId: string; asOf: string }) {
    await this.may(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const week = new Date(`${q.asOf}T00:00:00Z`);
    week.setUTCDate(week.getUTCDate() + 7);
    const soon = week.toISOString().slice(0, 10);
    const open = (await this.bills(db, q.entityId, q.asOf)).filter(
      (b) => b.msmeType !== 'medium' && dec(b.outstanding) > 0n,
    );
    return {
      ...q,
      overdue: open.filter((b) => b.limitDate < q.asOf),
      dueSoon: open.filter((b) => b.limitDate >= q.asOf && b.limitDate <= soon),
    };
  }

  /**
   * Section 43B(h) at a year end: for each bill of the year from a micro or small supplier, what was not paid by its
   * limit and was still unpaid at the year end is disallowed this year (allowed in the year it is paid).
   */
  async disallowance(claims: TenantClaims, q: { entityId: string; year: number }) {
    await this.may(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const from = `${q.year}-04-01`;
    const to = `${q.year + 1}-03-31`;
    const rows = (await this.bills(db, q.entityId, to))
      .filter((b) => b.msmeType !== 'medium' && b.billDate >= from)
      .map((b) => {
        // Paid after the limit but within the year is allowed this year; still unpaid at the year end is not.
        const late = b.limitDate <= to ? dec(b.outstanding) : 0n;
        return { ...b, disallowed: money(late > 0n ? late : 0n) };
      })
      .filter((b) => dec(b.disallowed) > 0n);
    return {
      ...q,
      from,
      to,
      rows,
      total: money(rows.reduce((s, r) => s + dec(r.disallowed), 0n)),
    };
  }

  /** MSME-1 for a half year (April–September or October–March): owed to micro and small suppliers beyond 45 days. */
  async msme1(claims: TenantClaims, q: { entityId: string; half: string }) {
    await this.may(claims);
    const m = /^(\d{4})-H([12])$/.exec(q.half);
    if (!m) throw new BadRequestException({ code: 'bad_half', message: 'A half year: 2026-H1.' });
    const y = Number(m[1]);
    const to = m[2] === '1' ? `${y}-09-30` : `${y + 1}-03-31`;
    const db = await this.tenants.forTenant(claims.ten);
    const rows = (await this.bills(db, q.entityId, to)).filter(
      (b) => b.msmeType !== 'medium' && dec(b.outstanding) > 0n && b.limitDate < to,
    );
    const suppliers = new Map<
      string,
      {
        party: string;
        pan: string | null;
        udyamNo: string | null;
        amount: bigint;
        since: string;
        bills: number;
      }
    >();
    for (const b of rows) {
      const s = suppliers.get(b.partyId) ?? {
        party: b.party,
        pan: b.pan,
        udyamNo: b.udyamNo,
        amount: 0n,
        since: b.limitDate,
        bills: 0,
      };
      s.amount += dec(b.outstanding);
      s.bills += 1;
      if (b.limitDate < s.since) s.since = b.limitDate;
      suppliers.set(b.partyId, s);
    }
    const list = [...suppliers.values()].map((s) => ({ ...s, amount: money(s.amount) }));
    return {
      ...q,
      asOf: to,
      suppliers: list,
      total: money(rows.reduce((t, b) => t + dec(b.outstanding), 0n)),
      missingUdyam: list.filter((s) => !s.udyamNo).map((s) => s.party),
    };
  }
}
