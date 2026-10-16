// Receivables (docs/wave3-plan.md step 3): money from clients, with the TDS and other deductions they made, allocated
// to certified bills, retention released and mobilisation advances; posted as receipt vouchers; cancelled by reversing
// the voucher. What each client still owes, aged from the invoice date.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt, type Dec } from '../rates/decimal.js';
import { audit } from '../tender/tender-records.js';
import { fromDb } from './accounts-rules.js';
import { LedgerService, type LineInput } from './ledger.service.js';

type Db = Sql | TransactionSql;
const money = (v: Dec) => fmt(v, 2);
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
export const BUCKETS = ['0-30', '31-60', '61-90', 'over 90'] as const;
const bucketOf = (d: number) => (d <= 30 ? 0 : d <= 60 ? 1 : d <= 90 ? 2 : 3);

export interface ReceiptInput {
  entityId: string;
  partyId: string;
  receivedOn: string;
  bankAccountId: string;
  amount: string;
  tds: string;
  /** GST TDS (section 51) deducted by a government client. */
  gstTds: string;
  reference: string;
  narration: string;
  allocations: {
    kind: 'bill' | 'retention' | 'advance';
    billId: string | null;
    projectId: string | null;
    amount: string;
  }[];
  deductions: { description: string; amount: string; accountId: string }[];
}

@Injectable()
export class ReceivableService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          p === 'accounts.view'
            ? 'Receivables need the accounts permission.'
            : 'Recording receipts needs the permission to post.',
      });
  }

  /** A client's certified bills with what is received and outstanding, as at a date (receipts to then). */
  private bills(db: Db, entityId: string, partyId: string | null, asOf: string | null) {
    return db<
      {
        id: string;
        raNo: number;
        project: { id: string; number: string; name: string };
        party: { id: string; name: string };
        invoiceNo: string;
        invoiceDate: string;
        net: string;
        received: string;
        credited: string;
        outstanding: string;
      }[]
    >`
      SELECT b.id, b.ra_no AS "raNo", json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        json_build_object('id', c.id, 'name', c.name) AS party, b.invoice_no AS "invoiceNo",
        to_char(b.invoice_date, 'YYYY-MM-DD') AS "invoiceDate", (b.certified ->> 'net') AS net,
        coalesce(r.amount, 0)::text AS received, coalesce(n.amount, 0)::text AS credited,
        ((b.certified ->> 'net')::numeric - coalesce(r.amount, 0) - coalesce(n.amount, 0))::text AS outstanding
      FROM acc.client_bill b JOIN proj.project p ON p.id = b.project_id JOIN platform.party c ON c.id = p.client_id
      LEFT JOIN LATERAL (
        SELECT sum(a.amount) AS amount FROM acc.client_receipt_alloc a
        JOIN acc.client_receipt r ON r.id = a.receipt_id AND r.status = 'posted'
        WHERE a.bill_id = b.id ${asOf ? db`AND r.received_on <= ${asOf}` : db``}
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT sum(cn.total) AS amount FROM acc.credit_note cn
        WHERE cn.bill_id = b.id ${asOf ? db`AND cn.note_date <= ${asOf}` : db``}
      ) n ON true
      WHERE b.status = 'certified' AND b.entity_id = ${entityId}
        ${partyId ? db`AND p.client_id = ${partyId}` : db``}
        ${asOf ? db`AND b.invoice_date <= ${asOf}` : db``}
      ORDER BY c.name, b.invoice_date, p.number, b.ra_no`;
  }

  /** Per project of the client: retention held and released; mobilisation advance received and recovered. */
  private projects(db: Db, entityId: string, partyId: string | null, asOf: string | null) {
    const upto = asOf ? db`AND r.received_on <= ${asOf}` : db``;
    const billsTo = asOf ? db`AND b.invoice_date <= ${asOf}` : db``;
    return db<
      {
        project: { id: string; number: string; name: string };
        party: { id: string; name: string };
        retentionHeld: string;
        retentionReleased: string;
        advanceReceived: string;
        advanceRecovered: string;
      }[]
    >`
      SELECT json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        json_build_object('id', c.id, 'name', c.name) AS party,
        coalesce((SELECT sum((b.certified ->> 'retention')::numeric) FROM acc.client_bill b
          WHERE b.project_id = p.id AND b.entity_id = ${entityId} AND b.status = 'certified' ${billsTo}), 0)::text
          AS "retentionHeld",
        coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id
          WHERE a.project_id = p.id AND a.kind = 'retention' AND r.status = 'posted' AND r.entity_id = ${entityId} ${upto}),
          0)::text AS "retentionReleased",
        coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id
          WHERE a.project_id = p.id AND a.kind = 'advance' AND r.status = 'posted' AND r.entity_id = ${entityId} ${upto}),
          0)::text AS "advanceReceived",
        coalesce((SELECT sum((b.certified ->> 'advanceRecovery')::numeric) FROM acc.client_bill b
          WHERE b.project_id = p.id AND b.entity_id = ${entityId} AND b.status = 'certified' ${billsTo}), 0)::text
          AS "advanceRecovered"
      FROM proj.project p JOIN platform.party c ON c.id = p.client_id
      WHERE p.entity_id = ${entityId} ${partyId ? db`AND p.client_id = ${partyId}` : db``}
      ORDER BY c.name, p.number`;
  }

  /** What a receipt from this client can settle. */
  async openItems(claims: TenantClaims, entityId: string, partyId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const bills = (await this.bills(db, entityId, partyId, null)).filter(
      (b) => dec(b.outstanding) !== 0n,
    );
    const projects = (await this.projects(db, entityId, partyId, null)).map((p) => ({
      ...p,
      retentionOpen: money(dec(p.retentionHeld) - dec(p.retentionReleased)),
    }));
    return { bills, projects };
  }

  async record(claims: TenantClaims, input: ReceiptInput) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const id = randomUUID();
    await db
      .begin(async (tx) => {
        const [bank] = await tx<
          { kind: string }[]
        >`SELECT kind FROM acc.account WHERE id = ${input.bankAccountId}`;
        if (bank?.kind !== 'bank' && bank?.kind !== 'cash')
          throw new BadRequestException({
            code: 'not_bank',
            message: 'The money comes into a bank or cash ledger.',
          });
        const settled =
          dec(input.amount) +
          dec(input.tds) +
          dec(input.gstTds) +
          input.deductions.reduce((s, d) => s + dec(d.amount), 0n);
        const allocated = input.allocations.reduce((s, a) => s + dec(a.amount), 0n);
        if (allocated !== settled)
          throw new BadRequestException({
            code: 'not_allocated',
            message: `The receipt settles ₹${money(settled)} (received, TDS, GST TDS and deductions); ₹${money(allocated)} is allocated.`,
          });
        // Each allocation within what is open, the bills locked so two receipts cannot both settle the same rupees.
        const lines: LineInput[] = [];
        const partyLedger = await this.ledger.partyLedger(tx, input.partyId);
        const line = (
          accountId: string,
          debit: string,
          credit: string,
          projectId: string | null,
          note = '',
        ): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId,
          siteId: null,
          costCodeId: null,
          note,
        });
        const open = await this.projects(tx, input.entityId, input.partyId, null);
        const retentionUsed = new Map<string, Dec>();
        for (const [i, a] of input.allocations.entries()) {
          const amount = dec(a.amount);
          if (a.kind === 'bill') {
            const [b] = await tx<
              {
                project_id: string;
                net: string;
                party: string | null;
                entity_id: string;
                status: string;
                ra_no: number;
              }[]
            >`
              SELECT b.project_id, (b.certified ->> 'net') AS net, p.client_id AS party, b.entity_id, b.status, b.ra_no
              FROM acc.client_bill b JOIN proj.project p ON p.id = b.project_id WHERE b.id = ${a.billId} FOR UPDATE OF b`;
            if (
              !b ||
              b.status !== 'certified' ||
              b.entity_id !== input.entityId ||
              b.party !== input.partyId
            )
              throw new BadRequestException({
                code: 'bad_allocation',
                message: `Line ${i + 1}: not a certified bill of this client.`,
              });
            const [r] = await tx<{ received: string }[]>`
              SELECT (coalesce(sum(a.amount), 0)
                + coalesce((SELECT sum(total) FROM acc.credit_note WHERE bill_id = ${a.billId}), 0))::text AS received
              FROM acc.client_receipt_alloc a
              JOIN acc.client_receipt r ON r.id = a.receipt_id AND r.status = 'posted' WHERE a.bill_id = ${a.billId}`;
            const left = dec(b.net) - dec(r!.received);
            if (amount > left)
              throw new BadRequestException({
                code: 'over_allocated',
                message: `RA ${b.ra_no}: ₹${money(left)} is outstanding, not ₹${money(amount)}.`,
              });
            a.projectId = b.project_id;
            lines.push(line(partyLedger, '0', money(amount), b.project_id, `RA ${b.ra_no}`));
          } else {
            const p = open.find((x) => x.project.id === a.projectId);
            if (!p)
              throw new BadRequestException({
                code: 'bad_allocation',
                message: `Line ${i + 1}: not a project of this client.`,
              });
            if (a.kind === 'retention') {
              const used = (retentionUsed.get(p.project.id) ?? 0n) + amount;
              const held = dec(p.retentionHeld) - dec(p.retentionReleased);
              if (used > held)
                throw new BadRequestException({
                  code: 'over_allocated',
                  message: `${p.project.number}: ₹${money(held)} of retention is held, not ₹${money(used)}.`,
                });
              retentionUsed.set(p.project.id, used);
              lines.push(
                line(
                  await this.ledger.roleAccount(tx, input.entityId, 'retention_receivable'),
                  '0',
                  money(amount),
                  p.project.id,
                  'Retention released',
                ),
              );
            } else
              lines.push(
                line(
                  await this.ledger.roleAccount(
                    tx,
                    input.entityId,
                    'mobilisation_advance_received',
                  ),
                  '0',
                  money(amount),
                  p.project.id,
                  'Mobilisation advance',
                ),
              );
          }
        }
        const dr = [
          line(input.bankAccountId, input.amount, '0', null),
          ...(dec(input.tds) > 0n
            ? [
                line(
                  await this.ledger.roleAccount(tx, input.entityId, 'tds_receivable'),
                  input.tds,
                  '0',
                  null,
                  'TDS deducted by the client',
                ),
              ]
            : []),
          ...(dec(input.gstTds) > 0n
            ? [
                line(
                  await this.ledger.roleAccount(tx, input.entityId, 'gst_tds_receivable'),
                  input.gstTds,
                  '0',
                  null,
                  'GST TDS deducted by the client (section 51)',
                ),
              ]
            : []),
          ...input.deductions.map((d) => line(d.accountId, d.amount, '0', null, d.description)),
        ];
        // A ledger that needs a project takes the first project the receipt settles.
        const firstProject = input.allocations[0]?.projectId ?? null;
        for (const l of dr) {
          const [a] = await tx<
            { needs: boolean }[]
          >`SELECT needs_project AS needs FROM acc.account WHERE id = ${l.accountId}`;
          if (a?.needs) l.projectId = firstProject;
        }
        const [party] = await tx<
          { name: string }[]
        >`SELECT name FROM platform.party WHERE id = ${input.partyId}`;
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: input.entityId,
            type: 'receipt',
            date: input.receivedOn,
            narration: input.narration || `From ${party!.name}`,
            reference: input.reference,
            lines: [...dr, ...lines],
          },
          { kind: 'client_receipt', id },
        );
        await tx`
          INSERT INTO acc.client_receipt (id, entity_id, party_id, received_on, bank_account_id, amount, tds, gst_tds,
            reference, narration, voucher_id, created_by, updated_by)
          VALUES (${id}, ${input.entityId}, ${input.partyId}, ${input.receivedOn}, ${input.bankAccountId}, ${input.amount},
            ${input.tds}, ${input.gstTds}, ${input.reference}, ${input.narration}, ${v!.id}, ${claims.sub}, ${claims.sub})`;
        for (const [i, a] of input.allocations.entries())
          await tx`INSERT INTO acc.client_receipt_alloc (receipt_id, position, kind, bill_id, project_id, amount)
            VALUES (${id}, ${i + 1}, ${a.kind}, ${a.kind === 'bill' ? a.billId : null}, ${a.projectId}, ${a.amount})`;
        for (const [i, d] of input.deductions.entries())
          await tx`INSERT INTO acc.client_receipt_deduction (receipt_id, position, description, amount, account_id)
            VALUES (${id}, ${i + 1}, ${d.description}, ${d.amount}, ${d.accountId})`;
        await audit(tx, claims.sub, 'client_receipt.record', 'client_receipt', id, {
          amount: input.amount,
        });
      })
      .catch(fromDb);
    return this.get(claims, id);
  }

  /** Cancelled: its voucher reversed on the day given, its allocations no longer counted. */
  async cancel(claims: TenantClaims, id: string, b: { date: string; reason: string }) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [r] = await tx<
          { entity_id: string; status: string; voucher_id: string; received_on: string }[]
        >`
          SELECT entity_id, status, voucher_id, to_char(received_on, 'YYYY-MM-DD') AS received_on
          FROM acc.client_receipt WHERE id = ${id} FOR UPDATE`;
        if (!r) throw new NotFoundException({ code: 'receipt_not_found' });
        if (r.status !== 'posted')
          throw new ConflictException({ code: 'cancelled', message: 'Already cancelled.' });
        if (b.date < r.received_on)
          throw new BadRequestException({
            code: 'before_receipt',
            message: 'Cancel on or after the day it was received.',
          });
        const [v] = await tx<
          { number: string }[]
        >`SELECT number FROM acc.voucher WHERE id = ${r.voucher_id}`;
        const back = await tx<LineInput[]>`
          SELECT account_id AS "accountId", NULL AS "partyId", credit::text AS debit, debit::text AS credit,
            project_id AS "projectId", site_id AS "siteId", cost_code_id AS "costCodeId", note
          FROM acc.voucher_line WHERE voucher_id = ${r.voucher_id} ORDER BY position`;
        const rev = await this.ledger.post(
          tx,
          claims,
          {
            entityId: r.entity_id,
            type: 'receipt',
            date: b.date,
            narration: `Cancelled: ${v!.number}: ${b.reason}`,
            reference: v!.number,
            lines: back,
          },
          { kind: 'client_receipt', id },
          r.voucher_id,
        );
        await tx`UPDATE acc.client_receipt SET status = 'cancelled', status_reason = ${b.reason}, cancel_voucher_id = ${rev!.id},
            updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
          WHERE id = ${id}`;
        await audit(tx, claims.sub, 'client_receipt.cancel', 'client_receipt', id, {
          reason: b.reason,
        });
      })
      .catch(fromDb);
    return this.get(claims, id);
  }

  async get(claims: TenantClaims, id: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await db`
      SELECT r.id, r.entity_id AS "entityId", e.name AS company, json_build_object('id', c.id, 'name', c.name) AS party,
        to_char(r.received_on, 'YYYY-MM-DD') AS "receivedOn",
        json_build_object('id', a.id, 'code', a.code, 'name', a.name) AS bank, r.amount::text AS amount, r.tds::text AS tds,
        r.gst_tds::text AS "gstTds",
        r.reference, r.narration, r.status, r.status_reason AS "statusReason",
        (SELECT json_build_object('id', v.id, 'number', v.number) FROM acc.voucher v WHERE v.id = r.voucher_id) AS voucher,
        (SELECT json_build_object('id', v.id, 'number', v.number) FROM acc.voucher v WHERE v.id = r.cancel_voucher_id)
          AS "cancelVoucher",
        coalesce((SELECT json_agg(json_build_object('kind', x.kind, 'amount', x.amount::text, 'billId', x.bill_id,
          'raNo', b.ra_no, 'invoiceNo', b.invoice_no, 'project', json_build_object('id', p.id, 'number', p.number,
          'name', p.name)) ORDER BY x.position)
          FROM acc.client_receipt_alloc x JOIN proj.project p ON p.id = x.project_id
          LEFT JOIN acc.client_bill b ON b.id = x.bill_id WHERE x.receipt_id = r.id), '[]') AS allocations,
        coalesce((SELECT json_agg(json_build_object('description', d.description, 'amount', d.amount::text,
          'account', json_build_object('code', da.code, 'name', da.name)) ORDER BY d.position)
          FROM acc.client_receipt_deduction d JOIN acc.account da ON da.id = d.account_id WHERE d.receipt_id = r.id), '[]')
          AS deductions
      FROM acc.client_receipt r JOIN platform.entity e ON e.id = r.entity_id JOIN platform.party c ON c.id = r.party_id
      JOIN acc.account a ON a.id = r.bank_account_id WHERE r.id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'receipt_not_found' });
    return {
      ...r,
      mayCancel: r.status === 'posted' && (await this.permissions.can(claims, 'accounts.post')),
    };
  }

  async list(claims: TenantClaims, q: { entityId: string; partyId?: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT r.id, to_char(r.received_on, 'YYYY-MM-DD') AS "receivedOn", c.name AS party, r.amount::text AS amount,
        r.tds::text AS tds, r.reference, r.status, v.number AS voucher
      FROM acc.client_receipt r JOIN platform.party c ON c.id = r.party_id JOIN acc.voucher v ON v.id = r.voucher_id
      WHERE r.entity_id = ${q.entityId} ${q.partyId ? db`AND r.party_id = ${q.partyId}` : db``}
      ORDER BY r.received_on DESC, r.created_at DESC LIMIT 500`;
  }

  /** What every client owes as at a date: bills outstanding aged from the invoice date, retention held, advances. */
  async receivables(claims: TenantClaims, q: { entityId: string; asOf: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const bills = (await this.bills(db, q.entityId, null, q.asOf))
      .filter((b) => dec(b.outstanding) !== 0n)
      .map((b) => {
        const age = days(b.invoiceDate, q.asOf);
        return { ...b, ageDays: age, bucket: BUCKETS[bucketOf(age)] };
      });
    const projects = await this.projects(db, q.entityId, null, q.asOf);
    const clients = new Map<
      string,
      {
        party: { id: string; name: string };
        buckets: Dec[];
        outstanding: Dec;
        retention: Dec;
        advance: Dec;
      }
    >();
    const of = (party: { id: string; name: string }) => {
      const c = clients.get(party.id) ?? {
        party,
        buckets: [0n, 0n, 0n, 0n],
        outstanding: 0n,
        retention: 0n,
        advance: 0n,
      };
      clients.set(party.id, c);
      return c;
    };
    for (const b of bills) {
      const c = of(b.party);
      c.buckets[bucketOf(b.ageDays)]! += dec(b.outstanding);
      c.outstanding += dec(b.outstanding);
    }
    for (const p of projects) {
      const held = dec(p.retentionHeld) - dec(p.retentionReleased);
      const adv = dec(p.advanceReceived) - dec(p.advanceRecovered);
      if (held === 0n && adv === 0n) continue;
      const c = of(p.party);
      c.retention += held;
      c.advance += adv;
    }
    const list = [...clients.values()].sort((a, b) => a.party.name.localeCompare(b.party.name));
    const total = (f: (c: (typeof list)[number]) => Dec) =>
      money(list.reduce((s, c) => s + f(c), 0n));
    return {
      asOf: q.asOf,
      buckets: BUCKETS,
      clients: list.map((c) => ({
        party: c.party,
        buckets: c.buckets.map(money),
        outstanding: money(c.outstanding),
        retentionHeld: money(c.retention),
        advanceUnrecovered: money(c.advance),
      })),
      bills,
      totals: {
        buckets: BUCKETS.map((_, i) => total((c) => c.buckets[i]!)),
        outstanding: total((c) => c.outstanding),
        retentionHeld: total((c) => c.retention),
        advanceUnrecovered: total((c) => c.advance),
      },
    };
  }
}
