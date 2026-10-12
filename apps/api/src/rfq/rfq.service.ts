// Enquiries to vendors and subcontractors (docs/04-features.md E8, docs/wave1-plan.md step 9): an RFQ on a tender,
// its lines (BOQ items, rate-library resources, or free text), the vendors asked, their quotes (typed in or imported
// from the filled enquiry workbook), the comparative statement, the choice per line, and the chosen rates put into
// the estimate. Changes need `rfq.edit`; putting rates into a BOQ also needs `boq.edit`, into the rate library
// `rates.edit`.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SUBTREE_END } from '@aerolith/shared';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { BoqService } from '../boq/boq.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { linkedDocuments, rfqVendorTarget } from '../documents/links.js';
import { dec, fmt, mul } from '../rates/decimal.js';
import { RatesService } from '../rates/rates.service.js';
import { nextNumber } from '../tender/numbering.js';
import { audit, event } from '../tender/tender-records.js';
import type { Patch } from '../tender/tender.service.js';
import { enquiryWorkbook, readQuoteWorkbook } from './rfq-files.js';
import { basicRate, comparativeStatement, rateToApply, type GstMode } from './rfq-rules.js';

export type RfqKind = 'work' | 'material';
export type RfqStatus = 'draft' | 'sent' | 'closed' | 'cancelled';
const MAX_LINES = 2000;

export interface QuoteInput {
  receivedOn: string;
  validUntil: string | null;
  reference: string | null;
  gstMode: GstMode;
  gstPct: string;
  terms: string;
  lines: { lineId: string; rate: string; remark: string }[];
  /** False corrects the quote already in (a typing slip) instead of keeping it as a negotiation round. */
  newRound?: boolean;
}

const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const fileSafe = (s: string) => s.replace(/[^\w.\- ()&]+/g, '_').trim();

@Injectable()
export class RfqService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly boqs: BoqService,
    private readonly rates: RatesService,
  ) {}

  async list(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT r.id, r.number, r.title, r.kind, to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn", r.status,
        (SELECT count(*)::int FROM tender.rfq_line l WHERE l.rfq_id = r.id) AS lines,
        (SELECT count(*)::int FROM tender.rfq_vendor v WHERE v.rfq_id = r.id) AS vendors,
        (SELECT count(*)::int FROM tender.rfq_quote q WHERE q.rfq_id = r.id) AS quotes
      FROM tender.rfq r WHERE r.tender_id = ${tenderId} ORDER BY r.created_at`;
  }

  /** The RFQ with its lines, vendors, quotes and comparative statement. */
  async get(claims: TenantClaims, rfqId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [rfq] = await db<
      {
        id: string;
        tenderId: string | null;
        projectId: string | null;
        number: string;
        title: string;
        kind: RfqKind;
        dueOn: string | null;
        status: RfqStatus;
        terms: string;
        rowVersion: number;
        tender: { id: string; number: string; title: string } | null;
        project: { id: string; number: string; name: string } | null;
      }[]
    >`
      SELECT r.id, r.tender_id AS "tenderId", r.project_id AS "projectId", r.number, r.title, r.kind,
        to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn", r.status, r.terms, r.row_version AS "rowVersion",
        CASE WHEN t.id IS NULL THEN NULL
          ELSE json_build_object('id', t.id, 'number', t.number, 'title', t.title) END AS tender,
        CASE WHEN p.id IS NULL THEN NULL
          ELSE json_build_object('id', p.id, 'number', p.number, 'name', p.name) END AS project
      FROM tender.rfq r LEFT JOIN tender.tender t ON t.id = r.tender_id
      LEFT JOIN proj.project p ON p.id = r.project_id WHERE r.id = ${rfqId}`;
    if (!rfq) throw new NotFoundException({ code: 'rfq_not_found' });
    const [lines, vendors, rates] = await Promise.all([
      db<
        {
          id: string;
          seq: number;
          boqId: string | null;
          boqName: string | null;
          resourceId: string | null;
          code: string | null;
          description: string;
          unit: string | null;
          qty: string | null;
          selectedPartyId: string | null;
          selectionNote: string;
          ourRate: string | null;
          gone: boolean;
        }[]
      >`
        SELECT l.id, l.seq, l.boq_id AS "boqId", b.name AS "boqName", l.resource_id AS "resourceId", l.code,
          l.description, l.unit, l.qty::text AS qty, l.selected_party_id AS "selectedPartyId",
          l.selection_note AS "selectionNote",
          CASE
            WHEN l.line_key IS NOT NULL THEN (SELECT n.rate::text FROM est.boq_node n
              WHERE n.boq_id = l.boq_id AND n.line_key = l.line_key)
            WHEN l.resource_id IS NOT NULL THEN (SELECT rr.rate::text FROM est.resource_rate rr
              WHERE rr.resource_id = l.resource_id AND rr.effective_from <= (now() AT TIME ZONE 'Asia/Kolkata')::date
              ORDER BY rr.effective_from DESC LIMIT 1)
          END AS "ourRate",
          (l.line_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM est.boq_node n
            WHERE n.boq_id = l.boq_id AND n.line_key = l.line_key)) AS gone
        FROM tender.rfq_line l LEFT JOIN est.boq b ON b.id = l.boq_id
        WHERE l.rfq_id = ${rfqId} ORDER BY l.seq`,
      db<
        {
          partyId: string;
          name: string;
          email: string | null;
          phone: string | null;
          status: string;
          sentOn: string | null;
          notes: string;
          quote: {
            receivedOn: string;
            validUntil: string | null;
            reference: string | null;
            gstMode: GstMode;
            gstPct: string;
            terms: string;
            source: string;
            fileName: string | null;
            round: number;
          } | null;
        }[]
      >`
        SELECT v.party_id AS "partyId", p.name, p.email, p.phone, v.status, to_char(v.sent_on, 'YYYY-MM-DD') AS "sentOn",
          v.notes,
          CASE WHEN q.id IS NULL THEN NULL ELSE json_build_object(
            'receivedOn', to_char(q.received_on, 'YYYY-MM-DD'), 'validUntil', to_char(q.valid_until, 'YYYY-MM-DD'),
            'reference', q.reference, 'gstMode', q.gst_mode, 'gstPct', q.gst_pct::text, 'terms', q.terms,
            'source', q.source, 'fileName', q.file_name, 'round', q.round) END AS quote
        FROM tender.rfq_vendor v JOIN platform.party p ON p.id = v.party_id
        LEFT JOIN tender.rfq_quote q ON q.rfq_id = v.rfq_id AND q.party_id = v.party_id
        WHERE v.rfq_id = ${rfqId} ORDER BY lower(p.name)`,
      db<{ partyId: string; lineId: string; rate: string; remark: string }[]>`
        SELECT q.party_id AS "partyId", ql.line_id AS "lineId", ql.rate::text AS rate, ql.remark
        FROM tender.rfq_quote_line ql JOIN tender.rfq_quote q ON q.id = ql.quote_id WHERE q.rfq_id = ${rfqId}`,
    ]);
    const quotes = vendors
      .filter((v) => v.quote)
      .map((v) => ({
        partyId: v.partyId,
        name: v.name,
        gstMode: v.quote!.gstMode,
        gstPct: v.quote!.gstPct,
        rates: new Map(
          rates
            .filter((r) => r.partyId === v.partyId)
            .map((r) => [r.lineId, { rate: r.rate, remark: r.remark }]),
        ),
      }));
    const cs = comparativeStatement(lines, quotes);
    // A project's RFQ: which approved requisitions each line asks for.
    const asked = rfq.projectId
      ? await db<{ lineId: string; requisitionId: string; number: string; qty: string }[]>`
          SELECT x.rfq_line_id AS "lineId", x.requisition_id AS "requisitionId", q.number, sum(x.qty)::text AS qty
          FROM proc.rfq_requisition_line x JOIN tender.rfq_line l ON l.id = x.rfq_line_id
          JOIN proc.requisition q ON q.id = x.requisition_id
          WHERE l.rfq_id = ${rfqId} GROUP BY 1, 2, 3 ORDER BY 3`
      : [];
    // Negotiation: each vendor's rounds (earlier quotes, then the current one), with every rate before GST so rounds
    // quoted differently compare, and what each came to.
    const earlier = await db<
      {
        partyId: string;
        round: number;
        receivedOn: string;
        gstMode: GstMode;
        gstPct: string;
        rates: Record<string, { rate: string }>;
      }[]
    >`
      SELECT party_id AS "partyId", round, to_char(received_on, 'YYYY-MM-DD') AS "receivedOn", gst_mode AS "gstMode",
        gst_pct::text AS "gstPct", rates
      FROM tender.rfq_quote_round WHERE rfq_id = ${rfqId} ORDER BY party_id, round`;
    const qty = new Map(lines.map((l) => [l.id, l.qty]));
    const round = (
      partyId: string,
      n: number,
      receivedOn: string,
      mode: GstMode,
      pct: string,
      quoted: [string, string][],
    ) => {
      const basic = quoted.map(([lineId, rate]) => [lineId, fmt(basicRate(rate, mode, pct), 4)]);
      const total = basic.reduce((a, [lineId, b]) => {
        const q = qty.get(lineId!);
        return q ? a + dec(fmt(mul(dec(b!), dec(q)), 2)) : a;
      }, 0n);
      return {
        partyId,
        round: n,
        receivedOn,
        gstMode: mode,
        rates: Object.fromEntries(basic) as Record<string, string>,
        total: fmt(total, 2),
      };
    };
    const rounds = [
      ...earlier.map((e) =>
        round(
          e.partyId,
          e.round,
          e.receivedOn,
          e.gstMode,
          e.gstPct,
          Object.entries(e.rates).map(([k, v]) => [k, v.rate]),
        ),
      ),
      ...vendors
        .filter((v) => v.quote && v.quote.round > 1)
        .map((v) =>
          round(
            v.partyId,
            v.quote!.round,
            v.quote!.receivedOn,
            v.quote!.gstMode,
            v.quote!.gstPct,
            rates.filter((r) => r.partyId === v.partyId).map((r) => [r.lineId, r.rate]),
          ),
        ),
    ].sort((a, b) => a.partyId.localeCompare(b.partyId) || a.round - b.round);
    const docs = await linkedDocuments(
      db,
      'rfq_vendor',
      vendors.map((v) => rfqVendorTarget(rfqId, v.partyId)),
      await this.permissions.can(claims, 'pricing.edit'),
    );
    return {
      ...rfq,
      lines: cs.lines.map((l, i) => ({
        ...l,
        gone: lines[i]!.gone,
        requisitions: asked.filter((a) => a.lineId === l.id).map(({ lineId: _, ...a }) => a),
      })),
      vendors: vendors.map((v) => ({
        ...v,
        documents: docs.get(rfqVendorTarget(rfqId, v.partyId)) ?? [],
      })),
      cs: { vendors: cs.vendors, totals: cs.totals },
      rounds,
    };
  }

  async create(
    claims: TenantClaims,
    tenderId: string,
    input: { title: string; kind: RfqKind; dueOn: string | null; terms: string },
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [t] = await db<{ entity_id: string }[]>`
      SELECT entity_id FROM tender.tender WHERE id = ${tenderId}`;
    if (!t) throw new NotFoundException({ code: 'tender_not_found' });
    const id = await this.insert(
      claims,
      { tender_id: tenderId, project_id: null },
      t.entity_id,
      input,
      now,
    );
    return this.get(claims, id);
  }

  /** An enquiry for a project (Wave 2b step 3): its team, with `rfq.edit`. */
  async createForProject(
    claims: TenantClaims,
    projectId: string,
    input: {
      title: string;
      kind: RfqKind;
      dueOn: string | null;
      terms: string;
      requisitionIds: string[];
    },
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<{ entity_id: string }[]>`
      SELECT entity_id FROM proj.project WHERE id = ${projectId}`;
    if (!p) throw new NotFoundException({ code: 'project_not_found' });
    // Checked before anything is made, so a refused requisition leaves no empty RFQ behind.
    if (input.requisitionIds.length) await checkRequisitions(db, projectId, input.requisitionIds);
    const id = await this.insert(
      claims,
      { tender_id: null, project_id: projectId },
      p.entity_id,
      input,
      now,
    );
    if (input.requisitionIds.length)
      await this.addLines(claims, id, { requisitionIds: input.requisitionIds });
    return this.get(claims, id);
  }

  private async insert(
    claims: TenantClaims,
    owner: { tender_id: string | null; project_id: string | null },
    entityId: string,
    input: { title: string; kind: RfqKind; dueOn: string | null; terms: string },
    now: Date,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const number = await nextNumber(tx, 'rfq', entityId, 'RFQ', now);
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO tender.rfq (tender_id, project_id, number, title, kind, due_on, terms, owner_id, created_by,
          updated_by)
        VALUES (${owner.tender_id}, ${owner.project_id}, ${number}, ${input.title}, ${input.kind}, ${input.dueOn},
          ${input.terms}, ${claims.sub}, ${claims.sub}, ${claims.sub})
        RETURNING id`;
      await rfqEvent(tx, owner, 'rfq_created', { number, title: input.title }, claims.sub);
      return row!.id;
    });
  }

  async listForProject(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT r.id, r.number, r.title, r.kind, to_char(r.due_on, 'YYYY-MM-DD') AS "dueOn", r.status,
        (SELECT count(*)::int FROM tender.rfq_line l WHERE l.rfq_id = r.id) AS lines,
        (SELECT count(*)::int FROM tender.rfq_vendor v WHERE v.rfq_id = r.id) AS vendors,
        (SELECT count(*)::int FROM tender.rfq_quote q WHERE q.rfq_id = r.id) AS quotes,
        (SELECT count(*)::int FROM tender.rfq_line l WHERE l.rfq_id = r.id AND l.selected_party_id IS NOT NULL)
          AS chosen
      FROM tender.rfq r WHERE r.project_id = ${projectId} ORDER BY r.created_at DESC`;
  }

  async update(
    claims: TenantClaims,
    rfqId: string,
    rowVersion: number,
    input: Patch<{ title: string; dueOn: string | null; terms: string; status: RfqStatus }>,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const r = await this.lock(tx, rfqId, { allowClosed: true });
      if (r.row_version !== rowVersion) throw stale();
      const cols = Object.fromEntries(
        Object.entries({
          title: input.title,
          due_on: input.dueOn,
          terms: input.terms,
          status: input.status,
        }).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      await tx`UPDATE tender.rfq SET ${tx({ ...cols, updated_by: claims.sub })}, updated_at = now(),
        row_version = row_version + 1 WHERE id = ${rfqId}`;
      if (input.status && input.status !== r.status)
        await rfqEvent(
          tx,
          r,
          'rfq_status',
          { number: r.number, from: r.status, to: input.status },
          claims.sub,
        );
      await rescheduleRfq(tx, rfqId, new Date());
    });
    return this.get(claims, rfqId);
  }

  // --- lines ---

  /**
   * Adds lines: BOQ items (a section brings every item under it), rate-library resources, or one free line. Items
   * and resources already on the RFQ are not added twice. Each line keeps what was asked as asked.
   */
  async addLines(
    claims: TenantClaims,
    rfqId: string,
    input: {
      boqId?: string | undefined;
      nodeIds?: string[] | undefined;
      resourceIds?: string[] | undefined;
      free?:
        | { code: string | null; description: string; unit: string | null; qty: string | null }
        | undefined;
      /** A project's approved requisitions: their lines, a material once with its quantities added up. */
      requisitionIds?: string[] | undefined;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const added = await db.begin(async (tx) => {
      const r = await this.lock(tx, rfqId);
      type New = {
        boq_id: string | null;
        line_key: string | null;
        resource_id: string | null;
        code: string | null;
        description: string;
        unit: string | null;
        qty: string | null;
      };
      const rows: New[] = [];
      if (input.boqId && input.nodeIds?.length) {
        if (r.kind !== 'work')
          throw new BadRequestException({
            code: 'wrong_kind',
            message: 'BOQ items go into an RFQ for work.',
          });
        const [b] = await tx`SELECT 1 FROM est.boq WHERE id = ${input.boqId}
            AND (tender_id = ${r.tender_id} OR project_id = ${r.project_id})`;
        if (!b) throw new BadRequestException({ code: 'boq_not_on_tender' });
        const items = await tx<
          {
            line_key: string;
            code: string | null;
            description: string;
            unit: string | null;
            qty: string | null;
          }[]
        >`
          WITH picked AS (
            SELECT sort_key FROM est.boq_node WHERE boq_id = ${input.boqId} AND id = ANY(${input.nodeIds}::bigint[])
          )
          SELECT n.line_key, n.code, t.description, n.unit, n.qty::text AS qty
          FROM est.boq_node n JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
          WHERE n.boq_id = ${input.boqId} AND n.node_type = 'item'
            AND EXISTS (SELECT 1 FROM picked p WHERE n.sort_key >= p.sort_key AND n.sort_key < p.sort_key || ${SUBTREE_END})
            AND NOT EXISTS (SELECT 1 FROM tender.rfq_line x WHERE x.rfq_id = ${rfqId} AND x.line_key = n.line_key)
          ORDER BY n.sort_key LIMIT ${MAX_LINES + 1}`;
        for (const i of items)
          rows.push({
            boq_id: input.boqId,
            line_key: i.line_key,
            resource_id: null,
            code: i.code,
            description: i.description || '(no description)',
            unit: i.unit,
            qty: i.qty,
          });
      }
      if (input.resourceIds?.length) {
        if (r.kind !== 'material')
          throw new BadRequestException({
            code: 'wrong_kind',
            message: 'Resources go into an RFQ for materials.',
          });
        const res = await tx<{ id: string; code: string; name: string; unit: string }[]>`
          SELECT id, code, name, unit FROM est.resource WHERE id = ANY(${input.resourceIds}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM tender.rfq_line x WHERE x.rfq_id = ${rfqId} AND x.resource_id = est.resource.id)
          ORDER BY lower(code)`;
        for (const x of res)
          rows.push({
            boq_id: null,
            line_key: null,
            resource_id: x.id,
            code: x.code,
            description: x.name,
            unit: x.unit,
            qty: null,
          });
      }
      if (input.free) rows.push({ boq_id: null, line_key: null, resource_id: null, ...input.free });
      // From requisitions: added to the line already asking for the same material, or a new line; each remembers
      // which requisition lines it asks for.
      const links: {
        row: number | string;
        requisitionId: string;
        position: number;
        qty: string;
      }[] = [];
      if (input.requisitionIds?.length) {
        if (!r.project_id)
          throw new BadRequestException({
            code: 'not_for_tender',
            message: "Requisitions go into a project's enquiries.",
          });
        if (r.kind !== 'material')
          throw new BadRequestException({
            code: 'wrong_kind',
            message: 'Requisitions go into an RFQ for materials.',
          });
        await checkRequisitions(tx, r.project_id, input.requisitionIds);
        const reqLines = await tx<
          {
            requisition_id: string;
            position: number;
            resource_id: string | null;
            code: string | null;
            description: string;
            unit: string;
            qty: string;
          }[]
        >`
          SELECT l.requisition_id, l.position, l.resource_id, res.code, l.description, l.unit, l.qty::text AS qty
          FROM proc.requisition_line l LEFT JOIN est.resource res ON res.id = l.resource_id
          JOIN proc.requisition q ON q.id = l.requisition_id
          WHERE l.requisition_id = ANY(${input.requisitionIds}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM proc.rfq_requisition_line x JOIN tender.rfq_line rl ON rl.id = x.rfq_line_id
              WHERE rl.rfq_id = ${rfqId} AND x.requisition_id = l.requisition_id AND x.position = l.position)
          ORDER BY q.number, l.position`;
        const existing = await tx<{ id: string; resource_id: string }[]>`
          SELECT id, resource_id FROM tender.rfq_line WHERE rfq_id = ${rfqId} AND resource_id IS NOT NULL`;
        for (const l of reqLines) {
          const old = l.resource_id
            ? existing.find((e) => e.resource_id === l.resource_id)
            : undefined;
          if (old) {
            await tx`UPDATE tender.rfq_line SET qty = coalesce(qty, 0) + ${l.qty}::numeric WHERE id = ${old.id}`;
            links.push({
              row: old.id,
              requisitionId: l.requisition_id,
              position: l.position,
              qty: l.qty,
            });
            continue;
          }
          const k = l.resource_id ? rows.findIndex((x) => x.resource_id === l.resource_id) : -1;
          if (k >= 0) rows[k]!.qty = String(Number(rows[k]!.qty ?? 0) + Number(l.qty));
          else
            rows.push({
              boq_id: null,
              line_key: null,
              resource_id: l.resource_id,
              code: l.code,
              description: l.description,
              unit: l.unit,
              qty: l.qty,
            });
          links.push({
            row: k >= 0 ? k : rows.length - 1,
            requisitionId: l.requisition_id,
            position: l.position,
            qty: l.qty,
          });
        }
      }
      const [{ n, next }] = (await tx<{ n: number; next: number }[]>`
        SELECT count(*)::int AS n, coalesce(max(seq), 0) + 1 AS next FROM tender.rfq_line WHERE rfq_id = ${rfqId}`) as unknown as [
        { n: number; next: number },
      ];
      if (n + rows.length > MAX_LINES)
        throw new BadRequestException({
          code: 'too_many_lines',
          message: `An RFQ takes up to ${MAX_LINES} lines; split the package.`,
        });
      const ids = rows.length
        ? (
            await tx<{ id: string }[]>`INSERT INTO tender.rfq_line ${tx(
              rows.map((x, i) => ({ ...x, rfq_id: rfqId, seq: next + i })),
            )} RETURNING id`
          ).map((x) => x.id)
        : [];
      if (links.length)
        await tx`INSERT INTO proc.rfq_requisition_line ${tx(
          links.map((l) => ({
            rfq_line_id: typeof l.row === 'number' ? ids[l.row]! : l.row,
            requisition_id: l.requisitionId,
            position: l.position,
            qty: l.qty,
          })),
        )}`;
      await this.touch(tx, rfqId, claims);
      return rows.length;
    });
    return { added, rfq: await this.get(claims, rfqId) };
  }

  async updateLine(
    claims: TenantClaims,
    lineId: string,
    input: Patch<{
      code: string | null;
      description: string;
      unit: string | null;
      qty: string | null;
    }>,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const rfqId = await db.begin(async (tx) => {
      const id = await this.lineRfq(tx, lineId);
      await this.lock(tx, id);
      const cols = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      await tx`UPDATE tender.rfq_line SET ${tx(cols)} WHERE id = ${lineId}`;
      await this.touch(tx, id, claims);
      return id;
    });
    return this.get(claims, rfqId);
  }

  /** Removes a line (and its quoted rates); the rest keep their numbers, so files already sent still match. */
  async deleteLine(claims: TenantClaims, lineId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const rfqId = await db.begin(async (tx) => {
      const id = await this.lineRfq(tx, lineId);
      await this.lock(tx, id);
      await tx`DELETE FROM tender.rfq_line WHERE id = ${lineId}`;
      await this.touch(tx, id, claims);
      return id;
    });
    return this.get(claims, rfqId);
  }

  // --- vendors ---

  /** A vendor from the party master, or a new one by name (added as a vendor or subcontractor). */
  async addVendor(
    claims: TenantClaims,
    rfqId: string,
    input: {
      partyId: string | null;
      name: string | null;
      email: string | null;
      phone: string | null;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const r = await this.lock(tx, rfqId);
      const flag = r.kind === 'work' ? tx`is_subcontractor` : tx`is_vendor`;
      let partyId = input.partyId;
      if (partyId) {
        const [p] =
          await tx`UPDATE platform.party SET ${flag} = true WHERE id = ${partyId} AND deleted_at IS NULL
          RETURNING id`;
        if (!p) throw new BadRequestException({ code: 'party_not_found' });
      } else {
        const name = input.name?.trim();
        if (!name || name.length < 2) throw new BadRequestException({ code: 'name_required' });
        const [found] = await tx<{ id: string }[]>`
          UPDATE platform.party SET ${flag} = true WHERE lower(name) = lower(${name}) AND deleted_at IS NULL RETURNING id`;
        if (found) partyId = found.id;
        else {
          const [made] = await tx<{ id: string }[]>`
            INSERT INTO platform.party (name, is_vendor, is_subcontractor, email, phone, created_by, updated_by)
            VALUES (${name}, ${r.kind === 'material'}, ${r.kind === 'work'}, ${input.email}, ${input.phone},
              ${claims.sub}, ${claims.sub})
            RETURNING id`;
          partyId = made!.id;
          await audit(tx, claims.sub, 'party.create', 'party', partyId, { name, from: 'rfq' });
        }
      }
      await tx`INSERT INTO tender.rfq_vendor (rfq_id, party_id) VALUES (${rfqId}, ${partyId}) ON CONFLICT DO NOTHING`;
      await this.touch(tx, rfqId, claims);
    });
    return this.get(claims, rfqId);
  }

  async updateVendor(
    claims: TenantClaims,
    rfqId: string,
    partyId: string,
    input: Patch<{
      status: 'invited' | 'sent' | 'quoted' | 'declined';
      sentOn: string | null;
      notes: string;
    }>,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const r = await this.lock(tx, rfqId);
      const patch = { ...input };
      if (patch.status === 'sent') patch.sentOn ??= today();
      const cols = Object.fromEntries(
        Object.entries({ status: patch.status, sent_on: patch.sentOn, notes: patch.notes }).filter(
          ([, v]) => v !== undefined,
        ),
      );
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      const [v] =
        await tx`UPDATE tender.rfq_vendor SET ${tx(cols)} WHERE rfq_id = ${rfqId} AND party_id = ${partyId}
        RETURNING 1`;
      if (!v) throw new NotFoundException({ code: 'vendor_not_on_rfq' });
      // Sending to a vendor sends the RFQ.
      if (patch.status === 'sent' && r.status === 'draft')
        await tx`UPDATE tender.rfq SET status = 'sent' WHERE id = ${rfqId}`;
      await this.touch(tx, rfqId, claims);
    });
    return this.get(claims, rfqId);
  }

  async removeVendor(claims: TenantClaims, rfqId: string, partyId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.lock(tx, rfqId);
      const [q] =
        await tx`SELECT 1 FROM tender.rfq_quote WHERE rfq_id = ${rfqId} AND party_id = ${partyId}`;
      if (q)
        throw new ConflictException({
          code: 'vendor_quoted',
          message: 'This vendor has quoted; mark them declined instead of removing them.',
        });
      await tx`UPDATE tender.rfq_line SET selected_party_id = NULL WHERE rfq_id = ${rfqId} AND selected_party_id = ${partyId}`;
      await tx`DELETE FROM tender.rfq_vendor WHERE rfq_id = ${rfqId} AND party_id = ${partyId}`;
      await this.touch(tx, rfqId, claims);
    });
    return this.get(claims, rfqId);
  }

  /** The enquiry workbook for one vendor. */
  async pack(claims: TenantClaims, rfqId: string, partyId: string) {
    const rfq = await this.get(claims, rfqId);
    const vendor = rfq.vendors.find((v) => v.partyId === partyId);
    if (!vendor) throw new NotFoundException({ code: 'vendor_not_on_rfq' });
    if (rfq.lines.length === 0)
      throw new ConflictException({ code: 'no_lines', message: 'Add lines to the RFQ first.' });
    const buffer = await enquiryWorkbook({
      rfq,
      owner: rfq.tender
        ? { label: 'Tender', number: rfq.tender.number, title: rfq.tender.title }
        : { label: 'Project', number: rfq.project!.number, title: rfq.project!.name },
      vendor: { id: partyId, name: vendor.name },
      lines: rfq.lines,
    });
    return { buffer, fileName: `${fileSafe(`${rfq.number} ${vendor.name}`)}.xlsx` };
  }

  // --- quotes ---

  /** Saves a vendor's quote, replacing any earlier one; rates are as quoted (with GST if the quote includes it). */
  async saveQuote(
    claims: TenantClaims,
    rfqId: string,
    partyId: string,
    input: QuoteInput,
    source: 'typed' | 'file' = 'typed',
    fileName: string | null = null,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const r = await this.lock(tx, rfqId);
      const [v] = await tx<{ name: string }[]>`
        SELECT p.name FROM tender.rfq_vendor v JOIN platform.party p ON p.id = v.party_id
        WHERE v.rfq_id = ${rfqId} AND v.party_id = ${partyId}`;
      if (!v) throw new NotFoundException({ code: 'vendor_not_on_rfq' });
      const known = new Set(
        (await tx<{ id: string }[]>`SELECT id FROM tender.rfq_line WHERE rfq_id = ${rfqId}`).map(
          (l) => l.id,
        ),
      );
      const unknown = input.lines.filter((l) => !known.has(l.lineId));
      if (unknown.length)
        throw new BadRequestException({
          code: 'line_not_on_rfq',
          lines: unknown.map((l) => l.lineId),
        });
      if (new Set(input.lines.map((l) => l.lineId)).size !== input.lines.length)
        throw new BadRequestException({ code: 'duplicate_line' });
      // A quote already in becomes a negotiation round: its rates are kept, the new quote is the next round. A
      // correction replaces it and keeps its round.
      const [current] = await tx<{ round: number }[]>`
        SELECT round FROM tender.rfq_quote WHERE rfq_id = ${rfqId} AND party_id = ${partyId}`;
      const newRound = input.newRound !== false;
      const [kept] = !newRound
        ? []
        : await tx<{ round: number }[]>`
        INSERT INTO tender.rfq_quote_round (rfq_id, party_id, round, received_on, reference, gst_mode, gst_pct, source,
          rates, replaced_by)
        SELECT q.rfq_id, q.party_id, q.round, q.received_on, q.reference, q.gst_mode, q.gst_pct, q.source,
          coalesce((SELECT jsonb_object_agg(ql.line_id, jsonb_build_object('rate', ql.rate::text, 'remark', ql.remark))
            FROM tender.rfq_quote_line ql WHERE ql.quote_id = q.id), '{}'::jsonb), ${claims.sub}
        FROM tender.rfq_quote q WHERE q.rfq_id = ${rfqId} AND q.party_id = ${partyId}
        RETURNING round`;
      const round = kept ? kept.round + 1 : (current?.round ?? 1);
      await tx`DELETE FROM tender.rfq_quote WHERE rfq_id = ${rfqId} AND party_id = ${partyId}`;
      const [q] = await tx<{ id: string }[]>`
        INSERT INTO tender.rfq_quote (rfq_id, party_id, received_on, valid_until, reference, gst_mode, gst_pct, terms,
          source, file_name, created_by, updated_by, round)
        VALUES (${rfqId}, ${partyId}, ${input.receivedOn}, ${input.validUntil}, ${input.reference}, ${input.gstMode},
          ${input.gstPct}, ${input.terms}, ${source}, ${fileName}, ${claims.sub}, ${claims.sub}, ${round})
        RETURNING id`;
      if (input.lines.length)
        await tx`INSERT INTO tender.rfq_quote_line ${tx(
          input.lines.map((l) => ({
            quote_id: q!.id,
            line_id: l.lineId,
            rate: l.rate,
            remark: l.remark,
          })),
        )}`;
      await tx`UPDATE tender.rfq_vendor SET status = 'quoted' WHERE rfq_id = ${rfqId} AND party_id = ${partyId}`;
      if (r.status === 'draft') await tx`UPDATE tender.rfq SET status = 'sent' WHERE id = ${rfqId}`;
      await rfqEvent(
        tx,
        r,
        'rfq_quote',
        { number: r.number, vendor: v.name, lines: input.lines.length, source, round },
        claims.sub,
      );
      await this.touch(tx, rfqId, claims);
    });
    return this.get(claims, rfqId);
  }

  /**
   * Imports a filled enquiry workbook as the vendor's quote. The workbook names its RFQ and vendor (hidden sheet);
   * a file for another RFQ is refused. Lines are matched by number; any unreadable rate stops the import.
   */
  async importQuote(
    claims: TenantClaims,
    rfqId: string,
    partyId: string | null,
    file: { name: string; buffer: Buffer },
  ) {
    let read;
    try {
      read = await readQuoteWorkbook(file.buffer);
    } catch (err) {
      throw new BadRequestException({ code: 'unreadable_quote', message: (err as Error).message });
    }
    if (read.rfqId && read.rfqId !== rfqId)
      throw new BadRequestException({
        code: 'wrong_rfq',
        message: 'This workbook is the enquiry of another RFQ.',
      });
    if (partyId && read.vendorId && read.vendorId !== partyId)
      throw new BadRequestException({
        code: 'wrong_vendor',
        message: "This workbook was made for another vendor. Import it under that vendor's name.",
      });
    const vendor = partyId ?? read.vendorId;
    if (!vendor)
      throw new BadRequestException({
        code: 'vendor_unknown',
        message: 'Choose the vendor this quote is from.',
      });
    const rfq = await this.get(claims, rfqId);
    const bySeq = new Map(rfq.lines.map((l) => [l.seq, l.id]));
    const issues = [...read.issues];
    const lines: QuoteInput['lines'] = [];
    for (const l of read.lines) {
      const id = bySeq.get(l.seq);
      if (!id)
        issues.push(
          `Line ${l.seq} is not on this RFQ (removed since the enquiry went out?); it was left out.`,
        );
      else lines.push({ lineId: id, rate: l.rate, remark: l.remark });
    }
    const errors = issues.filter((i) => /is not a number/.test(i));
    if (errors.length)
      throw new BadRequestException({
        code: 'quote_has_errors',
        message: errors.join(' '),
        issues,
      });
    if (lines.length === 0)
      throw new BadRequestException({ code: 'empty_quote', message: 'No rates were filled in.' });
    const saved = await this.saveQuote(
      claims,
      rfqId,
      vendor,
      {
        receivedOn: today(),
        validUntil: read.validUntil,
        reference: read.reference,
        gstMode: read.gstMode,
        gstPct: read.gstPct,
        terms: '',
        lines,
      },
      'file',
      file.name.slice(-200),
    );
    return { rfq: saved, lines: lines.length, skipped: read.skipped, issues };
  }

  // --- choice and pricing ---

  /**
   * Chooses vendors per line: given lines, everything to one vendor (the lines it quoted), or the lowest quote on
   * every line (ties are left for the estimator).
   */
  async select(
    claims: TenantClaims,
    rfqId: string,
    input: {
      lines?: { lineId: string; partyId: string | null; note: string }[] | undefined;
      award?: string | undefined;
      lowest?: boolean | undefined;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const before = await this.get(claims, rfqId);
    let picks: { lineId: string; partyId: string | null; note: string }[] = input.lines ?? [];
    if (input.award)
      picks = before.lines
        .filter((l) => l.cells[input.award!])
        .map((l) => ({ lineId: l.id, partyId: input.award!, note: '' }));
    if (input.lowest)
      picks = before.lines
        .filter((l) => l.l1)
        .map((l) => ({ lineId: l.id, partyId: l.l1, note: '' }));
    const byLine = new Map(before.lines.map((l) => [l.id, l]));
    for (const p of picks) {
      const l = byLine.get(p.lineId);
      if (!l) throw new BadRequestException({ code: 'line_not_on_rfq' });
      if (p.partyId && !l.cells[p.partyId])
        throw new BadRequestException({
          code: 'not_quoted',
          message: `That vendor did not quote line ${l.seq}.`,
        });
    }
    await db.begin(async (tx) => {
      await this.lock(tx, rfqId);
      if (picks.length)
        await tx`
          UPDATE tender.rfq_line l SET selected_party_id = x.party, selection_note = coalesce(x.note, '')
          FROM jsonb_to_recordset(${tx.json(picks.map((p) => ({ id: p.lineId, party: p.partyId, note: p.note })))})
            AS x(id uuid, party uuid, note text)
          WHERE l.id = x.id AND l.rfq_id = ${rfqId}`;
      await this.touch(tx, rfqId, claims);
    });
    return { chosen: picks.filter((p) => p.partyId).length, rfq: await this.get(claims, rfqId) };
  }

  /**
   * Puts the chosen rates (before GST, to the paisa) into the estimate: BOQ items get them as their rate, through
   * the BOQ engine like an edit in the grid (so a revision keeps what changed); resources get a new dated rate from
   * the quote's date. A BOQ that is frozen is skipped and said so: start a revision first.
   */
  async apply(claims: TenantClaims, rfqId: string) {
    const rfq = await this.get(claims, rfqId);
    if (rfq.projectId)
      throw new ConflictException({
        code: 'not_for_project',
        message:
          "A project's enquiry does not change any estimate: the vendors chosen are ordered from.",
      });
    if (rfq.status === 'cancelled') throw new ConflictException({ code: 'rfq_cancelled' });
    const chosen = rfq.lines.filter((l) => l.selected);
    if (chosen.length === 0)
      throw new ConflictException({
        code: 'nothing_chosen',
        message: 'Choose a vendor for at least one line.',
      });
    const work = chosen.filter((l) => l.boqId);
    const material = chosen.filter((l) => l.resourceId);
    if (work.length && !(await this.permissions.can(claims, 'boq.edit')))
      throw new ForbiddenException({ code: 'permission_denied', permission: 'boq.edit' });
    if (material.length && !(await this.permissions.can(claims, 'rates.edit')))
      throw new ForbiddenException({ code: 'permission_denied', permission: 'rates.edit' });
    const db = await this.tenants.forTenant(claims.ten);
    const vendorName = new Map(rfq.vendors.map((v) => [v.partyId, v.name]));

    const boqs: {
      boqId: string;
      name: string;
      updated: number;
      unchanged: number;
      skipped: string | null;
    }[] = [];
    for (const [boqId, lines] of groupBy(work, (l) => l.boqId!)) {
      const [b] = await db<
        { name: string; status: string; archived: boolean; version_no: number }[]
      >`
        SELECT name, status, archived_at IS NOT NULL AS archived, version_no FROM est.boq WHERE id = ${boqId}`;
      const name = b?.name ?? '';
      if (!b || b.archived) {
        boqs.push({ boqId, name, updated: 0, unchanged: 0, skipped: 'The BOQ is archived.' });
        continue;
      }
      if (b.status !== 'draft') {
        boqs.push({
          boqId,
          name,
          updated: 0,
          unchanged: 0,
          skipped: `Version ${b.version_no} is frozen; start revision ${b.version_no + 1} to price it.`,
        });
        continue;
      }
      const nodes = await db<
        { id: string; line_key: string; row_version: number; rate: string | null }[]
      >`
        SELECT n.id::text, n.line_key, n.row_version, n.rate::text FROM tender.rfq_line l
        JOIN est.boq_node n ON n.boq_id = l.boq_id AND n.line_key = l.line_key
        WHERE l.id = ANY(${lines.map((l) => l.id)}::uuid[])`;
      const lineKey = new Map(
        (
          await db<{ id: string; line_key: string }[]>`
          SELECT id, line_key FROM tender.rfq_line WHERE id = ANY(${lines.map((l) => l.id)}::uuid[])`
        ).map((x) => [x.id, x.line_key]),
      );
      const byKey = new Map(nodes.map((n) => [n.line_key, n]));
      const ops: { op: 'update'; id: string; rowVersion: number; rate: string }[] = [];
      let unchanged = 0;
      for (const l of lines) {
        const n = byKey.get(lineKey.get(l.id)!);
        if (!n) continue; // the item was removed from the BOQ since
        const rate = rateToApply(l.selected!.basic);
        if (n.rate !== null && Number(n.rate) === Number(rate)) unchanged++;
        else ops.push({ op: 'update', id: n.id, rowVersion: n.row_version, rate });
      }
      if (ops.length) await this.boqs.apply(claims, boqId, ops);
      boqs.push({ boqId, name, updated: ops.length, unchanged, skipped: null });
    }

    let resources = 0;
    for (const l of material) {
      const quote = rfq.vendors.find((v) => v.partyId === l.selected!.partyId)!.quote!;
      await this.rates.setRate(claims, l.resourceId!, {
        effectiveFrom: quote.receivedOn,
        rate: rateToApply(l.selected!.basic),
        source: `${rfq.number} ${vendorName.get(l.selected!.partyId) ?? ''}`.slice(0, 200),
      });
      resources++;
    }
    await db.begin(async (tx) => {
      await event(
        tx,
        rfq.tenderId!,
        'rfq_applied',
        { number: rfq.number, items: boqs.reduce((n, b) => n + b.updated, 0), resources },
        claims.sub,
      );
      await audit(tx, claims.sub, 'rfq.apply', 'rfq', rfqId, { boqs, resources });
    });
    return { boqs, resources, rfq: await this.get(claims, rfqId) };
  }

  // --- helpers ---

  private async lock(tx: TransactionSql, rfqId: string, opts: { allowClosed?: boolean } = {}) {
    const [r] = await tx<
      {
        tender_id: string | null;
        project_id: string | null;
        number: string;
        kind: RfqKind;
        status: RfqStatus;
        row_version: number;
      }[]
    >`
      SELECT tender_id, project_id, number, kind, status, row_version FROM tender.rfq WHERE id = ${rfqId}
      FOR UPDATE`;
    if (!r) throw new NotFoundException({ code: 'rfq_not_found' });
    if (!opts.allowClosed && (r.status === 'closed' || r.status === 'cancelled'))
      throw new ConflictException({
        code: `rfq_${r.status}`,
        message: `This RFQ is ${r.status}. Reopen it to change it.`,
      });
    return r;
  }

  private async lineRfq(tx: TransactionSql | Sql, lineId: string) {
    const [l] = await tx<
      { rfq_id: string }[]
    >`SELECT rfq_id FROM tender.rfq_line WHERE id = ${lineId}`;
    if (!l) throw new NotFoundException({ code: 'rfq_line_not_found' });
    return l.rfq_id;
  }

  private async touch(tx: TransactionSql, rfqId: string, claims: TenantClaims) {
    await tx`UPDATE tender.rfq SET updated_at = now(), updated_by = ${claims.sub} WHERE id = ${rfqId}`;
    await rescheduleRfq(tx, rfqId, new Date());
  }
}

/** Requisitions an enquiry may ask for: the project's own, and approved. */
async function checkRequisitions(db: Sql | TransactionSql, projectId: string, ids: string[]) {
  const reqs = await db<{ id: string; number: string; status: string }[]>`
    SELECT id, number, status FROM proc.requisition WHERE id = ANY(${ids}::uuid[]) AND project_id = ${projectId}`;
  if (reqs.length !== new Set(ids).size)
    throw new BadRequestException({
      code: 'requisition_not_found',
      message: "A requisition is not one of this project's.",
    });
  const notApproved = reqs.filter((q) => q.status !== 'approved');
  if (notApproved.length)
    throw new ConflictException({
      code: 'requisition_not_approved',
      message: `Only approved requisitions go to vendors: ${notApproved.map((q) => q.number).join(', ')}.`,
    });
}

/** What happened to an RFQ goes into its tender's or its project's activity. */
async function rfqEvent(
  tx: TransactionSql,
  owner: { tender_id: string | null; project_id: string | null },
  kind: string,
  data: Record<string, unknown>,
  actorId: string,
) {
  if (owner.tender_id) await event(tx, owner.tender_id, kind, data, actorId);
  else
    await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
      VALUES (${owner.project_id}, ${kind}, ${tx.json(JSON.parse(JSON.stringify(data)))}, ${actorId})`;
}

function groupBy<T>(xs: T[], key: (x: T) => string) {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

const stale = () =>
  new ConflictException({
    code: 'stale_row',
    message: 'Someone else changed this RFQ. Reload to see their changes.',
  });

/**
 * Reminders for quotes due (docs/04-features.md E8): to the RFQ's owner (or whoever made it), the day before the due
 * date and on it, at 09:30 IST, while the RFQ is out and some vendor has not quoted or declined. Replaced on every
 * change to the RFQ.
 */
export async function rescheduleRfq(tx: TransactionSql, rfqId: string, now: Date) {
  const source = `rfq:${rfqId}`;
  await tx`DELETE FROM platform.notification WHERE source = ${source} AND due_at > ${now}`;
  const [r] = await tx<
    {
      number: string;
      title: string;
      status: string;
      due_on: string | null;
      user_id: string | null;
      waiting: number;
      vendors: number;
    }[]
  >`
    SELECT r.number, r.title, r.status, to_char(r.due_on, 'YYYY-MM-DD') AS due_on,
      coalesce(r.owner_id, r.created_by) AS user_id,
      (SELECT count(*)::int FROM tender.rfq_vendor v WHERE v.rfq_id = r.id
        AND v.status NOT IN ('quoted', 'declined')) AS waiting,
      (SELECT count(*)::int FROM tender.rfq_vendor v WHERE v.rfq_id = r.id) AS vendors
    FROM tender.rfq r WHERE r.id = ${rfqId}`;
  if (!r || r.status !== 'sent' || !r.due_on || !r.user_id || r.waiting === 0) return;
  const at = (offsetDays: number) => {
    const d = new Date(`${r.due_on}T09:30:00+05:30`);
    return new Date(d.getTime() - offsetDays * 86_400_000);
  };
  const plans = [
    { dueAt: at(1), title: `Quotes due tomorrow: ${r.number} ${r.title}` },
    { dueAt: at(0), title: `Quotes due today: ${r.number} ${r.title}` },
  ].filter((p) => p.dueAt > now);
  const body = `${r.waiting} of ${r.vendors} vendor${r.vendors === 1 ? '' : 's'} yet to quote.`;
  for (const p of plans)
    await tx`INSERT INTO platform.notification (user_id, kind, title, body, link, due_at, source)
      VALUES (${r.user_id}, 'rfq_due', ${p.title}, ${body}, ${`/rfqs/${rfqId}`}, ${p.dueAt}, ${source})`;
}
