// Subcontract bills (docs/wave3-plan.md step 5): a work order's measurement book; running account bills to the
// subcontractor up to a date less what the last certified bill certified, with retention, advance recovery,
// back-charges, labour cess and TDS; certified under the approval rules, which makes each a supplier's bill in payables;
// retention released at the end.
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
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, div, fmt, mul, type Dec } from '../rates/decimal.js';
import { audit } from '../tender/tender-records.js';
import { fromDb, fyOf, isRole, type Role } from './accounts-rules.js';
import { LedgerService, type LineInput } from './ledger.service.js';
import { PayableService } from './payable.service.js';
import { workTds, type TdsSection } from './tds.js';

type Db = Sql | TransactionSql;
export const SUBCONTRACT_BILL = 'subcontract_bill';
const money = (v: Dec) => fmt(v, 2);
const r2 = (v: Dec) => dec(fmt(v, 2));
const pct = (a: Dec, p: string) => r2(mul(a, div(dec(p), dec('100'))));
const min = (...v: Dec[]) => v.reduce((a, b) => (b < a ? b : a));

export interface SubcontractTerms {
  retentionPct: string;
  retentionCap: string | null;
  advanceRecoveryPct: string;
  labourCessPct: string;
  tdsSection: string | null;
}
const DEFAULT_TERMS: SubcontractTerms = {
  retentionPct: '0',
  retentionCap: null,
  advanceRecoveryPct: '0',
  labourCessPct: '1',
  tdsSection: '194C',
};
export interface SubcontractFigures {
  gross: string;
  cgst: string;
  sgst: string;
  igst: string;
  total: string;
  retention: string;
  advance: string;
  backcharges: string;
  cess: string;
  tdsSection: string | null;
  tdsRate: string;
  tdsBase: string;
  tds: string;
  /** What the supplier's bill carries: the invoice less TDS, retention, back-charges and cess. */
  payable: string;
  /** What is left to pay once the advance is recovered. */
  net: string;
}
export interface BackchargeInput {
  description: string;
  amount: string;
  accountId: string;
}

interface Order {
  id: string;
  number: string;
  kind: 'purchase' | 'work';
  status: string;
  project_id: string;
  entity_id: string;
  party_id: string;
  party: string;
  pan: string | null;
  gstin: string | null;
  revision_id: string;
  supply: 'intra' | 'inter' | 'unregistered';
}
interface BillRow {
  id: string;
  order_id: string;
  ra_no: number;
  upto: string;
  status: 'draft' | 'pending' | 'certified' | 'cancelled';
  terms: SubcontractTerms;
  row_version: number;
}
export interface LineRow {
  lineKey: string;
  position: number;
  description: string;
  unit: string;
  rate: string;
  gstPct: string;
  prevQty: string;
  measuredQty: string;
  cumQty: string;
}

@Injectable()
export class SubcontractService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
    private readonly approvals: ApprovalService,
    private readonly ledger: LedgerService,
    private readonly payables: PayableService,
  ) {}

  onModuleInit() {
    this.approvals.register(SUBCONTRACT_BILL, {
      label: 'Subcontract bill',
      projectScoped: true,
      link: (id) => `/subcontract-bills/${id}`,
      decided: (tx, id, outcome, claims, comment) => this.decided(tx, id, outcome, claims, comment),
      summary: async (db, id) => {
        const [b] = await db`
          SELECT b.ra_no AS "raNo", o.number AS "order", p.name AS party, b.figures
          FROM acc.subcontract_bill b JOIN proc.purchase_order o ON o.id = b.order_id
          JOIN platform.party p ON p.id = o.party_id WHERE b.id = ${id}`;
        return b ?? null;
      },
      canSee: async (db, claims, id) => {
        const [b] = await db<{ project_id: string }[]>`
          SELECT o.project_id FROM acc.subcontract_bill b JOIN proc.purchase_order o ON o.id = b.order_id
          WHERE b.id = ${id}`;
        if (!b) return false;
        return this.projects.access(db, claims, b.project_id).then(
          () => true,
          () => false,
        );
      },
    });
  }

  /** The project's team sees its subcontract bills; its leads and members with billing.edit measure and bill. */
  private async access(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    return (
      (a.canEdit || a.role === 'lead' || a.role === 'member') &&
      (await this.permissions.can(claims, 'billing.edit'))
    );
  }
  private async mustBill(db: Db, claims: TenantClaims, projectId: string) {
    if (!(await this.access(db, claims, projectId)))
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Subcontract bills are made by the project's team with the billing permission.",
      });
  }

  private async order(db: Db, orderId: string): Promise<Order> {
    const [o] = await db<Order[]>`
      SELECT o.id, o.number, o.kind, o.status, o.project_id, p.entity_id, o.party_id, y.name AS party, y.pan, y.gstin,
        v.id AS revision_id, coalesce(v.supply, 'intra') AS supply
      FROM proc.purchase_order o JOIN proj.project p ON p.id = o.project_id JOIN platform.party y ON y.id = o.party_id
      JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
      WHERE o.id = ${orderId}`;
    if (!o || o.kind !== 'work')
      throw new NotFoundException({ code: 'order_not_found', message: 'No such work order.' });
    return o;
  }
  private inForce(o: Order) {
    if (!['issued', 'acknowledged'].includes(o.status))
      throw new ConflictException({
        code: 'order_not_in_force',
        message: `${o.number} is not issued.`,
      });
  }

  // --- terms ---

  private async termsOf(db: Db, orderId: string) {
    const [t] = await db<(SubcontractTerms & { rowVersion: number })[]>`
      SELECT retention_pct::text AS "retentionPct", retention_cap::text AS "retentionCap",
        advance_recovery_pct::text AS "advanceRecoveryPct", labour_cess_pct::text AS "labourCessPct",
        tds_section AS "tdsSection", row_version AS "rowVersion"
      FROM acc.subcontract_terms WHERE order_id = ${orderId}`;
    return t ?? { ...DEFAULT_TERMS, rowVersion: null };
  }

  async setTerms(claims: TenantClaims, orderId: string, input: SubcontractTerms) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const o = await this.order(tx, orderId);
      await this.mustBill(tx, claims, o.project_id);
      await tx`
        INSERT INTO acc.subcontract_terms (order_id, retention_pct, retention_cap, advance_recovery_pct, labour_cess_pct,
          tds_section, updated_by)
        VALUES (${orderId}, ${input.retentionPct}, ${input.retentionCap}, ${input.advanceRecoveryPct},
          ${input.labourCessPct}, ${input.tdsSection}, ${claims.sub})
        ON CONFLICT (order_id) DO UPDATE SET retention_pct = EXCLUDED.retention_pct,
          retention_cap = EXCLUDED.retention_cap, advance_recovery_pct = EXCLUDED.advance_recovery_pct,
          labour_cess_pct = EXCLUDED.labour_cess_pct, tds_section = EXCLUDED.tds_section, updated_at = now(),
          updated_by = EXCLUDED.updated_by, row_version = acc.subcontract_terms.row_version + 1`;
      await audit(tx, claims.sub, 'subcontract.terms', 'purchase_order', orderId, { ...input });
    });
    return this.workOrder(claims, orderId);
  }

  // --- the measurement book ---

  /** The order's lines: what was ordered, measured in the book so far, and certified by the last certified bill. */
  private async orderLines(db: Db, o: Order, upto: string | null) {
    return db<
      {
        lineKey: string;
        position: number;
        description: string;
        unit: string;
        qty: string;
        rate: string;
        gstPct: string;
        measured: string;
        certified: string;
      }[]
    >`
      SELECT l.line_key AS "lineKey", l.position, l.description, l.unit, l.qty::text AS qty, l.rate::text AS rate,
        l.gst_pct::text AS "gstPct",
        coalesce((SELECT sum(m.qty) FROM acc.wo_measurement m WHERE m.order_id = ${o.id} AND m.line_key = l.line_key
          ${upto ? db`AND m.measured_on <= ${upto}` : db``}), 0)::text AS measured,
        coalesce((SELECT bl.cum_qty FROM acc.subcontract_bill_line bl JOIN acc.subcontract_bill b ON b.id = bl.bill_id
          WHERE b.order_id = ${o.id} AND b.status = 'certified' AND bl.line_key = l.line_key
          ORDER BY b.ra_no DESC LIMIT 1), 0)::text AS certified
      FROM proc.po_line l WHERE l.revision_id = ${o.revision_id} ORDER BY l.position`;
  }

  async measure(
    claims: TenantClaims,
    orderId: string,
    input: { lineKey: string; measuredOn: string; qty: string; description: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const o = await this.order(tx, orderId);
        await this.mustBill(tx, claims, o.project_id);
        this.inForce(o);
        await this.book(tx, claims, o, { ...input, reverses: null });
      })
      .catch(fromDb);
    return this.workOrder(claims, orderId);
  }

  /** A book entry is never changed: a mistake is taken out by an entry the other way. */
  async reverseMeasurement(
    claims: TenantClaims,
    entryId: string,
    input: { date: string; reason: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const orderId = await db
      .begin(async (tx) => {
        const [m] = await tx<
          {
            order_id: string;
            line_key: string;
            qty: string;
            measured_on: string;
            reversed: boolean;
          }[]
        >`
          SELECT order_id, line_key, qty::text AS qty, to_char(measured_on, 'YYYY-MM-DD') AS measured_on,
            reverses IS NOT NULL OR EXISTS (SELECT 1 FROM acc.wo_measurement r WHERE r.reverses = m.id) AS reversed
          FROM acc.wo_measurement m WHERE m.id = ${entryId}`;
        if (!m) throw new NotFoundException({ code: 'entry_not_found' });
        if (m.reversed)
          throw new ConflictException({
            code: 'already_reversed',
            message: 'This entry is a reversal or has been reversed.',
          });
        if (input.date < m.measured_on)
          throw new BadRequestException({
            code: 'before_entry',
            message: 'Reverse on or after the entry.',
          });
        const o = await this.order(tx, m.order_id);
        await this.mustBill(tx, claims, o.project_id);
        await this.book(tx, claims, o, {
          lineKey: m.line_key,
          measuredOn: input.date,
          qty: fmt(-dec(m.qty), 4),
          description: `Reversed: ${input.reason}`,
          reverses: entryId,
        });
        return m.order_id;
      })
      .catch(fromDb);
    return this.workOrder(claims, orderId);
  }

  private async book(
    tx: TransactionSql,
    claims: TenantClaims,
    o: Order,
    e: {
      lineKey: string;
      measuredOn: string;
      qty: string;
      description: string;
      reverses: string | null;
    },
  ) {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'wo-book ' + o.id}))`;
    const [today] = await tx<{ d: string }[]>`SELECT to_char(current_date, 'YYYY-MM-DD') AS d`;
    if (e.measuredOn > today!.d)
      throw new BadRequestException({
        code: 'measured_in_future',
        message: 'Measure work that is done.',
      });
    const line = (await this.orderLines(tx, o, null)).find((l) => l.lineKey === e.lineKey);
    if (!line)
      throw new BadRequestException({
        code: 'not_an_order_line',
        message: `Not a line of ${o.number}.`,
      });
    const after = dec(line.measured) + dec(e.qty);
    if (after < 0n)
      throw new BadRequestException({
        code: 'below_nothing',
        message: `${line.description}: the book would come to less than nothing.`,
      });
    if (after > dec(line.qty))
      throw new BadRequestException({
        code: 'beyond_order',
        message: `${line.description}: ${Number(fmt(after, 4))} ${line.unit} is beyond the ${Number(line.qty)} ordered. Revise the order first.`,
      });
    await tx`INSERT INTO acc.wo_measurement (order_id, line_key, measured_on, qty, description, reverses, created_by)
      VALUES (${o.id}, ${e.lineKey}, ${e.measuredOn}, ${e.qty}, ${e.description}, ${e.reverses}, ${claims.sub})`;
    await audit(tx, claims.sub, 'subcontract.measure', 'purchase_order', o.id, {
      lineKey: e.lineKey,
      qty: e.qty,
    });
  }

  /** Retention held on an order: certified bills' retention less what has been released. */
  private async retentionHeld(db: Db, orderId: string) {
    const [r] = await db<{ held: string; released: string }[]>`
      SELECT coalesce((SELECT sum((figures->>'retention')::numeric) FROM acc.subcontract_bill
          WHERE order_id = ${orderId} AND status = 'certified'), 0)::text AS held,
        coalesce((SELECT sum(total) FROM acc.vendor_bill WHERE order_id = ${orderId} AND source = 'retention_release'
          AND status <> 'cancelled'), 0)::text AS released`;
    return { held: dec(r!.held), released: dec(r!.released) };
  }

  /** The work order's subcontract page: terms, lines with the book and certified quantities, the book, the bills. */
  async workOrder(claims: TenantClaims, orderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const o = await this.order(db, orderId);
    const may = await this.access(db, claims, o.project_id);
    const [p] = await db<{ number: string; name: string }[]>`
      SELECT number, name FROM proj.project WHERE id = ${o.project_id}`;
    const { rowVersion, ...terms } = await this.termsOf(db, orderId);
    const book = await db`
      SELECT m.id, m.line_key AS "lineKey", to_char(m.measured_on, 'YYYY-MM-DD') AS "measuredOn", m.qty::text AS qty,
        m.description, m.reverses,
        EXISTS (SELECT 1 FROM acc.wo_measurement r WHERE r.reverses = m.id) AS reversed, u.display_name AS "by"
      FROM acc.wo_measurement m LEFT JOIN platform."user" u ON u.id = m.created_by
      WHERE m.order_id = ${orderId} ORDER BY m.measured_on, m.created_at`;
    const bills = await db`
      SELECT b.id, b.ra_no AS "raNo", to_char(b.upto, 'YYYY-MM-DD') AS upto, b.status,
        b.figures->>'net' AS net, b.figures->>'gross' AS gross, v.bill_no AS "billNo", b.vendor_bill_id AS "vendorBillId"
      FROM acc.subcontract_bill b LEFT JOIN acc.vendor_bill v ON v.id = b.vendor_bill_id
      WHERE b.order_id = ${orderId} ORDER BY b.ra_no`;
    const releases = await db`
      SELECT id, bill_no AS "billNo", to_char(bill_date, 'YYYY-MM-DD') AS date, total::text AS amount
      FROM acc.vendor_bill WHERE order_id = ${orderId} AND source = 'retention_release' AND status <> 'cancelled'
      ORDER BY bill_date`;
    const r = await this.retentionHeld(db, orderId);
    const mayRelease = await this.permissions.can(claims, 'accounts.post');
    return {
      order: {
        id: o.id,
        number: o.number,
        status: o.status,
        supply: o.supply,
        party: { id: o.party_id, name: o.party },
        project: { id: o.project_id, number: p!.number, name: p!.name },
      },
      terms,
      termsRowVersion: rowVersion,
      lines: await this.orderLines(db, o, null),
      book,
      bills,
      releases,
      retention: {
        held: money(r.held),
        released: money(r.released),
        left: money(r.held - r.released),
      },
      mayMeasure: may && ['issued', 'acknowledged'].includes(o.status),
      mayBill:
        may &&
        ['issued', 'acknowledged'].includes(o.status) &&
        !bills.some((b) => ['draft', 'pending'].includes(b.status as string)),
      mayRelease: mayRelease && r.held > r.released,
    };
  }

  // --- the bills ---

  private async row(db: Db, id: string, lock = false) {
    const [b] = await db<BillRow[]>`
      SELECT id, order_id, ra_no, to_char(upto, 'YYYY-MM-DD') AS upto, status, terms, row_version
      FROM acc.subcontract_bill WHERE id = ${id} ${lock ? db`FOR UPDATE` : db``}`;
    if (!b) throw new NotFoundException({ code: 'bill_not_found' });
    return b;
  }

  async create(claims: TenantClaims, orderId: string, input: { upto: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'wo-book ' + orderId}))`;
        const o = await this.order(tx, orderId);
        await this.mustBill(tx, claims, o.project_id);
        this.inForce(o);
        const [last] = await tx<{ ra_no: number; upto: string | null }[]>`
          SELECT coalesce(max(ra_no), 0) AS ra_no,
            (SELECT to_char(max(upto), 'YYYY-MM-DD') FROM acc.subcontract_bill WHERE order_id = ${orderId}
              AND status = 'certified') AS upto
          FROM acc.subcontract_bill WHERE order_id = ${orderId}`;
        if (last!.upto && input.upto < last!.upto)
          throw new BadRequestException({
            code: 'before_last_bill',
            message: `The last certified bill went up to ${last!.upto}.`,
          });
        const { rowVersion: _, ...terms } = await this.termsOf(tx, orderId);
        const [b] = await tx<{ id: string }[]>`
          INSERT INTO acc.subcontract_bill (order_id, ra_no, upto, terms, created_by, updated_by)
          VALUES (${orderId}, ${last!.ra_no + 1}, ${input.upto}, ${tx.json(JSON.parse(JSON.stringify(terms)))},
            ${claims.sub}, ${claims.sub})
          RETURNING id`;
        await this.fill(tx, b!.id, o, input.upto);
        await audit(tx, claims.sub, 'subcontract_bill.create', 'subcontract_bill', b!.id, {
          raNo: last!.ra_no + 1,
        });
        return b!.id;
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'open_bill',
            message: 'This order already has a bill in the making.',
          });
        return fromDb(err);
      });
    return this.get(claims, id);
  }

  /** Lines from the book up to the date, each less what the last certified bill certified. */
  private async fill(tx: TransactionSql, billId: string, o: Order, upto: string) {
    await tx`DELETE FROM acc.subcontract_bill_line WHERE bill_id = ${billId}`;
    for (const l of await this.orderLines(tx, o, upto))
      await tx`INSERT INTO acc.subcontract_bill_line (bill_id, line_key, position, description, unit, rate, gst_pct,
          prev_qty, measured_qty, cum_qty)
        VALUES (${billId}, ${l.lineKey}, ${l.position}, ${l.description}, ${l.unit}, ${l.rate}, ${l.gstPct},
          ${l.certified}, ${l.measured}, ${l.measured})`;
  }

  private lines(db: Db, billId: string) {
    return db<LineRow[]>`
      SELECT line_key AS "lineKey", position, description, unit, rate::text AS rate, gst_pct::text AS "gstPct",
        prev_qty::text AS "prevQty", measured_qty::text AS "measuredQty", cum_qty::text AS "cumQty"
      FROM acc.subcontract_bill_line WHERE bill_id = ${billId} ORDER BY position`;
  }
  private backcharges(db: Db, billId: string) {
    return db<
      {
        position: number;
        description: string;
        amount: string;
        accountId: string;
        account: string;
      }[]
    >`
      SELECT c.position, c.description, c.amount::text AS amount, c.account_id AS "accountId",
        a.code || ' ' || a.name AS account
      FROM acc.subcontract_backcharge c JOIN acc.account a ON a.id = c.account_id
      WHERE c.bill_id = ${billId} ORDER BY c.position`;
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

  /**
   * The bill's figures. Gross: each line's quantity this bill (cumulative less previous) at the order's rate; GST as on
   * the order; retention on the gross, to the cap less what earlier bills retained; advance recovery at its % up to the
   * advance paid and not yet recovered; back-charges; labour cess on the gross; TDS by the supplier rules (the year's
   * catch-up included). Lines whose quantity went below what was certified are refused: the earlier bill is corrected
   * by a debit note.
   */
  private async figures(db: Db, b: BillRow, o: Order): Promise<SubcontractFigures> {
    let [gross, cgst, sgst, igst] = [0n, 0n, 0n, 0n];
    for (const l of await this.lines(db, b.id)) {
      const qty = dec(l.cumQty) - dec(l.prevQty);
      if (qty < 0n)
        throw new BadRequestException({
          code: 'below_certified',
          message: `${l.description}: ${Number(l.cumQty)} ${l.unit} is less than the ${Number(l.prevQty)} already certified. Correct the earlier bill with a debit note.`,
        });
      const amount = r2(mul(qty, dec(l.rate)));
      gross += amount;
      if (o.supply === 'intra') {
        const half = r2(mul(amount, div(dec(l.gstPct), dec('200'))));
        cgst += half;
        sgst += half;
      } else if (o.supply === 'inter') igst += r2(mul(amount, div(dec(l.gstPct), dec('100'))));
    }
    const total = gross + cgst + sgst + igst;
    const t = b.terms;
    let retention = pct(gross, t.retentionPct);
    if (t.retentionCap !== null) {
      const [held] = await db<{ v: string }[]>`
        SELECT coalesce(sum((figures->>'retention')::numeric), 0)::text AS v FROM acc.subcontract_bill
        WHERE order_id = ${b.order_id} AND status = 'certified' AND id <> ${b.id}`;
      const room = dec(t.retentionCap) - dec(held!.v);
      retention = min(retention, room > 0n ? room : 0n);
    }
    const [bc] = await db<{ v: string }[]>`
      SELECT coalesce(sum(amount), 0)::text AS v FROM acc.subcontract_backcharge WHERE bill_id = ${b.id}`;
    const backcharges = dec(bc!.v);
    const cess = pct(gross, t.labourCessPct);
    let tds = { base: '0.00', rate: '0', tds: '0.00' };
    if (t.tdsSection) {
      const s = await this.section(db, t.tdsSection, b.upto);
      const fy = fyOf(b.upto);
      const [prior] = await db<{ taxable: string; taxed: string }[]>`
        SELECT coalesce(sum(taxable), 0)::text AS taxable, coalesce(sum(tds_base), 0)::text AS taxed
        FROM acc.vendor_bill WHERE entity_id = ${o.entity_id} AND party_id = ${o.party_id}
          AND tds_section = ${t.tdsSection} AND status <> 'cancelled' AND bill_date BETWEEN ${fy.from} AND ${fy.to}`;
      tds = workTds({
        section: s,
        pan: o.pan ?? o.gstin?.slice(2, 12) ?? null,
        taxable: money(gross),
        priorTaxable: prior!.taxable,
        priorTaxed: prior!.taxed,
      });
    }
    const payable = total - dec(tds.tds) - retention - backcharges - cess;
    const left = await this.payables.advanceLeft(db, o.entity_id, o.party_id);
    const advance = min(pct(gross, t.advanceRecoveryPct), left, payable > 0n ? payable : 0n);
    return {
      gross: money(gross),
      cgst: money(cgst),
      sgst: money(sgst),
      igst: money(igst),
      total: money(total),
      retention: money(retention),
      advance: money(advance),
      backcharges: money(backcharges),
      cess: money(cess),
      tdsSection: t.tdsSection,
      tdsRate: tds.rate,
      tdsBase: tds.base,
      tds: tds.tds,
      payable: money(payable),
      net: money(payable - advance),
    };
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.row(db, id);
    const o = await this.order(db, b.order_id);
    const may = await this.access(db, claims, o.project_id);
    const [h] = await db`
      SELECT b.id, b.ra_no AS "raNo", to_char(b.upto, 'YYYY-MM-DD') AS upto, b.status, b.status_reason AS "statusReason",
        b.terms, b.figures AS certified, b.row_version AS "rowVersion",
        CASE WHEN v.id IS NULL THEN NULL ELSE json_build_object('id', v.id, 'billNo', v.bill_no,
          'voucher', (SELECT number FROM acc.voucher WHERE id = v.voucher_id)) END AS "vendorBill",
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project
      FROM acc.subcontract_bill b LEFT JOIN acc.vendor_bill v ON v.id = b.vendor_bill_id
      JOIN proj.project p ON p.id = ${o.project_id}
      WHERE b.id = ${id}`;
    let working: SubcontractFigures | null = null;
    let problem: string | null = null;
    if (b.status === 'draft')
      working = await this.figures(db, b, o).catch((err: unknown) => {
        problem = (err as { response?: { message?: string } }).response?.message ?? String(err);
        return null;
      });
    return {
      ...h!,
      order: {
        id: o.id,
        number: o.number,
        supply: o.supply,
        party: { id: o.party_id, name: o.party },
      },
      lines: await this.lines(db, id),
      backcharges: await this.backcharges(db, id),
      figures: working,
      problem,
      approval: await this.approvals.latestFor(db, claims, SUBCONTRACT_BILL, id),
      mayEdit: may && b.status === 'draft',
      maySubmit: may && b.status === 'draft' && !problem,
      mayCancel: may && ['draft', 'pending'].includes(b.status),
    };
  }

  async update(
    claims: TenantClaims,
    id: string,
    input: {
      rowVersion: number;
      lines: { lineKey: string; cumQty: string }[];
      backcharges: BackchargeInput[];
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const b = await this.draft(tx, claims, id, input.rowVersion);
        for (const l of input.lines) {
          const [u] = await tx<{ description: string; measured: string; ok: boolean }[]>`
            UPDATE acc.subcontract_bill_line SET cum_qty = ${l.cumQty} WHERE bill_id = ${id} AND line_key = ${l.lineKey}
            RETURNING description, measured_qty::text AS measured, cum_qty <= measured_qty AS ok`;
          if (!u)
            throw new BadRequestException({
              code: 'unknown_line',
              message: 'A line is not on this bill.',
            });
          if (!u.ok)
            throw new BadRequestException({
              code: 'beyond_measured',
              message: `${u.description}: no more than the ${Number(u.measured)} measured.`,
            });
        }
        await tx`DELETE FROM acc.subcontract_backcharge WHERE bill_id = ${id}`;
        for (const [i, c] of input.backcharges.entries()) {
          const [a] = await tx<{ ok: boolean }[]>`
            SELECT NOT is_group AND closed_at IS NULL AND kind IN ('ordinary', 'tax') AS ok
            FROM acc.account WHERE id = ${c.accountId}`;
          if (!a?.ok)
            throw new BadRequestException({
              code: 'not_a_ledger',
              message: `${c.description}: choose an open ledger.`,
            });
          await tx`INSERT INTO acc.subcontract_backcharge (bill_id, position, description, amount, account_id)
            VALUES (${id}, ${i + 1}, ${c.description}, ${c.amount}, ${c.accountId})`;
        }
        await this.touch(tx, claims, b.id);
      })
      .catch(fromDb);
    return this.get(claims, id);
  }

  /** Takes the book again (to the date given): quantity edits are lost, back-charges kept, terms taken afresh. */
  async refresh(claims: TenantClaims, id: string, input: { upto: string; rowVersion: number }) {
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const b = await this.draft(tx, claims, id, input.rowVersion);
        const o = await this.order(tx, b.order_id);
        const [last] = await tx<{ upto: string | null }[]>`
          SELECT to_char(max(upto), 'YYYY-MM-DD') AS upto FROM acc.subcontract_bill
          WHERE order_id = ${b.order_id} AND status = 'certified'`;
        if (last!.upto && input.upto < last!.upto)
          throw new BadRequestException({
            code: 'before_last_bill',
            message: `The last certified bill went up to ${last!.upto}.`,
          });
        await this.fill(tx, id, o, input.upto);
        const { rowVersion: _, ...terms } = await this.termsOf(tx, b.order_id);
        await tx`UPDATE acc.subcontract_bill SET upto = ${input.upto},
            terms = ${tx.json(JSON.parse(JSON.stringify(terms)))} WHERE id = ${id}`;
        await this.touch(tx, claims, id);
      })
      .catch(fromDb);
    return this.get(claims, id);
  }

  private async draft(tx: TransactionSql, claims: TenantClaims, id: string, rowVersion: number) {
    const b = await this.row(tx, id, true);
    const o = await this.order(tx, b.order_id);
    await this.mustBill(tx, claims, o.project_id);
    if (b.status !== 'draft')
      throw new ConflictException({ code: 'not_draft', message: 'Only a draft bill changes.' });
    if (b.row_version !== rowVersion)
      throw new ConflictException({
        code: 'stale',
        message: 'Someone else changed this bill. Reload.',
      });
    return b;
  }
  private async touch(tx: TransactionSql, claims: TenantClaims, id: string) {
    await tx`UPDATE acc.subcontract_bill SET updated_at = now(), updated_by = ${claims.sub},
        row_version = row_version + 1 WHERE id = ${id}`;
  }

  /** Submitted under the approval rules: with none (or once approved) it is certified and posted. */
  async submit(claims: TenantClaims, id: string, rowVersion: number) {
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const b = await this.draft(tx, claims, id, rowVersion);
        const o = await this.order(tx, b.order_id);
        this.inForce(o);
        const f = await this.figures(tx, b, o);
        if (dec(f.gross) <= 0n)
          throw new BadRequestException({
            code: 'nothing_to_bill',
            message: 'This bill adds nothing since the last one.',
          });
        if (dec(f.net) < 0n)
          throw new BadRequestException({
            code: 'below_nothing',
            message: 'The deductions come to more than the bill.',
          });
        const res = await this.approvals.submit(tx, claims, {
          docType: SUBCONTRACT_BILL,
          docId: id,
          projectId: o.project_id,
          title: `${o.number} · RA ${b.ra_no} · ${o.party}`,
          amount: f.total,
        });
        await tx`UPDATE acc.subcontract_bill SET status = 'pending', status_reason = NULL,
            figures = ${tx.json(JSON.parse(JSON.stringify(f)))} WHERE id = ${id}`;
        await this.touch(tx, claims, id);
        if (res.status === 'approved') await this.certify(tx, claims, id);
        await audit(tx, claims.sub, 'subcontract_bill.submit', 'subcontract_bill', id, {
          status: res.status,
          total: f.total,
        });
      })
      .catch(fromDb);
    return this.get(claims, id);
  }

  private async decided(
    tx: TransactionSql,
    id: string,
    outcome: Outcome,
    claims: TenantClaims,
    comment: string | null,
  ) {
    if (outcome === 'approved') return this.certify(tx, claims, id).catch(fromDb);
    await tx`UPDATE acc.subcontract_bill SET status = 'draft', figures = NULL,
        status_reason = ${outcome === 'rejected' ? comment : null}, updated_at = now(), updated_by = ${claims.sub},
        row_version = row_version + 1
      WHERE id = ${id}`;
  }

  /**
   * Certified: the figures worked again as of now, a supplier's bill (its lines this bill's quantities, so the order's
   * matching sees them) and one purchase voucher: subcontract cost and input tax Dr; the subcontractor, retention
   * payable, each back-charge's ledger, labour cess and TDS payable Cr; and the advance recovered, subcontractor Dr and
   * advances to suppliers Cr, recorded as an advance applied to the bill.
   */
  private async certify(tx: TransactionSql, claims: TenantClaims, id: string) {
    const b = await this.row(tx, id, true);
    const o = await this.order(tx, b.order_id);
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'advance ' + o.party_id}))`;
    const f = await this.figures(tx, b, o);
    if (dec(f.net) < 0n)
      throw new BadRequestException({
        code: 'below_nothing',
        message: 'The deductions come to more than the bill.',
      });
    const billNo = `${o.number}/RA-${b.ra_no}`;
    const [vb] = await tx<{ id: string }[]>`
      INSERT INTO acc.vendor_bill (entity_id, party_id, order_id, project_id, bill_no, bill_date, due_date, supply,
        status, tds_section, tds_rate, tds_base, taxable, cgst, sgst, igst, total, tds, payable, narration, source,
        created_by, updated_by)
      VALUES (${o.entity_id}, ${o.party_id}, ${o.id}, ${o.project_id}, ${billNo}, ${b.upto}, ${b.upto}, ${o.supply},
        'held', ${f.tdsSection}, ${f.tdsRate}, ${f.tdsBase}, ${f.gross}, ${f.cgst}, ${f.sgst}, ${f.igst}, ${f.total},
        ${f.tds}, ${f.payable}, ${`RA ${b.ra_no} to ${b.upto}`}, 'subcontract', ${claims.sub}, ${claims.sub})
      RETURNING id`;
    const cost = await this.ledger.roleAccount(tx, o.entity_id, 'subcontract_cost');
    const lineOf = (accountId: string, debit: string, credit: string, note: string): LineInput => ({
      accountId,
      partyId: null,
      debit,
      credit,
      projectId: o.project_id,
      siteId: null,
      costCodeId: null,
      note,
    });
    const lines: LineInput[] = [];
    let position = 0;
    for (const l of await this.lines(tx, id)) {
      const qty = dec(l.cumQty) - dec(l.prevQty);
      if (qty <= 0n) continue;
      const amount = r2(mul(qty, dec(l.rate)));
      const gstPct = o.supply === 'unregistered' ? '0' : l.gstPct;
      const gst =
        o.supply === 'intra'
          ? r2(mul(amount, div(dec(gstPct), dec('200')))) * 2n
          : r2(mul(amount, div(dec(gstPct), dec('100'))));
      await tx`INSERT INTO acc.vendor_bill_line (bill_id, position, line_key, account_id, project_id, description, unit,
          qty, rate, gst_pct, amount, gst)
        VALUES (${vb!.id}, ${++position}, ${l.lineKey}, ${cost}, ${o.project_id}, ${l.description}, ${l.unit},
          ${fmt(qty, 4)}, ${l.rate}, ${gstPct}, ${money(amount)}, ${money(gst)})`;
      if (amount !== 0n) lines.push(lineOf(cost, money(amount), '0', l.description));
    }
    const role = (r: Role) => this.ledger.roleAccount(tx, o.entity_id, r);
    const nz = (v: string) => dec(v) !== 0n;
    const party = await this.ledger.partyLedger(tx, o.party_id);
    if (nz(f.cgst)) lines.push(lineOf(await role('input_cgst'), f.cgst, '0', ''));
    if (nz(f.sgst)) lines.push(lineOf(await role('input_sgst'), f.sgst, '0', ''));
    if (nz(f.igst)) lines.push(lineOf(await role('input_igst'), f.igst, '0', ''));
    lines.push(lineOf(party, '0', f.payable, `Bill ${billNo}`));
    if (nz(f.retention))
      lines.push(lineOf(await role('retention_payable'), '0', f.retention, 'Retention'));
    for (const c of await this.backcharges(tx, id))
      lines.push(lineOf(c.accountId, '0', c.amount, c.description));
    if (nz(f.cess))
      lines.push(lineOf(await role('labour_cess_payable'), '0', f.cess, 'Labour cess'));
    if (nz(f.tds)) {
      const tdsRole = `tds_payable_${f.tdsSection!.toLowerCase()}`;
      if (!isRole(tdsRole))
        throw new ConflictException({
          code: 'role_not_mapped',
          message: `No ledger for TDS under ${f.tdsSection}.`,
        });
      lines.push(lineOf(await role(tdsRole), '0', f.tds, `TDS ${f.tdsSection}`));
    }
    if (nz(f.advance)) {
      lines.push(lineOf(party, f.advance, '0', `Advance recovered, ${billNo}`));
      lines.push(
        lineOf(await role('advance_to_suppliers'), '0', f.advance, `Advance recovered, ${billNo}`),
      );
    }
    const v = await this.ledger.post(
      tx,
      claims,
      {
        entityId: o.entity_id,
        type: 'purchase',
        date: b.upto,
        narration: `${o.party}: ${o.number} RA ${b.ra_no} to ${b.upto}`,
        reference: billNo,
        lines,
      },
      { kind: 'subcontract_bill', id },
    );
    await tx`UPDATE acc.vendor_bill SET status = 'posted', voucher_id = ${v!.id} WHERE id = ${vb!.id}`;
    if (nz(f.advance))
      await tx`INSERT INTO acc.advance_application (entity_id, party_id, bill_id, applied_on, amount, voucher_id,
          created_by)
        VALUES (${o.entity_id}, ${o.party_id}, ${vb!.id}, ${b.upto}, ${f.advance}, ${v!.id}, ${claims.sub})`;
    await tx`UPDATE acc.subcontract_bill SET status = 'certified', status_reason = NULL,
        figures = ${tx.json(JSON.parse(JSON.stringify(f)))}, vendor_bill_id = ${vb!.id}, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1
      WHERE id = ${id}`;
    await audit(tx, claims.sub, 'subcontract_bill.certify', 'subcontract_bill', id, { net: f.net });
  }

  async cancel(claims: TenantClaims, id: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const b = await this.row(tx, id, true);
      const o = await this.order(tx, b.order_id);
      await this.mustBill(tx, claims, o.project_id);
      if (b.status === 'certified' || b.status === 'cancelled')
        throw new ConflictException({
          code: 'certified',
          message: 'A certified bill is in payables: correct it with a debit note.',
        });
      await this.approvals.withdrawFor(tx, claims, SUBCONTRACT_BILL, id);
      await tx`UPDATE acc.subcontract_bill SET status = 'cancelled', status_reason = ${reason}, figures = NULL,
          updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'subcontract_bill.cancel', 'subcontract_bill', id, { reason });
    });
    return this.get(claims, id);
  }

  /** Retention released, up to what is held: retention payable Dr, the subcontractor Cr, as a supplier's bill to pay. */
  async release(claims: TenantClaims, orderId: string, input: { date: string; amount: string }) {
    if (!(await this.permissions.can(claims, 'accounts.post')))
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'This needs the permission to post.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'wo-book ' + orderId}))`;
        const o = await this.order(tx, orderId);
        const r = await this.retentionHeld(tx, orderId);
        const amount = dec(input.amount);
        if (amount > r.held - r.released)
          throw new BadRequestException({
            code: 'over_retention',
            message: `₹${money(r.held - r.released)} of retention is held.`,
          });
        const [n] = await tx<{ n: number }[]>`
          SELECT count(*)::int + 1 AS n FROM acc.vendor_bill WHERE order_id = ${orderId} AND source = 'retention_release'`;
        const billNo = `${o.number}/RR-${n!.n}`;
        const account = await this.ledger.roleAccount(tx, o.entity_id, 'retention_payable');
        const [vb] = await tx<{ id: string }[]>`
          INSERT INTO acc.vendor_bill (entity_id, party_id, order_id, project_id, bill_no, bill_date, due_date, supply,
            status, taxable, total, payable, narration, source, created_by, updated_by)
          VALUES (${o.entity_id}, ${o.party_id}, ${o.id}, ${o.project_id}, ${billNo}, ${input.date}, ${input.date},
            ${o.supply}, 'held', 0, ${money(amount)}, ${money(amount)}, 'Retention released', 'retention_release',
            ${claims.sub}, ${claims.sub})
          RETURNING id`;
        await tx`INSERT INTO acc.vendor_bill_line (bill_id, position, account_id, project_id, description, qty, rate,
            gst_pct, amount, gst)
          VALUES (${vb!.id}, 1, ${account}, ${o.project_id}, 'Retention released', 1, ${money(amount)}, 0,
            ${money(amount)}, 0)`;
        const lineOf = (accountId: string, debit: string, credit: string): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId: o.project_id,
          siteId: null,
          costCodeId: null,
          note: `Retention released, ${o.number}`,
        });
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: o.entity_id,
            type: 'journal',
            date: input.date,
            narration: `${o.party}: retention released on ${o.number}`,
            reference: billNo,
            lines: [
              lineOf(account, money(amount), '0'),
              lineOf(await this.ledger.partyLedger(tx, o.party_id), '0', money(amount)),
            ],
          },
          { kind: 'vendor_bill', id: vb!.id },
        );
        await tx`UPDATE acc.vendor_bill SET status = 'posted', voucher_id = ${v!.id} WHERE id = ${vb!.id}`;
        await audit(tx, claims.sub, 'subcontract.release', 'purchase_order', orderId, {
          amount: money(amount),
        });
      })
      .catch(fromDb);
    return this.workOrder(claims, orderId);
  }

  /** The project's subcontract bills, for its page. */
  async projectBills(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return db`
      SELECT o.id AS "orderId", o.number AS "order", y.name AS party, o.status,
        coalesce((SELECT json_agg(json_build_object('id', b.id, 'raNo', b.ra_no, 'upto', to_char(b.upto, 'YYYY-MM-DD'),
          'status', b.status, 'net', b.figures->>'net') ORDER BY b.ra_no)
          FROM acc.subcontract_bill b WHERE b.order_id = o.id AND b.status <> 'cancelled'), '[]') AS bills
      FROM proc.purchase_order o JOIN platform.party y ON y.id = o.party_id
      WHERE o.project_id = ${projectId} AND o.kind = 'work' AND o.status IN ('issued', 'acknowledged', 'closed')
      ORDER BY o.number`;
  }
}
