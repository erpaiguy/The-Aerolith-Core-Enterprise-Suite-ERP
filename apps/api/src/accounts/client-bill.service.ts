// Client RA bills (docs/wave3-plan.md step 2): the project's contract terms, each running account bill from the
// measurement book up to a date less what the previous certified bill certified, submitted through the approval
// rules, certified by the client (often for less), which makes it a tax invoice and posts it to the books.
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
import { dec, fmt } from '../rates/decimal.js';
import { nextNumber } from '../tender/numbering.js';
import { audit } from '../tender/tender-records.js';
import { fromDb } from './accounts-rules.js';
import { workBill, type BillFigures, type BillTerms } from './client-bill-math.js';
import { LedgerService } from './ledger.service.js';

type Db = Sql | TransactionSql;
export const CLIENT_BILL = 'client_bill';
const DEFAULT_TERMS: BillTerms = {
  gstPct: '18',
  retentionPct: '0',
  retentionCap: null,
  advanceAmount: '0',
  advanceRecoveryPct: '0',
  escalation: null,
};

interface BillRow {
  id: string;
  project_id: string;
  entity_id: string;
  ra_no: number;
  site_id: string;
  upto: string;
  status: 'draft' | 'pending' | 'submitted' | 'certified' | 'cancelled';
  terms: BillTerms;
  indices: Record<string, string>;
  intra: boolean;
  row_version: number;
}
interface BillHead {
  id: string;
  raNo: number;
  upto: string;
  status: BillRow['status'];
  statusReason: string | null;
  terms: BillTerms;
  indices: Record<string, string>;
  intra: boolean;
  submitted: BillFigures | null;
  certified: BillFigures | null;
  clientRef: string;
  certifiedOn: string | null;
  invoiceNo: string | null;
  invoiceDate: string | null;
  voucherId: string | null;
  rowVersion: number;
  project: { id: string; number: string; name: string };
  site: { id: string; name: string; stateCode: string | null; address: string | null };
  company: { id: string; name: string; legalName: string; gstin: string | null; address: string };
  client: { id: string; name: string; gstin: string | null; address: string | null } | null;
}
export interface DeductionInput {
  description: string;
  amount: string;
  accountId: string;
}

@Injectable()
export class ClientBillService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
    private readonly approvals: ApprovalService,
    private readonly ledger: LedgerService,
  ) {}

  onModuleInit() {
    this.approvals.register(CLIENT_BILL, {
      label: 'Client RA bill',
      projectScoped: true,
      link: (id) => `/client-bills/${id}`,
      decided: (tx, id, outcome, claims, comment) => this.decided(tx, id, outcome, claims, comment),
      summary: async (db, id) => {
        const [b] = await db`
          SELECT b.ra_no AS "raNo", p.number AS project, p.name AS "projectName", b.submitted
          FROM acc.client_bill b JOIN proj.project p ON p.id = b.project_id WHERE b.id = ${id}`;
        return b ?? null;
      },
      canSee: async (db, claims, id) => {
        const [b] = await db<
          { project_id: string }[]
        >`SELECT project_id FROM acc.client_bill WHERE id = ${id}`;
        if (!b) return false;
        return this.projects.access(db, claims, b.project_id).then(
          () => true,
          () => false,
        );
      },
    });
  }

  /** The project's team sees its bills; its leads and members (or those who edit projects) with billing.edit make them. */
  private async access(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    const may =
      (a.canEdit || a.role === 'lead' || a.role === 'member') &&
      (await this.permissions.can(claims, 'billing.edit'));
    return { may };
  }
  private async mustBill(db: Db, claims: TenantClaims, projectId: string) {
    if (!(await this.access(db, claims, projectId)).may)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Client bills are made by the project's team with the billing permission.",
      });
  }

  // --- the contract terms ---

  private async termsOf(
    db: Db,
    projectId: string,
  ): Promise<BillTerms & { rowVersion: number | null }> {
    const [t] = await db<
      {
        gst_pct: string;
        retention_pct: string;
        retention_cap: string | null;
        advance_amount: string;
        advance_recovery_pct: string;
        escalation: BillTerms['escalation'];
        row_version: number;
      }[]
    >`
      SELECT gst_pct::text, retention_pct::text, retention_cap::text, advance_amount::text,
        advance_recovery_pct::text, escalation, row_version
      FROM acc.bill_terms WHERE project_id = ${projectId}`;
    if (!t) return { ...DEFAULT_TERMS, rowVersion: null };
    return {
      gstPct: t.gst_pct,
      retentionPct: t.retention_pct,
      retentionCap: t.retention_cap,
      advanceAmount: t.advance_amount,
      advanceRecoveryPct: t.advance_recovery_pct,
      escalation: t.escalation,
      rowVersion: t.row_version,
    };
  }

  async projectBills(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const { may } = await this.access(db, claims, projectId);
    const bills = await db`
      SELECT b.id, b.ra_no AS "raNo", to_char(b.upto, 'YYYY-MM-DD') AS upto, b.status, b.status_reason AS "statusReason",
        b.invoice_no AS "invoiceNo", to_char(b.certified_on, 'YYYY-MM-DD') AS "certifiedOn",
        coalesce(b.certified, b.submitted) -> 'gross' AS gross, coalesce(b.certified, b.submitted) -> 'invoiceTotal' AS
          "invoiceTotal", coalesce(b.certified, b.submitted) -> 'net' AS net, s.name AS site
      FROM acc.client_bill b JOIN proj.site s ON s.id = b.site_id
      WHERE b.project_id = ${projectId} ORDER BY b.ra_no DESC`;
    const [p] = await db<{ client: string | null; company: string; gstin: string | null }[]>`
      SELECT c.name AS client, e.name AS company, e.gstin FROM proj.project p
      JOIN platform.entity e ON e.id = p.entity_id LEFT JOIN platform.party c ON c.id = p.client_id
      WHERE p.id = ${projectId}`;
    return { ...p, terms: await this.termsOf(db, projectId), bills, mayBill: may };
  }

  async setTerms(
    claims: TenantClaims,
    projectId: string,
    t: BillTerms & { rowVersion: number | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustBill(db, claims, projectId);
    const keys = new Set<string>();
    for (const c of t.escalation?.components ?? []) {
      if (keys.has(c.key))
        throw new BadRequestException({ code: 'duplicate_component', message: `${c.name} twice.` });
      keys.add(c.key);
    }
    const share = (t.escalation?.components ?? []).reduce((s, c) => s + dec(c.sharePct), 0n);
    if (share > dec('100'))
      throw new BadRequestException({
        code: 'shares_over_100',
        message: 'The escalation shares add up to more than 100%.',
      });
    await db.begin(async (tx) => {
      const [cur] = await tx<{ row_version: number }[]>`
        SELECT row_version FROM acc.bill_terms WHERE project_id = ${projectId} FOR UPDATE`;
      if ((cur?.row_version ?? null) !== t.rowVersion)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone else changed the terms. Reload.',
        });
      const esc = t.escalation ? tx.json(JSON.parse(JSON.stringify(t.escalation))) : null;
      if (cur)
        await tx`UPDATE acc.bill_terms SET gst_pct = ${t.gstPct}, retention_pct = ${t.retentionPct},
            retention_cap = ${t.retentionCap}, advance_amount = ${t.advanceAmount},
            advance_recovery_pct = ${t.advanceRecoveryPct}, escalation = ${esc}, updated_at = now(),
            updated_by = ${claims.sub}, row_version = row_version + 1
          WHERE project_id = ${projectId}`;
      else
        await tx`INSERT INTO acc.bill_terms (project_id, gst_pct, retention_pct, retention_cap, advance_amount,
            advance_recovery_pct, escalation, updated_by)
          VALUES (${projectId}, ${t.gstPct}, ${t.retentionPct}, ${t.retentionCap}, ${t.advanceAmount},
            ${t.advanceRecoveryPct}, ${esc}, ${claims.sub})`;
      await audit(tx, claims.sub, 'bill_terms.set', 'project', projectId, { gstPct: t.gstPct });
    });
    return this.projectBills(claims, projectId);
  }

  // --- making a bill ---

  /** Each priced item of the live contract BOQs: measured to the date, and the last certified cumulative quantity. */
  private async pull(db: Db, projectId: string, upto: string) {
    return db<
      {
        line_key: string;
        code: string | null;
        description: string;
        unit: string | null;
        rate: string;
        contract_qty: string | null;
        prev_qty: string;
        measured_qty: string;
      }[]
    >`
      WITH done AS (
        SELECT line_key, sum(qty) AS qty FROM proj.measurement
        WHERE project_id = ${projectId} AND measured_on <= ${upto} GROUP BY line_key
      ), last AS (
        SELECT l.line_key, l.cert_qty FROM acc.client_bill_line l
        WHERE l.bill_id = (SELECT id FROM acc.client_bill WHERE project_id = ${projectId} AND status = 'certified'
          ORDER BY ra_no DESC LIMIT 1)
      )
      SELECT n.line_key::text, n.code, t.description, n.unit, n.rate::text AS rate, n.qty::text AS contract_qty,
        coalesce(last.cert_qty, 0)::text AS prev_qty, coalesce(done.qty, 0)::text AS measured_qty
      FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item' AND n.amount IS NOT NULL
      JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      LEFT JOIN done ON done.line_key = n.line_key LEFT JOIN last ON last.line_key = n.line_key
      WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
        AND (coalesce(done.qty, 0) <> 0 OR coalesce(last.cert_qty, 0) <> 0)
      ORDER BY b.created_at, n.sort_key`;
  }

  async create(
    claims: TenantClaims,
    projectId: string,
    b: { upto: string; siteId: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustBill(db, claims, projectId);
    const [p] = await db<
      { entity_id: string; client_id: string | null; gstin: string | null; state: string | null }[]
    >`
      SELECT p.entity_id, p.client_id, e.gstin, e.state_code AS state
      FROM proj.project p JOIN platform.entity e ON e.id = p.entity_id WHERE p.id = ${projectId}`;
    if (!p!.client_id)
      throw new ConflictException({
        code: 'no_client',
        message: 'Name the project’s client before billing it.',
      });
    if (!p!.gstin)
      throw new ConflictException({
        code: 'no_gstin',
        message: "A tax invoice names the company's GSTIN: set it in Companies first.",
      });
    const sites = await db<{ id: string; state_code: string | null }[]>`
      SELECT id, state_code FROM proj.site WHERE project_id = ${projectId} AND active ORDER BY created_at`;
    const site = b.siteId
      ? sites.find((s) => s.id === b.siteId)
      : sites.length === 1
        ? sites[0]
        : undefined;
    if (!site)
      throw new BadRequestException({
        code: 'site_needed',
        message: sites.length
          ? 'Choose the site the bill is for.'
          : 'Add the project’s site first.',
      });
    if (!site.state_code)
      throw new BadRequestException({
        code: 'site_state',
        message: "Set the site's GST state: it decides the tax.",
      });
    const terms = await this.termsOf(db, projectId);
    const { rowVersion: _rv, ...copy } = terms;
    const id = await db
      .begin(async (tx) => {
        await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
        const [open] = await tx<{ ra_no: number }[]>`
          SELECT ra_no FROM acc.client_bill WHERE project_id = ${projectId} AND status IN ('draft', 'pending', 'submitted')`;
        if (open)
          throw new ConflictException({
            code: 'previous_open',
            message: `RA ${open.ra_no} is not certified yet: certify or cancel it before the next bill.`,
          });
        const [last] = await tx<{ upto: string }[]>`
          SELECT to_char(upto, 'YYYY-MM-DD') AS upto FROM acc.client_bill
          WHERE project_id = ${projectId} AND status = 'certified' ORDER BY ra_no DESC LIMIT 1`;
        if (last && b.upto <= last.upto)
          throw new BadRequestException({
            code: 'before_previous',
            message: `The previous bill was made up to ${last.upto}; this one goes later.`,
          });
        const [n] = await tx<{ n: number }[]>`
          SELECT coalesce(max(ra_no), 0)::int + 1 AS n FROM acc.client_bill WHERE project_id = ${projectId}`;
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO acc.client_bill (project_id, entity_id, ra_no, site_id, upto, terms, intra, created_by,
            updated_by)
          VALUES (${projectId}, ${p!.entity_id}, ${n!.n}, ${site.id}, ${b.upto}, ${tx.json(JSON.parse(JSON.stringify(copy)))},
            ${site.state_code === p!.state}, ${claims.sub}, ${claims.sub})
          RETURNING id`;
        await this.fill(tx, row!.id, projectId, b.upto);
        await audit(tx, claims.sub, 'client_bill.create', 'client_bill', row!.id, { raNo: n!.n });
        return row!.id;
      })
      .catch(fromDb);
    return this.get(claims, id);
  }

  private async fill(tx: TransactionSql, billId: string, projectId: string, upto: string) {
    const lines = await this.pull(tx, projectId, upto);
    if (!lines.length)
      throw new BadRequestException({
        code: 'nothing_measured',
        message: 'Nothing is measured on the contract BOQ up to that date.',
      });
    await tx`DELETE FROM acc.client_bill_line WHERE bill_id = ${billId}`;
    for (const [i, l] of lines.entries())
      await tx`
        INSERT INTO acc.client_bill_line (bill_id, line_key, position, code, description, unit, rate, contract_qty,
          prev_qty, measured_qty, cum_qty)
        VALUES (${billId}, ${l.line_key}, ${i + 1}, ${l.code}, ${l.description}, ${l.unit}, ${l.rate},
          ${l.contract_qty}, ${l.prev_qty}, ${l.measured_qty}, ${l.measured_qty})`;
  }

  private async row(db: Db, id: string, lock = false) {
    const [b] = await db<BillRow[]>`
      SELECT id, project_id, entity_id, ra_no, site_id, to_char(upto, 'YYYY-MM-DD') AS upto, status, terms, indices,
        intra, row_version
      FROM acc.client_bill WHERE id = ${id} ${lock ? db`FOR UPDATE` : db``}`;
    if (!b) throw new NotFoundException({ code: 'bill_not_found' });
    return b;
  }

  private lines(db: Db, id: string) {
    return db<
      {
        lineKey: string;
        position: number;
        code: string | null;
        description: string;
        unit: string | null;
        rate: string;
        contractQty: string | null;
        prevQty: string;
        measuredQty: string;
        cumQty: string;
        certQty: string | null;
      }[]
    >`
      SELECT line_key AS "lineKey", position, code, description, unit, rate::text AS rate,
        contract_qty::text AS "contractQty", prev_qty::text AS "prevQty", measured_qty::text AS "measuredQty",
        cum_qty::text AS "cumQty", cert_qty::text AS "certQty"
      FROM acc.client_bill_line WHERE bill_id = ${id} ORDER BY position`;
  }
  private deductions(db: Db, id: string) {
    return db<
      {
        position: number;
        description: string;
        amount: string;
        account: { id: string; code: string; name: string };
      }[]
    >`
      SELECT d.position, d.description, d.amount::text AS amount,
        json_build_object('id', a.id, 'code', a.code, 'name', a.name) AS account
      FROM acc.client_bill_deduction d JOIN acc.account a ON a.id = d.account_id
      WHERE d.bill_id = ${id} ORDER BY d.position`;
  }

  /** What earlier certified bills of the project held back and recovered. */
  private async prior(db: Db, projectId: string, raNo: number) {
    const [p] = await db<{ retention: string; advance: string }[]>`
      SELECT coalesce(sum((certified ->> 'retention')::numeric), 0)::text AS retention,
        coalesce(sum((certified ->> 'advanceRecovery')::numeric), 0)::text AS advance
      FROM acc.client_bill WHERE project_id = ${projectId} AND status = 'certified' AND ra_no < ${raNo}`;
    return { retention: p!.retention, advanceRecovered: p!.advance };
  }

  /** The bill's figures, on what was billed or (`certified`) on what was certified. */
  private async figures(db: Db, b: BillRow, certified: boolean): Promise<BillFigures> {
    const lines = await this.lines(db, b.id);
    const others = await this.deductions(db, b.id);
    return workBill({
      terms: b.terms,
      lines: lines.map((l) => ({
        lineKey: l.lineKey,
        rate: l.rate,
        prevQty: l.prevQty,
        cumQty: certified ? (l.certQty ?? l.cumQty) : l.cumQty,
      })),
      indices: b.indices,
      others,
      prior: await this.prior(db, b.project_id, b.ra_no),
      intra: b.intra,
    });
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.row(db, id);
    const { may } = await this.access(db, claims, b.project_id);
    const [h] = await db<BillHead[]>`
      SELECT b.id, b.ra_no AS "raNo", to_char(b.upto, 'YYYY-MM-DD') AS upto, b.status, b.status_reason AS "statusReason",
        b.terms, b.indices, b.intra, b.submitted, b.certified, b.client_ref AS "clientRef",
        to_char(b.certified_on, 'YYYY-MM-DD') AS "certifiedOn", b.invoice_no AS "invoiceNo",
        to_char(b.invoice_date, 'YYYY-MM-DD') AS "invoiceDate", b.voucher_id AS "voucherId", b.row_version AS
          "rowVersion",
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        json_build_object('id', s.id, 'name', s.name, 'stateCode', s.state_code, 'address', s.address) AS site,
        json_build_object('id', e.id, 'name', e.name, 'legalName', e.legal_name, 'gstin', e.gstin, 'address', e.address)
          AS company,
        CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'name', c.name, 'gstin', c.gstin,
          'address', c.address) END AS client
      FROM acc.client_bill b JOIN proj.project p ON p.id = b.project_id JOIN proj.site s ON s.id = b.site_id
      JOIN platform.entity e ON e.id = b.entity_id LEFT JOIN platform.party c ON c.id = p.client_id
      WHERE b.id = ${id}`;
    const working = b.status === 'draft' ? await this.figures(db, b, false) : null;
    const receipts = await db<
      { id: string; receivedOn: string; amount: string; voucher: string }[]
    >`
      SELECT r.id, to_char(r.received_on, 'YYYY-MM-DD') AS "receivedOn", a.amount::text AS amount, v.number AS voucher
      FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id AND r.status = 'posted'
      JOIN acc.voucher v ON v.id = r.voucher_id WHERE a.bill_id = ${id} ORDER BY r.received_on`;
    return {
      ...h!,
      lines: await this.lines(db, id),
      deductions: await this.deductions(db, id),
      figures: working,
      receipts,
      approval: await this.approvals.latestFor(db, claims, CLIENT_BILL, id),
      mayEdit: may && b.status === 'draft',
      maySubmit: may && b.status === 'draft',
      mayCertify: may && b.status === 'submitted',
      mayCancel: may && ['draft', 'pending', 'submitted'].includes(b.status),
    };
  }

  async update(
    claims: TenantClaims,
    id: string,
    input: {
      rowVersion: number;
      indices: Record<string, string>;
      lines: { lineKey: string; cumQty: string }[];
      deductions: DeductionInput[];
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const b = await this.row(tx, id, true);
      await this.mustBill(tx, claims, b.project_id);
      if (b.status !== 'draft')
        throw new ConflictException({ code: 'not_draft', message: 'Only a draft bill changes.' });
      if (b.row_version !== input.rowVersion)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone else changed this bill. Reload.',
        });
      const keys = new Set((b.terms.escalation?.components ?? []).map((c) => c.key));
      for (const k of Object.keys(input.indices))
        if (!keys.has(k))
          throw new BadRequestException({
            code: 'unknown_component',
            message: `No component ${k}.`,
          });
      for (const l of input.lines) {
        const [u] = await tx`
          UPDATE acc.client_bill_line SET cum_qty = ${l.cumQty} WHERE bill_id = ${id} AND line_key = ${l.lineKey}
          RETURNING 1`;
        if (!u)
          throw new BadRequestException({
            code: 'unknown_line',
            message: 'A line is not on this bill.',
          });
      }
      await tx`DELETE FROM acc.client_bill_deduction WHERE bill_id = ${id}`;
      for (const [i, d] of input.deductions.entries()) {
        const [a] = await tx<{ ok: boolean }[]>`
          SELECT NOT is_group AND closed_at IS NULL AS ok FROM acc.account WHERE id = ${d.accountId}`;
        if (!a?.ok)
          throw new BadRequestException({
            code: 'not_a_ledger',
            message: `${d.description}: choose an open ledger.`,
          });
        await tx`INSERT INTO acc.client_bill_deduction (bill_id, position, description, amount, account_id)
          VALUES (${id}, ${i + 1}, ${d.description}, ${d.amount}, ${d.accountId})`;
      }
      await tx`UPDATE acc.client_bill SET indices = ${tx.json(input.indices)}, updated_at = now(),
          updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id}`;
    });
    return this.get(claims, id);
  }

  /** Takes the measurement book again (to the same date): edits to the quantities are lost. */
  async refresh(claims: TenantClaims, id: string, input: { upto: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const b = await this.row(tx, id, true);
      await this.mustBill(tx, claims, b.project_id);
      if (b.status !== 'draft')
        throw new ConflictException({ code: 'not_draft', message: 'Only a draft bill changes.' });
      await this.fill(tx, id, b.project_id, input.upto);
      await tx`UPDATE acc.client_bill SET upto = ${input.upto}, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1
        WHERE id = ${id}`;
    });
    return this.get(claims, id);
  }

  async submit(claims: TenantClaims, id: string, rowVersion: number) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const b = await this.row(tx, id, true);
      await this.mustBill(tx, claims, b.project_id);
      if (b.status !== 'draft')
        throw new ConflictException({ code: 'not_draft', message: 'Already submitted.' });
      if (b.row_version !== rowVersion)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone else changed this bill. Reload.',
        });
      const f = await this.figures(tx, b, false);
      if (dec(f.invoiceTotal) <= 0n)
        throw new BadRequestException({
          code: 'nothing_to_bill',
          message: 'This bill adds nothing since the last one.',
        });
      const [p] = await tx<
        { number: string }[]
      >`SELECT number FROM proj.project WHERE id = ${b.project_id}`;
      const res = await this.approvals.submit(tx, claims, {
        docType: CLIENT_BILL,
        docId: id,
        projectId: b.project_id,
        title: `${p!.number} · RA ${b.ra_no}`,
        amount: f.invoiceTotal,
      });
      await tx`UPDATE acc.client_bill SET submitted = ${tx.json(JSON.parse(JSON.stringify(f)))},
          status = ${res.status === 'approved' ? 'submitted' : 'pending'}, status_reason = NULL, updated_at = now(),
          updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'client_bill.submit', 'client_bill', id, {
        status: res.status,
        total: f.invoiceTotal,
      });
    });
    return this.get(claims, id);
  }

  /** The approval follows the bill: approved → submitted to the client; rejected or withdrawn → back to draft. */
  private async decided(
    tx: TransactionSql,
    id: string,
    outcome: Outcome,
    claims: TenantClaims,
    comment: string | null,
  ) {
    await tx`UPDATE acc.client_bill SET status = ${outcome === 'approved' ? 'submitted' : 'draft'},
        status_reason = ${outcome === 'rejected' ? comment : null}, updated_at = now(), updated_by = ${claims.sub},
        row_version = row_version + 1
      WHERE id = ${id}`;
  }

  async cancel(claims: TenantClaims, id: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const b = await this.row(tx, id, true);
      await this.mustBill(tx, claims, b.project_id);
      if (b.status === 'certified' || b.status === 'cancelled')
        throw new ConflictException({
          code: 'certified',
          message: 'A certified bill is a tax invoice: correct it with a credit note.',
        });
      await this.approvals.withdrawFor(tx, claims, CLIENT_BILL, id);
      await tx`UPDATE acc.client_bill SET status = 'cancelled', status_reason = ${reason}, updated_at = now(),
          updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'client_bill.cancel', 'client_bill', id, { reason });
    });
    return this.get(claims, id);
  }

  /**
   * The client's certificate: each line's certified cumulative quantity (missing lines as billed). The bill becomes a
   * tax invoice, numbered per company and year, and posts: the client for the net, retention, the advance recovered and
   * other deductions on the debit side; contract revenue and output tax on the credit side.
   */
  async certify(
    claims: TenantClaims,
    id: string,
    input: {
      rowVersion: number;
      certifiedOn: string;
      clientRef: string;
      lines: { lineKey: string; certQty: string }[];
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const b = await this.row(tx, id, true);
        await this.mustBill(tx, claims, b.project_id);
        if (b.status !== 'submitted')
          throw new ConflictException({
            code: 'not_submitted',
            message: 'Only a bill submitted to the client is certified.',
          });
        if (b.row_version !== input.rowVersion)
          throw new ConflictException({
            code: 'stale',
            message: 'Someone else changed this bill. Reload.',
          });
        if (input.certifiedOn < b.upto)
          throw new BadRequestException({
            code: 'before_bill',
            message: 'The certificate cannot be dated before the bill.',
          });
        await tx`UPDATE acc.client_bill_line SET cert_qty = cum_qty WHERE bill_id = ${id}`;
        for (const l of input.lines) {
          const [u] = await tx`
            UPDATE acc.client_bill_line SET cert_qty = ${l.certQty} WHERE bill_id = ${id} AND line_key = ${l.lineKey}
            RETURNING 1`;
          if (!u)
            throw new BadRequestException({
              code: 'unknown_line',
              message: 'A line is not on this bill.',
            });
        }
        const f = await this.figures(tx, b, true);
        const [p] = await tx<{ client_id: string; number: string }[]>`
          SELECT client_id, number FROM proj.project WHERE id = ${b.project_id}`;
        const invoiceNo = await nextNumber(
          tx,
          'tax_invoice',
          b.entity_id,
          'INV',
          new Date(`${input.certifiedOn}T00:00:00Z`),
        );
        const role = (r: Parameters<LedgerService['roleAccount']>[2]) =>
          this.ledger.roleAccount(tx, b.entity_id, r);
        const proj = {
          projectId: b.project_id,
          siteId: b.site_id,
          costCodeId: null,
          partyId: null,
        };
        const dr = (accountId: string, amount: string, note = '') => ({
          ...proj,
          accountId,
          debit: amount,
          credit: '0',
          note,
        });
        const cr = (accountId: string, amount: string, note = '') => ({
          ...proj,
          accountId,
          debit: '0',
          credit: amount,
          note,
        });
        const nz = (v: string) => dec(v) !== 0n;
        const others = await this.deductions(tx, id);
        const lines = [
          dr(await this.ledger.partyLedger(tx, p!.client_id), f.net, `RA ${b.ra_no} net payable`),
          ...(nz(f.retention)
            ? [dr(await role('retention_receivable'), f.retention, 'Retention')]
            : []),
          ...(nz(f.advanceRecovery)
            ? [
                dr(
                  await role('mobilisation_advance_received'),
                  f.advanceRecovery,
                  'Mobilisation advance recovered',
                ),
              ]
            : []),
          ...others.map((o) => dr(o.account.id, o.amount, o.description)),
          cr(await role('sales_works_contract'), f.taxable, `RA ${b.ra_no}`),
          ...(nz(f.cgst) ? [cr(await role('output_cgst'), f.cgst)] : []),
          ...(nz(f.sgst) ? [cr(await role('output_sgst'), f.sgst)] : []),
          ...(nz(f.igst) ? [cr(await role('output_igst'), f.igst)] : []),
        ];
        // A credit (negative) amount goes on the other side.
        const fixed = lines.map((l) =>
          dec(l.debit) < 0n
            ? { ...l, debit: '0', credit: fmt(-dec(l.debit), 2) }
            : dec(l.credit) < 0n
              ? { ...l, credit: '0', debit: fmt(-dec(l.credit), 2) }
              : l,
        );
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: b.entity_id,
            type: 'sales',
            date: input.certifiedOn,
            narration: `${p!.number} RA ${b.ra_no}, certified${input.clientRef ? ` (${input.clientRef})` : ''}`,
            reference: invoiceNo,
            lines: fixed.filter((l) => nz(l.debit) || nz(l.credit)),
          },
          { kind: CLIENT_BILL, id },
        );
        await tx`UPDATE acc.client_bill SET status = 'certified', certified = ${tx.json(JSON.parse(JSON.stringify(f)))},
            certified_on = ${input.certifiedOn}, client_ref = ${input.clientRef}, invoice_no = ${invoiceNo},
            invoice_date = ${input.certifiedOn}, voucher_id = ${v!.id}, updated_at = now(), updated_by = ${claims.sub},
            row_version = row_version + 1
          WHERE id = ${id}`;
        await audit(tx, claims.sub, 'client_bill.certify', 'client_bill', id, {
          invoiceNo,
          total: f.invoiceTotal,
        });
      })
      .catch(fromDb);
    return this.get(claims, id);
  }
}
