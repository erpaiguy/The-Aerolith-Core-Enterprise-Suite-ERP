// Payables (docs/wave3-plan.md step 4): suppliers' bills matched to orders and receipts (held when they do not match,
// passed with a reason), TDS by section, input GST; debit notes; advances applied; payment runs under the approval
// rules, with a file for the bank, marked paid; what each supplier is owed, aged from the due date.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { ApprovalService, type Outcome } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, div, fmt, mul, type Dec } from '../rates/decimal.js';
import { nextNumber } from '../tender/numbering.js';
import { audit } from '../tender/tender-records.js';
import { fromDb, fyOf, isRole } from './accounts-rules.js';
import { LedgerService, type LineInput } from './ledger.service.js';
import { workTds, type TdsSection } from './tds.js';

type Db = Sql | TransactionSql;
export const PAYMENT_RUN = 'payment_run';
const TOLERANCE_KEY = 'payables.rate_tolerance_pct';
const money = (v: Dec) => fmt(v, 2);
const r2 = (v: Dec) => dec(fmt(v, 2));
const pct = (a: Dec, p: string) => r2(mul(a, div(dec(p), dec('100'))));
const days = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
export const PAY_BUCKETS = ['not due', '1-30', '31-60', '61-90', 'over 90'] as const;

interface RunHead {
  id: string;
  entityId: string;
  company: string;
  number: string;
  payOn: string;
  paidOn: string | null;
  status: 'draft' | 'pending' | 'approved' | 'paid' | 'cancelled';
  statusReason: string | null;
  total: string;
  bank: { id: string; code: string; name: string };
  lines: {
    position: number;
    kind: 'bill' | 'advance';
    amount: string;
    party: {
      id: string;
      name: string;
      accountNo: string | null;
      ifsc: string | null;
      accountName: string | null;
    };
    bill: { id: string; billNo: string; billDate: string; total: string; tds: string } | null;
    project: { number: string; name: string } | null;
    voucher: { id: string; number: string } | null;
  }[];
}

export interface BillLineInput {
  lineKey: string | null;
  accountId: string | null;
  projectId: string | null;
  description: string;
  unit: string | null;
  qty: string;
  rate: string;
  gstPct: string;
}
export interface VendorBillInput {
  entityId: string;
  partyId: string;
  orderId: string | null;
  projectId: string | null;
  billNo: string;
  billDate: string;
  dueDate: string;
  tdsSection: string | null;
  narration: string;
  lines: BillLineInput[];
}

@Injectable()
export class PayableService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly approvals: ApprovalService,
    private readonly ledger: LedgerService,
  ) {}

  onModuleInit() {
    this.approvals.register(PAYMENT_RUN, {
      label: 'Payment run',
      projectScoped: false,
      link: (id) => `/accounts/payment-runs/${id}`,
      decided: async (tx, id, outcome: Outcome, claims, comment) => {
        await tx`UPDATE acc.payment_run SET status = ${outcome === 'approved' ? 'approved' : 'draft'},
            status_reason = ${outcome === 'rejected' ? comment : null}, updated_at = now(), updated_by = ${claims.sub},
            row_version = row_version + 1
          WHERE id = ${id}`;
      },
      summary: async (db, id) => {
        const [r] =
          await db`SELECT number, total::text AS total, to_char(pay_on, 'YYYY-MM-DD') AS "payOn"
          FROM acc.payment_run WHERE id = ${id}`;
        return r ?? null;
      },
      canSee: async (_db, claims) => this.permissions.can(claims, 'accounts.view'),
    });
  }

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          p === 'accounts.view'
            ? 'Payables need the accounts permission.'
            : 'This needs the permission to post.',
      });
  }

  async tolerance(db: Db) {
    const [s] = await db<
      { value: string }[]
    >`SELECT value FROM platform.setting WHERE key = ${TOLERANCE_KEY}`;
    return s ? String(s.value) : '0';
  }
  /** How far a bill's rate may exceed the order's before the bill is held; the admin changes it. */
  async settings(claims: TenantClaims) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return { rateTolerancePct: await this.tolerance(db), mayEdit: claims.role === 'admin' };
  }

  async setTolerance(claims: TenantClaims, pctValue: string) {
    if (claims.role !== 'admin')
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Only an admin sets the tolerance.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db`INSERT INTO platform.setting (key, value) VALUES (${TOLERANCE_KEY}, ${db.json(pctValue)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    return { tolerancePct: pctValue };
  }

  async sections(claims: TenantClaims) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT DISTINCT ON (section) section, label, rate_company::text AS "rateCompany",
        rate_individual::text AS "rateIndividual", rate_no_pan::text AS "rateNoPan",
        single_threshold::text AS "singleThreshold", year_threshold::text AS "yearThreshold",
        to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom"
      FROM acc.tds_section WHERE effective_from <= (now() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY section, effective_from DESC`;
  }

  private async section(db: Db, section: string, on: string): Promise<TdsSection> {
    const [s] = await db<TdsSection[]>`
      SELECT section, rate_company::text AS "rateCompany", rate_individual::text AS "rateIndividual",
        rate_no_pan::text AS "rateNoPan", single_threshold::text AS "singleThreshold",
        year_threshold::text AS "yearThreshold"
      FROM acc.tds_section WHERE section = ${section} AND effective_from <= ${on}
      ORDER BY effective_from DESC LIMIT 1`;
    if (!s)
      throw new BadRequestException({
        code: 'unknown_section',
        message: `No TDS section ${section}.`,
      });
    return s;
  }

  /** A bill's outstanding: payable less runs paid, advances applied and debit notes. */
  /** What is still owed on bill `b`, for queries that alias the bill so. */
  outstandingSql(db: Db) {
    return db`(b.payable
      - coalesce((SELECT sum(l.amount) FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
          WHERE l.bill_id = b.id AND r.status = 'paid'), 0)
      - coalesce((SELECT sum(a.amount) FROM acc.advance_application a WHERE a.bill_id = b.id), 0)
      - coalesce((SELECT sum(d.total) FROM acc.debit_note d WHERE d.bill_id = b.id), 0))`;
  }

  // --- bills ---

  async createBill(claims: TenantClaims, input: VendorBillInput) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const tolerance = await this.tolerance(db);
    const id = await db
      .begin(async (tx) => {
        const [party] = await tx<
          { name: string; gstin: string | null; pan: string | null; tds_section: string | null }[]
        >`
          SELECT name, gstin, pan, tds_section FROM platform.party WHERE id = ${input.partyId} AND deleted_at IS NULL`;
        if (!party) throw new NotFoundException({ code: 'party_not_found' });
        const [company] = await tx<{ state_code: string | null }[]>`
          SELECT state_code FROM platform.entity WHERE id = ${input.entityId}`;
        if (!company) throw new NotFoundException({ code: 'company_not_found' });
        const [dup] = await tx`
          SELECT 1 FROM acc.vendor_bill WHERE entity_id = ${input.entityId} AND party_id = ${input.partyId}
            AND lower(bill_no) = lower(${input.billNo}) AND status <> 'cancelled'`;
        if (dup)
          throw new ConflictException({
            code: 'bill_exists',
            message: `${party.name}'s bill ${input.billNo} is already entered.`,
          });
        if (input.dueDate < input.billDate)
          throw new BadRequestException({
            code: 'due_before_bill',
            message: 'A bill falls due on or after its date.',
          });
        const reasons: string[] = [];
        let supply: 'intra' | 'inter' | 'unregistered';
        let projectId = input.projectId;
        const lines: (BillLineInput & { accountId: string; amount: Dec; gst: Dec })[] = [];
        if (input.orderId) {
          const [o] = await tx<
            {
              party_id: string;
              project_id: string;
              kind: 'purchase' | 'work';
              status: string;
              number: string;
              entity_id: string;
              revision_id: string;
              supply: 'intra' | 'inter' | 'unregistered';
            }[]
          >`
            SELECT o.party_id, o.project_id, o.kind, o.status, o.number, p.entity_id, v.id AS revision_id, v.supply
            FROM proc.purchase_order o JOIN proj.project p ON p.id = o.project_id
            JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
            WHERE o.id = ${input.orderId} FOR UPDATE OF o`;
          if (!o || !['issued', 'acknowledged', 'closed'].includes(o.status))
            throw new BadRequestException({
              code: 'order_not_in_force',
              message: 'Bill an order that is issued.',
            });
          if (o.party_id !== input.partyId || o.entity_id !== input.entityId)
            throw new BadRequestException({
              code: 'not_this_order',
              message: "The order is not this supplier's, in this company.",
            });
          supply = o.supply;
          projectId = o.project_id;
          const role = o.kind === 'work' ? 'subcontract_cost' : 'material_consumption';
          const account = await this.ledger.roleAccount(tx, input.entityId, role);
          for (const [i, l] of input.lines.entries()) {
            const [ol] = await tx<
              { description: string; unit: string; qty: string; rate: string; gst_pct: string }[]
            >`
              SELECT description, unit, qty::text AS qty, rate::text AS rate, gst_pct::text AS gst_pct
              FROM proc.po_line WHERE revision_id = ${o.revision_id} AND line_key = ${l.lineKey}`;
            if (!ol)
              throw new BadRequestException({
                code: 'not_an_order_line',
                message: `Line ${i + 1} is not on ${o.number}.`,
              });
            const [billed] = await tx<{ qty: string }[]>`
              SELECT coalesce(sum(bl.qty), 0)::text AS qty FROM acc.vendor_bill_line bl
              JOIN acc.vendor_bill b ON b.id = bl.bill_id AND b.status <> 'cancelled' WHERE b.order_id = ${input.orderId}
                AND bl.line_key = ${l.lineKey}`;
            const [got] =
              o.kind === 'work'
                ? [{ qty: ol.qty }]
                : await tx<{ qty: string }[]>`
                    SELECT coalesce(sum(g.accepted_qty), 0)::text AS qty FROM proc.grn_line g
                    JOIN proc.goods_receipt r ON r.id = g.receipt_id AND r.status = 'posted'
                    WHERE r.po_id = ${input.orderId} AND g.line_key = ${l.lineKey}`;
            const room = dec(got!.qty) - dec(billed!.qty);
            if (dec(l.qty) > room)
              reasons.push(
                `${ol.description}: ${Number(l.qty)} ${ol.unit} billed, ${o.kind === 'work' ? 'ordered' : 'accepted on receipt'} and not yet billed ${Number(fmt(room, 4))}.`,
              );
            const limit = dec(ol.rate) + pct(dec(ol.rate), tolerance);
            if (dec(l.rate) > limit)
              reasons.push(
                `${ol.description}: billed at ₹${Number(l.rate)}, ordered at ₹${Number(ol.rate)}.`,
              );
            lines.push({
              ...l,
              description: ol.description,
              unit: ol.unit,
              gstPct: ol.gst_pct,
              accountId: account,
              projectId: o.project_id,
              amount: 0n,
              gst: 0n,
            });
          }
        } else {
          supply = !party.gstin
            ? 'unregistered'
            : party.gstin.slice(0, 2) === company.state_code
              ? 'intra'
              : 'inter';
          for (const [i, l] of input.lines.entries()) {
            if (!l.accountId)
              throw new BadRequestException({
                code: 'ledger_needed',
                message: `Line ${i + 1}: choose the ledger.`,
              });
            const [a] = await tx<{ ok: boolean; needs: boolean }[]>`
              SELECT NOT is_group AND closed_at IS NULL AND kind IN ('ordinary', 'tax') AS ok, needs_project AS needs
              FROM acc.account WHERE id = ${l.accountId}`;
            if (!a?.ok)
              throw new BadRequestException({
                code: 'not_a_ledger',
                message: `Line ${i + 1}: choose an open expense ledger.`,
              });
            lines.push({
              ...l,
              accountId: l.accountId,
              projectId: l.projectId ?? projectId,
              amount: 0n,
              gst: 0n,
            });
          }
        }
        // Amounts and GST line by line, as the invoice shows them.
        let [taxable, cgst, sgst, igst] = [0n, 0n, 0n, 0n];
        for (const l of lines) {
          l.amount = r2(mul(dec(l.qty), dec(l.rate)));
          const gstPct = supply === 'unregistered' ? '0' : l.gstPct;
          if (supply === 'intra') {
            const half = r2(mul(l.amount, div(dec(gstPct), dec('200'))));
            cgst += half;
            sgst += half;
            l.gst = half * 2n;
          } else {
            const g = r2(mul(l.amount, div(dec(gstPct), dec('100'))));
            igst += g;
            l.gst = g;
          }
          l.gstPct = gstPct;
          taxable += l.amount;
        }
        const total = taxable + cgst + sgst + igst;
        // TDS: the section given, or the supplier's.
        const sectionName = input.tdsSection ?? party.tds_section;
        let tds = { base: '0.00', rate: '0', tds: '0.00' };
        if (sectionName) {
          const s = await this.section(tx, sectionName, input.billDate);
          const fy = fyOf(input.billDate);
          const [prior] = await tx<{ taxable: string; taxed: string }[]>`
            SELECT coalesce(sum(taxable), 0)::text AS taxable, coalesce(sum(tds_base), 0)::text AS taxed
            FROM acc.vendor_bill WHERE entity_id = ${input.entityId} AND party_id = ${input.partyId}
              AND tds_section = ${sectionName} AND status <> 'cancelled' AND bill_date BETWEEN ${fy.from} AND ${fy.to}`;
          tds = workTds({
            section: s,
            pan: party.pan ?? party.gstin?.slice(2, 12) ?? null,
            taxable: money(taxable),
            priorTaxable: prior!.taxable,
            priorTaxed: prior!.taxed,
          });
        }
        const payable = total - dec(tds.tds);
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO acc.vendor_bill (entity_id, party_id, order_id, project_id, bill_no, bill_date, due_date, supply,
            status, held_reasons, tds_section, tds_rate, tds_base, taxable, cgst, sgst, igst, total, tds, payable, narration,
            created_by, updated_by)
          VALUES (${input.entityId}, ${input.partyId}, ${input.orderId}, ${projectId}, ${input.billNo}, ${input.billDate},
            ${input.dueDate}, ${supply}, 'held', ${tx.json(reasons)}, ${sectionName}, ${tds.rate}, ${tds.base},
            ${money(taxable)}, ${money(cgst)}, ${money(sgst)}, ${money(igst)}, ${money(total)}, ${tds.tds}, ${money(payable)},
            ${input.narration}, ${claims.sub}, ${claims.sub})
          RETURNING id`;
        for (const [i, l] of lines.entries())
          await tx`INSERT INTO acc.vendor_bill_line (bill_id, position, line_key, account_id, project_id, description, unit,
              qty, rate, gst_pct, amount, gst)
            VALUES (${row!.id}, ${i + 1}, ${l.lineKey}, ${l.accountId}, ${l.projectId}, ${l.description}, ${l.unit}, ${l.qty},
              ${l.rate}, ${l.gstPct}, ${money(l.amount)}, ${money(l.gst)})`;
        if (!reasons.length) await this.postBill(tx, claims, row!.id);
        await audit(tx, claims.sub, 'vendor_bill.create', 'vendor_bill', row!.id, {
          held: reasons.length > 0,
        });
        return row!.id;
      })
      .catch(fromDb);
    return this.bill(claims, id);
  }

  /** The purchase voucher: each line's ledger and input tax Dr; the supplier Cr the payable, TDS payable Cr the TDS. */
  private async postBill(tx: TransactionSql, claims: TenantClaims, id: string) {
    const [b] = await tx<
      {
        entity_id: string;
        party_id: string;
        project_id: string | null;
        bill_no: string;
        bill_date: string;
        cgst: string;
        sgst: string;
        igst: string;
        tds: string;
        payable: string;
        tds_section: string | null;
        name: string;
      }[]
    >`
      SELECT b.entity_id, b.party_id, b.project_id, b.bill_no, to_char(b.bill_date, 'YYYY-MM-DD') AS bill_date,
        b.cgst::text, b.sgst::text, b.igst::text, b.tds::text, b.payable::text, b.tds_section, p.name
      FROM acc.vendor_bill b JOIN platform.party p ON p.id = b.party_id WHERE b.id = ${id}`;
    // A line to a ledger whose input tax is blocked (section 17(5) and the like) takes its GST into the expense.
    const items = await tx<
      {
        account_id: string;
        project_id: string | null;
        amount: string;
        gst: string;
        description: string;
        blocked: boolean;
      }[]
    >`
      SELECT l.account_id, l.project_id, l.amount::text, l.gst::text, l.description, a.itc_blocked AS blocked
      FROM acc.vendor_bill_line l JOIN acc.account a ON a.id = l.account_id WHERE l.bill_id = ${id} ORDER BY l.position`;
    let blocked = 0n;
    for (const l of items.filter((x) => x.blocked)) {
      blocked += dec(l.gst);
      l.amount = money(dec(l.amount) + dec(l.gst));
    }
    if (blocked) {
      const igst = dec(b!.igst);
      if (igst) b!.igst = money(igst - blocked);
      else {
        b!.cgst = money(dec(b!.cgst) - blocked / 2n);
        b!.sgst = money(dec(b!.sgst) - blocked / 2n);
      }
      await tx`UPDATE acc.vendor_bill SET itc_blocked = ${money(blocked)} WHERE id = ${id}`;
    }
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
    const role = (r: Parameters<LedgerService['roleAccount']>[2]) =>
      this.ledger.roleAccount(tx, b!.entity_id, r);
    const nz = (v: string) => dec(v) !== 0n;
    const tdsRole = b!.tds_section ? `tds_payable_${b!.tds_section.toLowerCase()}` : null;
    if (tdsRole && nz(b!.tds) && !isRole(tdsRole))
      throw new ConflictException({
        code: 'role_not_mapped',
        message: `No ledger for TDS under ${b!.tds_section}.`,
      });
    const lines: LineInput[] = [
      ...items
        .filter((l) => nz(l.amount))
        .map((l) => line(l.account_id, l.amount, '0', l.project_id, l.description)),
      ...(nz(b!.cgst) ? [line(await role('input_cgst'), b!.cgst, '0', null)] : []),
      ...(nz(b!.sgst) ? [line(await role('input_sgst'), b!.sgst, '0', null)] : []),
      ...(nz(b!.igst) ? [line(await role('input_igst'), b!.igst, '0', null)] : []),
      line(
        await this.ledger.partyLedger(tx, b!.party_id),
        '0',
        b!.payable,
        b!.project_id,
        `Bill ${b!.bill_no}`,
      ),
      ...(nz(b!.tds) && tdsRole
        ? [
            line(
              await role(tdsRole as Parameters<LedgerService['roleAccount']>[2]),
              '0',
              b!.tds,
              null,
              `TDS ${b!.tds_section}`,
            ),
          ]
        : []),
    ];
    const v = await this.ledger.post(
      tx,
      claims,
      {
        entityId: b!.entity_id,
        type: 'purchase',
        date: b!.bill_date,
        narration: `${b!.name} bill ${b!.bill_no}`,
        reference: b!.bill_no,
        lines,
      },
      { kind: 'vendor_bill', id },
    );
    await tx`UPDATE acc.vendor_bill SET status = 'posted', voucher_id = ${v!.id}, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1
      WHERE id = ${id}`;
  }

  async passBill(claims: TenantClaims, id: string, reason: string) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [b] = await tx<
          { status: string }[]
        >`SELECT status FROM acc.vendor_bill WHERE id = ${id} FOR UPDATE`;
        if (!b) throw new NotFoundException({ code: 'bill_not_found' });
        if (b.status !== 'held')
          throw new ConflictException({ code: 'not_held', message: 'Only a held bill is passed.' });
        await tx`UPDATE acc.vendor_bill SET pass_reason = ${reason} WHERE id = ${id}`;
        await this.postBill(tx, claims, id);
        await audit(tx, claims.sub, 'vendor_bill.pass', 'vendor_bill', id, { reason });
      })
      .catch(fromDb);
    return this.bill(claims, id);
  }

  /** A held bill is cancelled outright; a posted one only while nothing has been paid, applied or noted against it. */
  async cancelBill(claims: TenantClaims, id: string, b: { date: string; reason: string }) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [row] = await tx<
          {
            status: string;
            entity_id: string;
            voucher_id: string | null;
            touched: boolean;
            bill_date: string;
            source: string | null;
          }[]
        >`
          SELECT b.status, b.entity_id, b.voucher_id, to_char(b.bill_date, 'YYYY-MM-DD') AS bill_date, b.source,
            EXISTS (SELECT 1 FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
                    WHERE l.bill_id = b.id AND r.status <> 'cancelled')
              OR EXISTS (SELECT 1 FROM acc.advance_application a WHERE a.bill_id = b.id)
              OR EXISTS (SELECT 1 FROM acc.debit_note d WHERE d.bill_id = b.id) AS touched
          FROM acc.vendor_bill b WHERE b.id = ${id} FOR UPDATE OF b`;
        if (!row) throw new NotFoundException({ code: 'bill_not_found' });
        if (row.status === 'cancelled')
          throw new ConflictException({ code: 'cancelled', message: 'Already cancelled.' });
        if (row.source)
          throw new ConflictException({
            code: 'from_subcontract',
            message:
              'This bill comes from a subcontract certificate: correct it with a debit note.',
          });
        if (row.touched)
          throw new ConflictException({
            code: 'bill_in_use',
            message: 'It is in a payment run, or has an advance applied or a debit note.',
          });
        if (row.voucher_id) {
          if (b.date < row.bill_date)
            throw new BadRequestException({
              code: 'before_bill',
              message: 'Cancel on or after the bill date.',
            });
          const [v] = await tx<
            { number: string }[]
          >`SELECT number FROM acc.voucher WHERE id = ${row.voucher_id}`;
          const back = await tx<LineInput[]>`
            SELECT account_id AS "accountId", NULL AS "partyId", credit::text AS debit, debit::text AS credit,
              project_id AS "projectId", site_id AS "siteId", cost_code_id AS "costCodeId", note
            FROM acc.voucher_line WHERE voucher_id = ${row.voucher_id} ORDER BY position`;
          await this.ledger.post(
            tx,
            claims,
            {
              entityId: row.entity_id,
              type: 'purchase',
              date: b.date,
              narration: `Cancelled: ${v!.number}: ${b.reason}`,
              reference: v!.number,
              lines: back,
            },
            { kind: 'vendor_bill', id },
            row.voucher_id,
          );
        }
        await tx`UPDATE acc.vendor_bill SET status = 'cancelled', status_reason = ${b.reason}, updated_at = now(),
            updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${id}`;
        await audit(tx, claims.sub, 'vendor_bill.cancel', 'vendor_bill', id, { reason: b.reason });
      })
      .catch(fromDb);
    return this.bill(claims, id);
  }

  async bill(claims: TenantClaims, id: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const [b] = await db`
      SELECT b.id, b.entity_id AS "entityId", json_build_object('id', p.id, 'name', p.name, 'gstin', p.gstin) AS party,
        CASE WHEN o.id IS NULL THEN NULL ELSE json_build_object('id', o.id, 'number', o.number, 'kind', o.kind) END AS "order",
        CASE WHEN pr.id IS NULL THEN NULL ELSE json_build_object('id', pr.id, 'number', pr.number, 'name', pr.name) END AS project,
        b.bill_no AS "billNo", to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate", to_char(b.due_date, 'YYYY-MM-DD') AS "dueDate",
        b.supply, b.status, b.held_reasons AS "heldReasons", b.pass_reason AS "passReason", b.status_reason AS "statusReason",
        b.tds_section AS "tdsSection", b.tds_rate::text AS "tdsRate", b.tds_base::text AS "tdsBase", b.taxable::text AS taxable,
        b.cgst::text AS cgst, b.sgst::text AS sgst, b.igst::text AS igst, b.total::text AS total, b.tds::text AS tds,
        b.payable::text AS payable, ${this.outstandingSql(db)}::text AS outstanding, b.narration, b.source,
        b.itc_blocked::text AS "itcBlocked",
        (SELECT json_build_object('id', v.id, 'number', v.number) FROM acc.voucher v WHERE v.id = b.voucher_id) AS voucher,
        coalesce((SELECT json_agg(json_build_object('position', l.position, 'lineKey', l.line_key, 'description', l.description,
          'unit', l.unit, 'qty', l.qty::text, 'rate', l.rate::text, 'gstPct', l.gst_pct::text, 'amount', l.amount::text,
          'gst', l.gst::text, 'account', json_build_object('code', a.code, 'name', a.name)) ORDER BY l.position)
          FROM acc.vendor_bill_line l JOIN acc.account a ON a.id = l.account_id WHERE l.bill_id = b.id), '[]') AS lines,
        coalesce((SELECT json_agg(json_build_object('id', d.id, 'date', to_char(d.note_date, 'YYYY-MM-DD'), 'reason', d.reason,
          'total', d.total::text) ORDER BY d.created_at) FROM acc.debit_note d WHERE d.bill_id = b.id), '[]') AS "debitNotes",
        coalesce((SELECT json_agg(json_build_object('run', r.number, 'runId', r.id, 'paidOn', to_char(r.paid_on, 'YYYY-MM-DD'),
          'amount', l.amount::text) ORDER BY r.paid_on) FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
          WHERE l.bill_id = b.id AND r.status = 'paid'), '[]') AS payments,
        coalesce((SELECT json_agg(json_build_object('date', to_char(a.applied_on, 'YYYY-MM-DD'), 'amount', a.amount::text)
          ORDER BY a.applied_on) FROM acc.advance_application a WHERE a.bill_id = b.id), '[]') AS "advancesApplied"
      FROM acc.vendor_bill b JOIN platform.party p ON p.id = b.party_id
      LEFT JOIN proc.purchase_order o ON o.id = b.order_id LEFT JOIN proj.project pr ON pr.id = b.project_id
      WHERE b.id = ${id}`;
    if (!b) throw new NotFoundException({ code: 'bill_not_found' });
    const mayPost = await this.permissions.can(claims, 'accounts.post');
    return {
      ...b,
      mayPass: mayPost && b.status === 'held',
      mayCancel: mayPost && b.status !== 'cancelled' && !b.source,
    };
  }

  async bills(claims: TenantClaims, q: { entityId: string; partyId?: string; status?: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT b.id, p.name AS party, b.bill_no AS "billNo", to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
        to_char(b.due_date, 'YYYY-MM-DD') AS "dueDate", b.status, b.total::text AS total, b.tds::text AS tds,
        b.payable::text AS payable, ${this.outstandingSql(db)}::text AS outstanding, o.number AS "order"
      FROM acc.vendor_bill b JOIN platform.party p ON p.id = b.party_id LEFT JOIN proc.purchase_order o ON o.id = b.order_id
      WHERE b.entity_id = ${q.entityId} ${q.partyId ? db`AND b.party_id = ${q.partyId}` : db``}
        ${q.status ? db`AND b.status = ${q.status}` : db``}
      ORDER BY b.bill_date DESC, b.created_at DESC LIMIT 500`;
  }

  // --- debit notes and advances ---

  async debitNote(
    claims: TenantClaims,
    billId: string,
    input: { date: string; reason: string; taxable: string; gstPct: string },
    /** What the note came from, when proposed from the stores and the order (step 8a.5). */
    source: { kind: 'short' | 'rate'; lineKey: string; qty: string } | null = null,
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [b] = await tx<
          {
            status: string;
            entity_id: string;
            party_id: string;
            supply: string;
            outstanding: string;
            bill_no: string;
            project_id: string | null;
            bill_date: string;
          }[]
        >`
          SELECT b.status, b.entity_id, b.party_id, b.supply, b.bill_no, b.project_id, to_char(b.bill_date, 'YYYY-MM-DD') AS bill_date,
            ${this.outstandingSql(tx)}::text AS outstanding
          FROM acc.vendor_bill b WHERE b.id = ${billId} FOR UPDATE OF b`;
        if (!b || b.status !== 'posted')
          throw new ConflictException({
            code: 'not_posted',
            message: 'A debit note goes against a posted bill.',
          });
        if (input.date < b.bill_date)
          throw new BadRequestException({ code: 'before_bill', message: 'Not before the bill.' });
        const taxable = dec(input.taxable);
        const gstPct = b.supply === 'unregistered' ? '0' : input.gstPct;
        const [cgst, sgst, igst] =
          b.supply === 'intra'
            ? [
                r2(mul(taxable, div(dec(gstPct), dec('200')))),
                r2(mul(taxable, div(dec(gstPct), dec('200')))),
                0n,
              ]
            : [0n, 0n, r2(mul(taxable, div(dec(gstPct), dec('100'))))];
        const total = taxable + cgst + sgst + igst;
        if (total > dec(b.outstanding))
          throw new BadRequestException({
            code: 'over_outstanding',
            message: `₹${money(total)} is more than the ₹${b.outstanding} outstanding.`,
          });
        const [first] = await tx<{ account_id: string; project_id: string | null }[]>`
          SELECT account_id, project_id FROM acc.vendor_bill_line WHERE bill_id = ${billId} ORDER BY position LIMIT 1`;
        const line = (
          accountId: string,
          debit: string,
          credit: string,
          projectId: string | null,
        ): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId,
          siteId: null,
          costCodeId: null,
          note: input.reason,
        });
        const role = (r: Parameters<LedgerService['roleAccount']>[2]) =>
          this.ledger.roleAccount(tx, b.entity_id, r);
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: b.entity_id,
            type: 'debit_note',
            date: input.date,
            narration: `Against bill ${b.bill_no}: ${input.reason}`,
            reference: b.bill_no,
            lines: [
              line(await this.ledger.partyLedger(tx, b.party_id), money(total), '0', b.project_id),
              line(first!.account_id, '0', money(taxable), first!.project_id),
              ...(cgst ? [line(await role('input_cgst'), '0', money(cgst), null)] : []),
              ...(sgst ? [line(await role('input_sgst'), '0', money(sgst), null)] : []),
              ...(igst ? [line(await role('input_igst'), '0', money(igst), null)] : []),
            ],
          },
          { kind: 'debit_note', id: billId },
        );
        await tx`INSERT INTO acc.debit_note (entity_id, bill_id, note_date, reason, taxable, gst_pct, cgst, sgst, igst, total,
            voucher_id, created_by, source_kind, source_line_key, source_qty)
          VALUES (${b.entity_id}, ${billId}, ${input.date}, ${input.reason}, ${money(taxable)}, ${gstPct}, ${money(cgst)},
            ${money(sgst)}, ${money(igst)}, ${money(total)}, ${v!.id}, ${claims.sub}, ${source?.kind ?? null},
            ${source?.lineKey ?? null}, ${source?.qty ?? null})`;
      })
      .catch(fromDb);
    return this.bill(claims, billId);
  }

  /** What a supplier has been paid in advance and not yet applied. */
  async advanceLeft(db: Db, entityId: string, partyId: string) {
    const [a] = await db<{ left: string }[]>`
      SELECT (coalesce((SELECT sum(l.amount) FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
          WHERE r.entity_id = ${entityId} AND r.status = 'paid' AND l.party_id = ${partyId} AND l.kind = 'advance'), 0)
        - coalesce((SELECT sum(amount) FROM acc.advance_application WHERE entity_id = ${entityId} AND party_id = ${partyId}),
          0))::text AS left`;
    return dec(a!.left);
  }

  async applyAdvance(
    claims: TenantClaims,
    billId: string,
    input: { date: string; amount: string },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [b] = await tx<
          {
            status: string;
            entity_id: string;
            party_id: string;
            outstanding: string;
            bill_no: string;
            project_id: string | null;
          }[]
        >`
          SELECT b.status, b.entity_id, b.party_id, b.bill_no, b.project_id, ${this.outstandingSql(tx)}::text AS outstanding
          FROM acc.vendor_bill b WHERE b.id = ${billId} FOR UPDATE OF b`;
        if (!b || b.status !== 'posted')
          throw new ConflictException({
            code: 'not_posted',
            message: 'Apply an advance to a posted bill.',
          });
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'advance ' + b.party_id}))`;
        const amount = dec(input.amount);
        const left = await this.advanceLeft(tx, b.entity_id, b.party_id);
        if (amount > left)
          throw new BadRequestException({
            code: 'over_advance',
            message: `₹${money(left)} of advance is left.`,
          });
        if (amount > dec(b.outstanding))
          throw new BadRequestException({
            code: 'over_outstanding',
            message: `The bill has ₹${b.outstanding} outstanding.`,
          });
        const line = (accountId: string, debit: string, credit: string): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId: b.project_id,
          siteId: null,
          costCodeId: null,
          note: `Advance against bill ${b.bill_no}`,
        });
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: b.entity_id,
            type: 'journal',
            date: input.date,
            narration: `Advance applied to bill ${b.bill_no}`,
            reference: b.bill_no,
            lines: [
              line(await this.ledger.partyLedger(tx, b.party_id), money(amount), '0'),
              line(
                await this.ledger.roleAccount(tx, b.entity_id, 'advance_to_suppliers'),
                '0',
                money(amount),
              ),
            ],
          },
          { kind: 'advance_application', id: billId },
        );
        await tx`INSERT INTO acc.advance_application (entity_id, party_id, bill_id, applied_on, amount, voucher_id, created_by)
          VALUES (${b.entity_id}, ${b.party_id}, ${billId}, ${input.date}, ${money(amount)}, ${v!.id}, ${claims.sub})`;
      })
      .catch(fromDb);
    return this.bill(claims, billId);
  }

  // --- payment runs ---

  async createRun(
    claims: TenantClaims,
    input: {
      entityId: string;
      bankAccountId: string;
      payOn: string;
      lines: {
        partyId: string;
        kind: 'bill' | 'advance';
        billId: string | null;
        projectId: string | null;
        amount: string;
      }[];
    },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        const [bank] = await tx<
          { kind: string }[]
        >`SELECT kind FROM acc.account WHERE id = ${input.bankAccountId}`;
        if (bank?.kind !== 'bank')
          throw new BadRequestException({
            code: 'not_bank',
            message: 'A payment run pays from a bank ledger.',
          });
        let total = 0n;
        for (const [i, l] of input.lines.entries()) {
          if (l.kind === 'bill') {
            const [b] = await tx<
              {
                status: string;
                party_id: string;
                entity_id: string;
                outstanding: string;
                in_runs: string;
                bill_no: string;
              }[]
            >`
              SELECT b.status, b.party_id, b.entity_id, b.bill_no, ${this.outstandingSql(tx)}::text AS outstanding,
                coalesce((SELECT sum(l.amount) FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
                  WHERE l.bill_id = b.id AND r.status IN ('draft', 'pending', 'approved')), 0)::text AS in_runs
              FROM acc.vendor_bill b WHERE b.id = ${l.billId} FOR UPDATE OF b`;
            if (
              !b ||
              b.status !== 'posted' ||
              b.entity_id !== input.entityId ||
              b.party_id !== l.partyId
            )
              throw new BadRequestException({
                code: 'bad_line',
                message: `Line ${i + 1}: not a posted bill of this supplier and company.`,
              });
            const room = dec(b.outstanding) - dec(b.in_runs);
            if (dec(l.amount) > room)
              throw new BadRequestException({
                code: 'over_outstanding',
                message: `Bill ${b.bill_no}: ₹${money(room)} can still be paid.`,
              });
          } else if (!l.projectId)
            throw new BadRequestException({
              code: 'project_needed',
              message: `Line ${i + 1}: an advance names its project.`,
            });
          total += dec(l.amount);
        }
        const number = await nextNumber(
          tx,
          'payment_run',
          input.entityId,
          'PR',
          new Date(`${input.payOn}T00:00:00Z`),
        );
        const [r] = await tx<{ id: string }[]>`
          INSERT INTO acc.payment_run (entity_id, number, bank_account_id, pay_on, total, created_by, updated_by)
          VALUES (${input.entityId}, ${number}, ${input.bankAccountId}, ${input.payOn}, ${money(total)}, ${claims.sub}, ${claims.sub})
          RETURNING id`;
        for (const [i, l] of input.lines.entries())
          await tx`INSERT INTO acc.payment_run_line (run_id, position, party_id, kind, bill_id, project_id, amount)
            VALUES (${r!.id}, ${i + 1}, ${l.partyId}, ${l.kind}, ${l.billId}, ${l.kind === 'advance' ? l.projectId : null}, ${l.amount})`;
        return r!.id;
      })
      .catch(fromDb);
    return this.run(claims, id);
  }

  async submitRun(claims: TenantClaims, id: string) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [r] = await tx<{ status: string; number: string; total: string }[]>`
        SELECT status, number, total::text AS total FROM acc.payment_run WHERE id = ${id} FOR UPDATE`;
      if (!r) throw new NotFoundException({ code: 'run_not_found' });
      if (r.status !== 'draft')
        throw new ConflictException({
          code: 'not_draft',
          message: 'Only a draft run is submitted.',
        });
      const res = await this.approvals.submit(tx, claims, {
        docType: PAYMENT_RUN,
        docId: id,
        projectId: null,
        title: r.number,
        amount: r.total,
      });
      await tx`UPDATE acc.payment_run SET status = ${res.status === 'approved' ? 'approved' : 'pending'}, status_reason = NULL,
          updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${id}`;
    });
    return this.run(claims, id);
  }

  async cancelRun(claims: TenantClaims, id: string, reason: string) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [r] = await tx<
        { status: string }[]
      >`SELECT status FROM acc.payment_run WHERE id = ${id} FOR UPDATE`;
      if (!r) throw new NotFoundException({ code: 'run_not_found' });
      if (r.status === 'paid' || r.status === 'cancelled')
        throw new ConflictException({
          code: 'run_closed',
          message: 'A paid or cancelled run stays as it is.',
        });
      await this.approvals.withdrawFor(tx, claims, PAYMENT_RUN, id);
      await tx`UPDATE acc.payment_run SET status = 'cancelled', status_reason = ${reason}, updated_at = now(),
          updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${id}`;
    });
    return this.run(claims, id);
  }

  /** Paid: one payment voucher per supplier (the supplier or advances to suppliers Dr; the bank Cr). */
  async markPaid(claims: TenantClaims, id: string, paidOn: string) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [r] = await tx<
          {
            status: string;
            entity_id: string;
            bank_account_id: string;
            number: string;
            pay_on: string;
          }[]
        >`
          SELECT status, entity_id, bank_account_id, number, to_char(pay_on, 'YYYY-MM-DD') AS pay_on
          FROM acc.payment_run WHERE id = ${id} FOR UPDATE`;
        if (!r) throw new NotFoundException({ code: 'run_not_found' });
        if (r.status !== 'approved')
          throw new ConflictException({
            code: 'not_approved',
            message: 'Only an approved run is paid.',
          });
        const lines = await tx<
          {
            position: number;
            party_id: string;
            kind: string;
            amount: string;
            project_id: string | null;
            bill_project: string | null;
            bill_no: string | null;
            name: string;
          }[]
        >`
          SELECT l.position, l.party_id, l.kind, l.amount::text AS amount, l.project_id, b.project_id AS bill_project,
            b.bill_no, p.name
          FROM acc.payment_run_line l JOIN platform.party p ON p.id = l.party_id LEFT JOIN acc.vendor_bill b ON b.id = l.bill_id
          WHERE l.run_id = ${id} ORDER BY l.position`;
        const parties = [...new Set(lines.map((l) => l.party_id))];
        for (const party of parties) {
          const mine = lines.filter((l) => l.party_id === party);
          const total = mine.reduce((s, l) => s + dec(l.amount), 0n);
          const entries: LineInput[] = [];
          for (const l of mine)
            entries.push({
              accountId:
                l.kind === 'bill'
                  ? await this.ledger.partyLedger(tx, party)
                  : await this.ledger.roleAccount(tx, r.entity_id, 'advance_to_suppliers'),
              partyId: null,
              debit: l.amount,
              credit: '0',
              projectId: l.kind === 'bill' ? l.bill_project : l.project_id,
              siteId: null,
              costCodeId: null,
              note: l.kind === 'bill' ? `Bill ${l.bill_no}` : 'Advance',
            });
          entries.push({
            accountId: r.bank_account_id,
            partyId: null,
            debit: '0',
            credit: money(total),
            projectId: null,
            siteId: null,
            costCodeId: null,
            note: '',
          });
          const v = await this.ledger.post(
            tx,
            claims,
            {
              entityId: r.entity_id,
              type: 'payment',
              date: paidOn,
              narration: `${mine[0]!.name}, ${r.number}`,
              reference: r.number,
              lines: entries,
            },
            { kind: 'payment_run', id },
          );
          await tx`UPDATE acc.payment_run_line SET voucher_id = ${v!.id} WHERE run_id = ${id} AND party_id = ${party}`;
        }
        await tx`UPDATE acc.payment_run SET status = 'paid', paid_on = ${paidOn}, updated_at = now(), updated_by = ${claims.sub},
            row_version = row_version + 1 WHERE id = ${id}`;
        await audit(tx, claims.sub, 'payment_run.paid', 'payment_run', id, { paidOn });
      })
      .catch(fromDb);
    return this.run(claims, id);
  }

  async run(claims: TenantClaims, id: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await db<RunHead[]>`
      SELECT r.id, r.entity_id AS "entityId", e.name AS company, r.number, to_char(r.pay_on, 'YYYY-MM-DD') AS "payOn",
        to_char(r.paid_on, 'YYYY-MM-DD') AS "paidOn", r.status, r.status_reason AS "statusReason", r.total::text AS total,
        json_build_object('id', a.id, 'code', a.code, 'name', a.name) AS bank,
        coalesce((SELECT json_agg(json_build_object('position', l.position, 'kind', l.kind, 'amount', l.amount::text,
          'party', json_build_object('id', p.id, 'name', p.name, 'accountNo', p.bank_account_no, 'ifsc', p.bank_ifsc,
            'accountName', p.bank_account_name),
          'bill', CASE WHEN b.id IS NULL THEN NULL ELSE json_build_object('id', b.id, 'billNo', b.bill_no,
            'billDate', to_char(b.bill_date, 'YYYY-MM-DD'), 'total', b.total::text, 'tds', b.tds::text) END,
          'project', CASE WHEN pr.id IS NULL THEN NULL ELSE json_build_object('number', pr.number, 'name', pr.name) END,
          'voucher', (SELECT json_build_object('id', v.id, 'number', v.number) FROM acc.voucher v WHERE v.id = l.voucher_id))
          ORDER BY l.position)
          FROM acc.payment_run_line l JOIN platform.party p ON p.id = l.party_id LEFT JOIN acc.vendor_bill b ON b.id = l.bill_id
          LEFT JOIN proj.project pr ON pr.id = l.project_id WHERE l.run_id = r.id), '[]') AS lines
      FROM acc.payment_run r JOIN platform.entity e ON e.id = r.entity_id JOIN acc.account a ON a.id = r.bank_account_id
      WHERE r.id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'run_not_found' });
    const mayPost = await this.permissions.can(claims, 'accounts.post');
    return {
      ...r,
      approval: await this.approvals.latestFor(db, claims, PAYMENT_RUN, id),
      maySubmit: mayPost && r.status === 'draft',
      mayPay: mayPost && r.status === 'approved',
      mayCancel: mayPost && ['draft', 'pending', 'approved'].includes(r.status),
    };
  }

  async runs(claims: TenantClaims, entityId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT r.id, r.number, to_char(r.pay_on, 'YYYY-MM-DD') AS "payOn", r.status, r.total::text AS total,
        (SELECT count(DISTINCT party_id)::int FROM acc.payment_run_line WHERE run_id = r.id) AS suppliers
      FROM acc.payment_run r WHERE r.entity_id = ${entityId} ORDER BY r.created_at DESC LIMIT 200`;
  }

  /** The bank's bulk upload as CSV: one row per supplier. Refused while a supplier lacks bank details. */
  async bankFile(claims: TenantClaims, id: string) {
    const r = await this.run(claims, id);
    if (r.status !== 'approved' && r.status !== 'paid')
      throw new ConflictException({
        code: 'not_approved',
        message: 'The bank file is for an approved run.',
      });
    type L = {
      amount: string;
      party: {
        id: string;
        name: string;
        accountNo: string | null;
        ifsc: string | null;
        accountName: string | null;
      };
    };
    const by = new Map<string, { party: L['party']; amount: Dec }>();
    for (const l of r.lines as L[]) {
      const x = by.get(l.party.id) ?? { party: l.party, amount: 0n };
      x.amount += dec(l.amount);
      by.set(l.party.id, x);
    }
    const missing = [...by.values()]
      .filter((x) => !x.party.accountNo || !x.party.ifsc)
      .map((x) => x.party.name);
    if (missing.length)
      throw new ConflictException({
        code: 'bank_details_missing',
        message: `Add the bank account of ${missing.join(', ')}.`,
      });
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = [
      ['Beneficiary name', 'Account number', 'IFSC', 'Amount', 'Payment date', 'Reference'],
      ...[...by.values()].map((x) => [
        x.party.accountName || x.party.name,
        x.party.accountNo!,
        x.party.ifsc!,
        money(x.amount),
        r.payOn,
        r.number,
      ]),
    ];
    return {
      fileName: `${r.number.replace(/\//g, '-')}.csv`,
      csv: rows.map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n',
    };
  }

  // --- payables ---

  async payables(claims: TenantClaims, q: { entityId: string; asOf: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const bills = await db<
      {
        id: string;
        party: { id: string; name: string };
        billNo: string;
        billDate: string;
        dueDate: string;
        payable: string;
        outstanding: string;
      }[]
    >`
      SELECT b.id, json_build_object('id', p.id, 'name', p.name) AS party, b.bill_no AS "billNo",
        to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate", to_char(b.due_date, 'YYYY-MM-DD') AS "dueDate", b.payable::text AS payable,
        (b.payable
          - coalesce((SELECT sum(l.amount) FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
              WHERE l.bill_id = b.id AND r.status = 'paid' AND r.paid_on <= ${q.asOf}), 0)
          - coalesce((SELECT sum(a.amount) FROM acc.advance_application a WHERE a.bill_id = b.id AND a.applied_on <= ${q.asOf}), 0)
          - coalesce((SELECT sum(d.total) FROM acc.debit_note d WHERE d.bill_id = b.id AND d.note_date <= ${q.asOf}), 0))::text
          AS outstanding
      FROM acc.vendor_bill b JOIN platform.party p ON p.id = b.party_id
      WHERE b.entity_id = ${q.entityId} AND b.status = 'posted' AND b.bill_date <= ${q.asOf}
      ORDER BY p.name, b.due_date`;
    const open = bills
      .filter((b) => dec(b.outstanding) !== 0n)
      .map((b) => {
        const overdue = days(b.dueDate, q.asOf);
        const i = overdue <= 0 ? 0 : overdue <= 30 ? 1 : overdue <= 60 ? 2 : overdue <= 90 ? 3 : 4;
        return { ...b, overdueDays: Math.max(overdue, 0), bucket: PAY_BUCKETS[i]!, i };
      });
    const advances = await db<
      { party: { id: string; name: string }; paid: string; applied: string }[]
    >`
      SELECT json_build_object('id', p.id, 'name', p.name) AS party,
        coalesce(sum(l.amount), 0)::text AS paid,
        coalesce((SELECT sum(a.amount) FROM acc.advance_application a WHERE a.entity_id = ${q.entityId}
          AND a.party_id = p.id AND a.applied_on <= ${q.asOf}), 0)::text AS applied
      FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id JOIN platform.party p ON p.id = l.party_id
      WHERE r.entity_id = ${q.entityId} AND r.status = 'paid' AND r.paid_on <= ${q.asOf} AND l.kind = 'advance'
      GROUP BY p.id, p.name`;
    const suppliers = new Map<
      string,
      { party: { id: string; name: string }; buckets: Dec[]; outstanding: Dec; advance: Dec }
    >();
    const of = (party: { id: string; name: string }) => {
      const s = suppliers.get(party.id) ?? {
        party,
        buckets: PAY_BUCKETS.map(() => 0n),
        outstanding: 0n,
        advance: 0n,
      };
      suppliers.set(party.id, s);
      return s;
    };
    for (const b of open) {
      const s = of(b.party);
      s.buckets[b.i]! += dec(b.outstanding);
      s.outstanding += dec(b.outstanding);
    }
    for (const a of advances) {
      const left = dec(a.paid) - dec(a.applied);
      if (left !== 0n) of(a.party).advance += left;
    }
    const list = [...suppliers.values()].sort((a, b) => a.party.name.localeCompare(b.party.name));
    return {
      asOf: q.asOf,
      buckets: PAY_BUCKETS,
      suppliers: list.map((s) => ({
        party: s.party,
        buckets: s.buckets.map(money),
        outstanding: money(s.outstanding),
        advance: money(s.advance),
      })),
      bills: open.map(({ i: _i, ...b }) => b),
      total: money(list.reduce((s, x) => s + x.outstanding, 0n)),
    };
  }
}
