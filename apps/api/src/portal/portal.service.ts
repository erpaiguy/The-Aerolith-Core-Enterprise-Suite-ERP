// What a portal user sees and sends (docs/wave6-plan.md step 5). Every query is filtered by the token's party, and
// anything not theirs is "not found", never "forbidden", so ids of other parties' records reveal nothing. What they
// send is a submission that counts only when staff accept it; acknowledging an order is their own act and counts.
import type { Readable } from 'node:stream';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { DocumentsService } from '../documents/documents.service.js';
import { cleanFileName, fileType, FileTooLargeError } from '../documents/file-store.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { TransmittalService } from '../dms/transmittal.service.js';
import { audit } from '../tender/tender-records.js';
import type { PortalClaims } from './portal-auth.service.js';
import { submissionNumber, type PortalKind } from './portal-rules.js';

type Db = Sql | TransactionSql;
const INVOICE_MAX = 10 * 1024 * 1024;
const INVOICE_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const notFound = () => new NotFoundException({ code: 'not_found', message: 'Not found.' });

export interface PortalQuoteInput {
  validUntil: string | null;
  reference: string;
  gstMode: 'extra' | 'included' | 'exempt';
  gstPct: string;
  terms: string;
  lines: { lineId: string; rate: string; remark: string }[];
}

@Injectable()
export class PortalService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly documents: DocumentsService,
    private readonly transmittals: TransmittalService,
  ) {}

  private only(c: PortalClaims, ...kinds: PortalKind[]) {
    if (!kinds.includes(c.pk))
      throw new ForbiddenException({ code: 'forbidden', message: 'Not on this portal.' });
  }

  private db(c: PortalClaims) {
    return this.tenants.forTenant(c.ten);
  }

  /** The kind of order each portal shows: supply orders to vendors, work orders to subcontractors. */
  private orderKind(c: PortalClaims) {
    return c.pk === 'subcontractor' ? 'work' : 'purchase';
  }

  // --- enquiries and quotes (vendor) ---

  async enquiries(c: PortalClaims) {
    this.only(c, 'vendor', 'subcontractor');
    const db = await this.db(c);
    return db`
      SELECT r.id, r.number, r.title, to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn", v.status AS "vendorStatus",
        (SELECT count(*)::int FROM tender.rfq_line l WHERE l.rfq_id = r.id) AS lines,
        (SELECT s.status FROM portal.submission s WHERE s.rfq_id = r.id AND s.party_id = ${c.party}
          ORDER BY s.created_at DESC LIMIT 1) AS "lastSubmission"
      FROM tender.rfq_vendor v JOIN tender.rfq r ON r.id = v.rfq_id
      WHERE v.party_id = ${c.party} AND r.status = 'sent' AND v.status IN ('sent', 'quoted')
      ORDER BY r.due_on NULLS LAST, r.number`;
  }

  private async enquiryRow(db: Db, c: PortalClaims, rfqId: string) {
    const [r] = await db<
      { id: string; number: string; title: string; due_on: string | null; owner_id: string }[]
    >`
      SELECT r.id, r.number, r.title, to_char(r.due_on, 'YYYY-MM-DD') AS due_on, r.owner_id
      FROM tender.rfq r JOIN tender.rfq_vendor v ON v.rfq_id = r.id AND v.party_id = ${c.party}
      WHERE r.id = ${rfqId} AND r.status = 'sent' AND v.status IN ('sent', 'quoted')`;
    if (!r) throw notFound();
    return r;
  }

  async enquiry(c: PortalClaims, rfqId: string) {
    this.only(c, 'vendor', 'subcontractor');
    const db = await this.db(c);
    const r = await this.enquiryRow(db, c, rfqId);
    const lines = await db`
      SELECT l.id, l.seq, l.description, l.unit, l.qty::text AS qty,
        (SELECT ql.rate::text FROM tender.rfq_quote q JOIN tender.rfq_quote_line ql ON ql.quote_id = q.id
          WHERE q.rfq_id = ${rfqId} AND q.party_id = ${c.party} AND ql.line_id = l.id) AS "myRate"
      FROM tender.rfq_line l WHERE l.rfq_id = ${rfqId} ORDER BY l.seq`;
    return {
      id: r.id,
      number: r.number,
      title: r.title,
      dueOn: r.due_on,
      lines,
      submissions: await this.submissionsWhere(db, c, db`s.rfq_id = ${rfqId}`),
    };
  }

  async submitQuote(c: PortalClaims, rfqId: string, input: PortalQuoteInput) {
    this.only(c, 'vendor', 'subcontractor');
    const db = await this.db(c);
    const r = await this.enquiryRow(db, c, rfqId);
    if (r.due_on && r.due_on < today())
      throw new ConflictException({
        code: 'due_passed',
        message: 'Quotes for this enquiry were due on ' + r.due_on + '.',
      });
    const known = new Set(
      (await db<{ id: string }[]>`SELECT id FROM tender.rfq_line WHERE rfq_id = ${rfqId}`).map(
        (l) => l.id,
      ),
    );
    if (input.lines.some((l) => !known.has(l.lineId)))
      throw new BadRequestException({
        code: 'line_not_on_rfq',
        message: 'A line is not on this enquiry.',
      });
    if (new Set(input.lines.map((l) => l.lineId)).size !== input.lines.length)
      throw new BadRequestException({ code: 'duplicate_line', message: 'A line is quoted twice.' });
    return this.submit(db, c, {
      kind: 'quote',
      rfqId,
      orderId: null,
      projectId: null,
      payload: input,
      notify: [r.owner_id],
      title: `Quote for ${r.number} ${r.title}`,
    });
  }

  // --- orders, work orders, measurements, invoices ---

  async orders(c: PortalClaims) {
    this.only(c, 'vendor', 'subcontractor');
    const db = await this.db(c);
    return db`
      SELECT o.id, o.number, o.status, p.name AS project, rv.total::text AS total,
        to_char(o.acknowledged_on, 'YYYY-MM-DD') AS "acknowledgedOn", to_char(rv.deliver_by, 'YYYY-MM-DD') AS "deliverBy"
      FROM proc.purchase_order o JOIN proj.project p ON p.id = o.project_id
      JOIN proc.po_revision rv ON rv.po_id = o.id AND rv.status = 'approved'
      WHERE o.party_id = ${c.party} AND o.kind = ${this.orderKind(c)}
        AND o.status IN ('issued', 'acknowledged', 'closed')
      ORDER BY o.created_at DESC`;
  }

  private async orderRow(db: Db, c: PortalClaims, orderId: string) {
    const [o] = await db<
      {
        id: string;
        number: string;
        status: string;
        project_id: string;
        project: string;
        revision_id: string;
        created_by: string | null;
      }[]
    >`
      SELECT o.id, o.number, o.status, o.project_id, p.name AS project, rv.id AS revision_id, o.created_by
      FROM proc.purchase_order o JOIN proj.project p ON p.id = o.project_id
      JOIN proc.po_revision rv ON rv.po_id = o.id AND rv.status = 'approved'
      WHERE o.id = ${orderId} AND o.party_id = ${c.party} AND o.kind = ${this.orderKind(c)}
        AND o.status IN ('issued', 'acknowledged', 'closed')`;
    if (!o) throw notFound();
    return o;
  }

  async order(c: PortalClaims, orderId: string) {
    this.only(c, 'vendor', 'subcontractor');
    const db = await this.db(c);
    const o = await this.orderRow(db, c, orderId);
    const [head] = await db`
      SELECT to_char(rv.deliver_by, 'YYYY-MM-DD') AS "deliverBy", rv.payment_terms AS "paymentTerms",
        rv.delivery_terms AS "deliveryTerms", rv.other_terms AS "otherTerms", rv.subtotal::text AS subtotal,
        rv.total::text AS total, to_char(po.acknowledged_on, 'YYYY-MM-DD') AS "acknowledgedOn",
        po.acknowledged_ref AS "acknowledgedRef"
      FROM proc.po_revision rv JOIN proc.purchase_order po ON po.id = rv.po_id WHERE rv.id = ${o.revision_id}`;
    const lines = await db`
      SELECT l.line_key AS "lineKey", l.position, l.description, l.unit, l.qty::text AS qty, l.rate::text AS rate,
        l.amount::text AS amount,
        coalesce((SELECT sum(m.qty) FROM acc.wo_measurement m WHERE m.order_id = ${o.id} AND m.line_key = l.line_key),
          0)::text AS measured
      FROM proc.po_line l WHERE l.revision_id = ${o.revision_id} ORDER BY l.position`;
    return {
      id: o.id,
      number: o.number,
      status: o.status,
      project: o.project,
      ...head,
      lines,
      mayAcknowledge: o.status === 'issued',
      submissions: await this.submissionsWhere(db, c, db`s.order_id = ${o.id}`),
    };
  }

  /** The vendor accepts the order: their own act, recorded as theirs. */
  async acknowledge(c: PortalClaims, orderId: string, reference: string) {
    this.only(c, 'vendor', 'subcontractor');
    const db = await this.db(c);
    const o = await this.orderRow(db, c, orderId);
    const [me] = await db<{ name: string }[]>`SELECT name FROM portal."user" WHERE id = ${c.sub}`;
    const ref = `Portal: ${me?.name ?? 'portal user'}${reference ? `, ${reference}` : ''}`.slice(
      0,
      200,
    );
    await db.begin(async (tx) => {
      const [u] = await tx`
        UPDATE proc.purchase_order SET status = 'acknowledged', acknowledged_on = ${today()},
          acknowledged_ref = ${ref}, updated_at = now(), row_version = row_version + 1
        WHERE id = ${o.id} AND status = 'issued' RETURNING id`;
      if (!u)
        throw new ConflictException({
          code: 'not_issued',
          message: 'Only an issued order is acknowledged.',
        });
      await audit(tx, c.sub, 'portal.acknowledge', 'purchase_order', o.id, { reference: ref });
      if (o.created_by)
        await tx`INSERT INTO platform.notification (user_id, kind, title, link)
          VALUES (${o.created_by}, 'portal', ${`${o.number} acknowledged on the portal`}, ${`/orders/${o.id}`})`;
    });
    return this.order(c, orderId);
  }

  async submitMeasurement(
    c: PortalClaims,
    orderId: string,
    input: { measuredOn: string; lines: { lineKey: string; qty: string; description: string }[] },
  ) {
    this.only(c, 'subcontractor');
    const db = await this.db(c);
    const o = await this.orderRow(db, c, orderId);
    if (input.measuredOn > today())
      throw new BadRequestException({
        code: 'measured_in_future',
        message: 'Measure work that is done.',
      });
    const keys = new Set(
      (
        await db<{ k: string }[]>`
          SELECT line_key::text AS k FROM proc.po_line WHERE revision_id = ${o.revision_id}`
      ).map((r) => r.k),
    );
    if (input.lines.some((l) => !keys.has(l.lineKey)))
      throw new BadRequestException({
        code: 'not_an_order_line',
        message: `Not a line of ${o.number}.`,
      });
    return this.submit(db, c, {
      kind: 'measurement',
      rfqId: null,
      orderId: o.id,
      projectId: o.project_id,
      payload: input,
      notify: await this.projectLeads(db, o.project_id, o.created_by),
      title: `Measurement for ${o.number}`,
    });
  }

  async submitInvoice(
    c: PortalClaims,
    orderId: string,
    input: { invoiceNo: string; invoiceDate: string; amount: string },
    file: { name: string; stream: Readable; truncated: () => boolean },
  ) {
    this.only(c, 'vendor', 'subcontractor');
    const db = await this.db(c);
    const o = await this.orderRow(db, c, orderId);
    const store = await this.documents.store(c.ten);
    const tooLarge = () =>
      new BadRequestException({ code: 'too_large', message: 'An invoice file is at most 10 MB.' });
    const staged = await store.stage(file.stream, INVOICE_MAX).catch((e: unknown) => {
      throw e instanceof FileTooLargeError ? tooLarge() : e;
    });
    if (file.truncated()) {
      await store.discard(staged);
      throw tooLarge();
    }
    const name = cleanFileName(file.name) || 'invoice';
    const mime = fileType(staged.head, name);
    if (!INVOICE_TYPES.has(mime)) {
      await store.discard(staged);
      throw new BadRequestException({
        code: 'not_an_invoice_file',
        message: 'Send the invoice as a PDF or a photo.',
      });
    }
    const key = await store.commit(staged);
    return this.submit(db, c, {
      kind: 'invoice',
      rfqId: null,
      orderId: o.id,
      projectId: o.project_id,
      payload: input,
      file: { key, name, mime, size: staged.size },
      notify: await this.projectLeads(db, o.project_id, o.created_by),
      title: `Invoice ${input.invoiceNo} for ${o.number}`,
    });
  }

  /** Who hears of a submission on a project: its leads, else whoever raised the order. */
  private async projectLeads(db: Db, projectId: string, fallback: string | null) {
    const leads = (
      await db<{ user_id: string }[]>`
        SELECT user_id FROM proj.member WHERE project_id = ${projectId} AND role = 'lead'`
    ).map((r) => r.user_id);
    return leads.length ? leads : fallback ? [fallback] : [];
  }

  private async submit(
    db: Sql,
    c: PortalClaims,
    s: {
      kind: 'quote' | 'measurement' | 'invoice';
      rfqId: string | null;
      orderId: string | null;
      projectId: string | null;
      payload: unknown;
      file?: { key: string; name: string; mime: string; size: number };
      notify: string[];
      title: string;
    },
  ) {
    const id = await db.begin(async (tx) => {
      const [row] = await tx<{ id: string; seq: string }[]>`
        INSERT INTO portal.submission (user_id, party_id, kind, rfq_id, order_id, project_id, payload, storage_key,
          file_name, mime, size_bytes)
        VALUES (${c.sub}, ${c.party}, ${s.kind}, ${s.rfqId}, ${s.orderId}, ${s.projectId},
          ${tx.json(JSON.parse(JSON.stringify(s.payload)))}, ${s.file?.key ?? null}, ${s.file?.name ?? null},
          ${s.file?.mime ?? null}, ${s.file?.size ?? null})
        RETURNING id, seq::text`;
      const [party] = await tx<
        { name: string }[]
      >`SELECT name FROM platform.party WHERE id = ${c.party}`;
      for (const userId of new Set(s.notify))
        await tx`INSERT INTO platform.notification (user_id, kind, title, link, source)
          VALUES (${userId}, 'portal', ${`${submissionNumber(row!.seq)} from ${party?.name ?? 'a portal user'}: ${s.title}`},
                  ${`/portal-submissions?id=${row!.id}`}, ${`portal:${row!.id}`})`;
      await audit(tx, c.sub, `portal.submit_${s.kind}`, 'portal_submission', row!.id, {});
      return row!.id;
    });
    const [made] = await this.submissionsWhere(db, c, db`s.id = ${id}`);
    return made;
  }

  async submissions(c: PortalClaims) {
    const db = await this.db(c);
    return this.submissionsWhere(db, c, db`true`);
  }

  private submissionsWhere(db: Db, c: PortalClaims, where: ReturnType<Db>) {
    return db<
      {
        id: string;
        number: string;
        kind: string;
        status: string;
        reason: string;
        about: string | null;
        createdAt: Date;
        decidedAt: Date | null;
      }[]
    >`
      SELECT s.id, 'PS-' || lpad(s.seq::text, 6, '0') AS number, s.kind, s.status, s.reason,
        coalesce(r.number, o.number) AS about, s.created_at AS "createdAt", s.decided_at AS "decidedAt"
      FROM portal.submission s LEFT JOIN tender.rfq r ON r.id = s.rfq_id
      LEFT JOIN proc.purchase_order o ON o.id = s.order_id
      WHERE s.party_id = ${c.party} AND ${where}
      ORDER BY s.created_at DESC LIMIT 200`;
  }

  // --- bills and payments (vendor, subcontractor) ---

  async bills(c: PortalClaims) {
    this.only(c, 'vendor', 'subcontractor');
    const db = await this.db(c);
    const bills = await db`
      SELECT b.bill_no AS "billNo", to_char(b.bill_date, 'YYYY-MM-DD') AS "billDate",
        to_char(b.due_date, 'YYYY-MM-DD') AS "dueDate", o.number AS "order", b.total::text AS total,
        b.tds::text AS tds, b.payable::text AS payable, b.status,
        (b.payable
          - coalesce((SELECT sum(l.amount) FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
              WHERE l.bill_id = b.id AND r.status = 'paid'), 0)
          - coalesce((SELECT sum(a.amount) FROM acc.advance_application a WHERE a.bill_id = b.id), 0)
          - coalesce((SELECT sum(d.total) FROM acc.debit_note d WHERE d.bill_id = b.id), 0))::numeric(20,2)::text
          AS outstanding,
        (SELECT to_char(max(r.paid_on), 'YYYY-MM-DD') FROM acc.payment_run_line l
          JOIN acc.payment_run r ON r.id = l.run_id WHERE l.bill_id = b.id AND r.status = 'paid') AS "lastPaidOn"
      FROM acc.vendor_bill b LEFT JOIN proc.purchase_order o ON o.id = b.order_id
      WHERE b.party_id = ${c.party} AND b.status <> 'cancelled'
      ORDER BY b.bill_date DESC LIMIT 500`;
    const raBills =
      c.pk === 'subcontractor'
        ? await db`
          SELECT o.number AS "order", sb.ra_no AS "raNo", to_char(sb.upto, 'YYYY-MM-DD') AS upto, sb.status,
            sb.figures->>'gross' AS gross, sb.figures->>'net' AS net
          FROM acc.subcontract_bill sb JOIN proc.purchase_order o ON o.id = sb.order_id
          WHERE o.party_id = ${c.party} AND sb.status IN ('pending', 'certified')
          ORDER BY o.number, sb.ra_no`
        : [];
    return { bills, raBills };
  }

  // --- the client's view ---

  private async clientProject(db: Db, c: PortalClaims, projectId: string) {
    const [p] = await db<{ id: string }[]>`
      SELECT id FROM proj.project WHERE id = ${projectId} AND client_id = ${c.party}`;
    if (!p) throw notFound();
  }

  async projects(c: PortalClaims) {
    this.only(c, 'client');
    const db = await this.db(c);
    return db`
      SELECT p.id, p.number, p.name, p.status, p.contract_value::text AS "contractValue",
        coalesce((SELECT sum((b.submitted->>'invoiceTotal')::numeric) FROM acc.client_bill b
          WHERE b.project_id = p.id AND b.status IN ('submitted', 'certified')), 0)::numeric(20,2)::text AS billed,
        coalesce((SELECT sum((b.certified->>'invoiceTotal')::numeric) FROM acc.client_bill b
          WHERE b.project_id = p.id AND b.status = 'certified'), 0)::numeric(20,2)::text AS certified,
        coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a
          JOIN acc.client_receipt r ON r.id = a.receipt_id AND r.status = 'posted'
          WHERE a.project_id = p.id), 0)::numeric(20,2)::text AS received
      FROM proj.project p WHERE p.client_id = ${c.party}
      ORDER BY p.name`;
  }

  async project(c: PortalClaims, projectId: string) {
    this.only(c, 'client');
    const db = await this.db(c);
    await this.clientProject(db, c, projectId);
    const [summary] = (await this.projects(c)).filter((p) => p.id === projectId);
    const bills = await db`
      SELECT b.id, b.ra_no AS "raNo", to_char(b.upto, 'YYYY-MM-DD') AS upto, b.status,
        b.submitted->>'invoiceTotal' AS submitted, b.certified->>'invoiceTotal' AS certified,
        b.certified->>'net' AS "certifiedNet", to_char(b.certified_on, 'YYYY-MM-DD') AS "certifiedOn",
        coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a
          JOIN acc.client_receipt r ON r.id = a.receipt_id AND r.status = 'posted'
          WHERE a.bill_id = b.id), 0)::numeric(20,2)::text AS received
      FROM acc.client_bill b WHERE b.project_id = ${projectId} AND b.status IN ('submitted', 'certified')
      ORDER BY b.ra_no`;
    const photos = await db`
      SELECT ph.id, ph.caption, to_char(r.report_date, 'YYYY-MM-DD') AS "reportDate", s.name AS site
      FROM proj.dr_photo ph JOIN proj.daily_report r ON r.id = ph.report_id JOIN proj.site s ON s.id = r.site_id
      WHERE r.project_id = ${projectId} AND ph.removed_at IS NULL
        AND r.report_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 30
      ORDER BY r.report_date DESC, ph.created_at DESC LIMIT 60`;
    return { ...summary, bills, photos };
  }

  async photo(c: PortalClaims, projectId: string, photoId: string) {
    this.only(c, 'client');
    const db = await this.db(c);
    await this.clientProject(db, c, projectId);
    const [p] = await db<{ storage_key: string; mime: string; size_bytes: number }[]>`
      SELECT ph.storage_key, ph.mime, ph.size_bytes FROM proj.dr_photo ph
      JOIN proj.daily_report r ON r.id = ph.report_id
      WHERE ph.id = ${photoId} AND r.project_id = ${projectId} AND ph.removed_at IS NULL`;
    if (!p) throw notFound();
    const store = await this.documents.store(c.ten);
    return { stream: await store.open(p.storage_key), mime: p.mime, size: p.size_bytes };
  }

  // --- transmittals addressed to the client ---

  transmittalList(c: PortalClaims) {
    this.only(c, 'client');
    return this.transmittals.forParty(c.ten, c.party);
  }

  transmittal(c: PortalClaims, id: string) {
    this.only(c, 'client');
    return this.transmittals.partyView(c.ten, c.party, id);
  }

  transmittalFile(c: PortalClaims, id: string, itemId: string) {
    this.only(c, 'client');
    return this.transmittals.partyFile(c.ten, c.party, id, itemId);
  }

  async acknowledgeTransmittal(c: PortalClaims, id: string) {
    this.only(c, 'client');
    return this.transmittals.partyAcknowledge(c.ten, c.party, id, await this.name(c));
  }

  async respondTransmittal(
    c: PortalClaims,
    id: string,
    input: { response: string; code: string | null },
  ) {
    this.only(c, 'client');
    return this.transmittals.partyRespond(c.ten, c.party, id, {
      ...input,
      name: await this.name(c),
    });
  }

  private async name(c: PortalClaims) {
    const db = await this.db(c);
    const [me] = await db<{ name: string }[]>`SELECT name FROM portal."user" WHERE id = ${c.sub}`;
    return `${me?.name ?? 'Portal user'} (portal)`;
  }
}
