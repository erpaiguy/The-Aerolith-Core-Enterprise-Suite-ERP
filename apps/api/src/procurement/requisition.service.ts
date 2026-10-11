// Purchase requisitions (docs/04-features.md R1, docs/wave2b-plan.md step 1): what a project asks to be bought,
// line by line (a material from the rate library or typed in, a quantity, an estimated rate, the contract BOQ item
// and WBS element it is for, when it is needed), approved under the company's approval rules before it is ordered.
// The first document of the approval engine.
//
// draft → submitted → approved | rejected; a rejected or withdrawn one is put right and submitted again; one not yet
// submitted, rejected or approved can be cancelled. The project's team (lead and members, and those who edit
// projects) raises and submits them; viewers read.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { ApprovalService, indiaToday, type Outcome } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { nextNumber } from '../tender/numbering.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
export const REQUISITION = 'purchase_requisition';
export type RequisitionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';

export interface RequisitionLineInput {
  resourceId: string | null;
  description: string;
  unit: string;
  qty: string;
  /** Estimated rate; the rate library's current rate for the resource when not given. */
  rate: string | null;
  /** The contract BOQ item (by its code) and WBS element (by its code) it is for. */
  boqCode: string | null;
  wbsCode: string | null;
  neededBy: string | null;
  notes: string;
}

export interface RequisitionInput {
  title: string;
  siteId: string | null;
  neededBy: string | null;
  notes: string;
  lines: RequisitionLineInput[];
}

interface Row {
  id: string;
  project_id: string;
  number: string;
  title: string;
  status: RequisitionStatus;
  amount: string;
  row_version: number;
  created_by: string | null;
}

const EDITABLE: RequisitionStatus[] = ['draft', 'rejected'];
const stale = () =>
  new ConflictException({
    code: 'stale_row',
    message: 'Someone else changed this requisition. Reload to see their changes.',
  });

@Injectable()
export class RequisitionService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
    private readonly approvals: ApprovalService,
  ) {}

  onModuleInit() {
    this.approvals.register(REQUISITION, {
      label: 'Purchase requisition',
      projectScoped: true,
      link: (id) => `/requisitions/${id}`,
      decided: (tx, id, outcome, claims, comment) => this.decided(tx, id, outcome, claims, comment),
      summary: (db, id) => this.summary(db, id),
      canSee: async (db, claims, id) => {
        const [r] = await db<{ project_id: string }[]>`
          SELECT project_id FROM proc.requisition WHERE id = ${id}`;
        if (!r) return false;
        return this.projects.access(db, claims, r.project_id).then(
          () => true,
          () => false,
        );
      },
    });
  }

  /** The team raises and changes requisitions; viewers read; others do not see the project. */
  private async mayWork(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member' && a.role !== 'lead')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) raises requisitions.",
      });
    return a;
  }

  private async row(db: Db, id: string, lock = false) {
    const [r] = lock
      ? await db<Row[]>`SELECT * FROM proc.requisition WHERE id = ${id} FOR UPDATE`
      : await db<Row[]>`SELECT * FROM proc.requisition WHERE id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'requisition_not_found' });
    return r;
  }

  // --- lines ---

  /** Checks the lines and works out what is not given: resource names, units and rates, BOQ items, WBS elements. */
  private async resolve(db: Db, projectId: string, input: RequisitionInput) {
    if (input.siteId) {
      const [s] =
        await db`SELECT 1 FROM proj.site WHERE id = ${input.siteId} AND project_id = ${projectId}
        AND active`;
      if (!s)
        throw new BadRequestException({
          code: 'site_not_found',
          message: 'Choose one of the project’s sites.',
        });
    }
    const resourceIds = [
      ...new Set(input.lines.map((l) => l.resourceId).filter((x): x is string => !!x)),
    ];
    const resources = resourceIds.length
      ? await db<{ id: string; name: string; unit: string; rate: string | null }[]>`
          SELECT r.id, r.name, r.unit, (SELECT rr.rate::text FROM est.resource_rate rr
            WHERE rr.resource_id = r.id AND rr.effective_from <= ${indiaToday()}::date
            ORDER BY rr.effective_from DESC LIMIT 1) AS rate
          FROM est.resource r WHERE r.id = ANY(${resourceIds}::uuid[]) AND r.active`
      : [];
    const boqCodes = [
      ...new Set(input.lines.map((l) => l.boqCode?.toLowerCase()).filter((x): x is string => !!x)),
    ];
    const items = boqCodes.length
      ? await db<{ code: string; line_key: string }[]>`
          SELECT lower(n.code) AS code, n.line_key FROM est.boq b
          JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
          WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
            AND lower(n.code) = ANY(${boqCodes}::text[])`
      : [];
    const wbsCodes = [
      ...new Set(input.lines.map((l) => l.wbsCode?.toLowerCase()).filter((x): x is string => !!x)),
    ];
    const wbs = wbsCodes.length
      ? await db<{ code: string; id: string }[]>`
          SELECT lower(code) AS code, id FROM proj.wbs
          WHERE project_id = ${projectId} AND lower(code) = ANY(${wbsCodes}::text[])`
      : [];
    return input.lines.map((l, i) => {
      const at = `Line ${i + 1}`;
      const res = l.resourceId ? resources.find((r) => r.id === l.resourceId) : undefined;
      if (l.resourceId && !res)
        throw new BadRequestException({
          code: 'resource_not_found',
          message: `${at}: that resource is not in the rate library (or no longer used).`,
        });
      let lineKey: string | null = null;
      if (l.boqCode) {
        const found = items.filter((x) => x.code === l.boqCode!.toLowerCase());
        if (!found.length)
          throw new BadRequestException({
            code: 'boq_item_not_found',
            message: `${at}: no item ${l.boqCode} in the project's contract BOQ.`,
          });
        if (found.length > 1)
          throw new BadRequestException({
            code: 'boq_item_ambiguous',
            message: `${at}: more than one contract BOQ item is coded ${l.boqCode}.`,
          });
        lineKey = found[0]!.line_key;
      }
      let wbsId: string | null = null;
      if (l.wbsCode) {
        const w = wbs.find((x) => x.code === l.wbsCode!.toLowerCase());
        if (!w)
          throw new BadRequestException({
            code: 'wbs_not_found',
            message: `${at}: no WBS element ${l.wbsCode} in this project.`,
          });
        wbsId = w.id;
      }
      const description = l.description || res?.name || '';
      const unit = l.unit || res?.unit || '';
      if (!description || !unit)
        throw new BadRequestException({
          code: 'line_incomplete',
          message: `${at}: say what it is and its unit.`,
        });
      return {
        position: i + 1,
        resourceId: l.resourceId,
        description,
        unit,
        qty: l.qty,
        rate: l.rate ?? res?.rate ?? null,
        lineKey,
        wbsId,
        neededBy: l.neededBy,
        notes: l.notes,
      };
    });
  }

  /** Replaces the lines and works out the requisition's estimated amount. */
  private async saveLines(
    tx: TransactionSql,
    id: string,
    lines: Awaited<ReturnType<RequisitionService['resolve']>>,
  ) {
    await tx`DELETE FROM proc.requisition_line WHERE requisition_id = ${id}`;
    if (lines.length) {
      const col = <K extends keyof (typeof lines)[number]>(k: K) =>
        lines.map((l) => (l[k] === null ? null : String(l[k])));
      await tx`
        INSERT INTO proc.requisition_line (requisition_id, position, resource_id, description, unit, qty, rate,
          amount, line_key, wbs_id, needed_by, notes)
        SELECT ${id}, t.position::int, t.resource_id::uuid, t.description, t.unit, t.qty::numeric, t.rate::numeric,
          round(t.qty::numeric * t.rate::numeric, 2), t.line_key::uuid, t.wbs_id::uuid, t.needed_by::date, t.notes
        FROM unnest(${col('position')}::text[], ${col('resourceId')}::text[], ${col('description')}::text[],
          ${col('unit')}::text[], ${col('qty')}::text[], ${col('rate')}::text[], ${col('lineKey')}::text[],
          ${col('wbsId')}::text[], ${col('neededBy')}::text[], ${col('notes')}::text[])
          AS t(position, resource_id, description, unit, qty, rate, line_key, wbs_id, needed_by, notes)`;
    }
    await tx`UPDATE proc.requisition SET amount = (SELECT coalesce(sum(amount), 0) FROM proc.requisition_line
      WHERE requisition_id = ${id}) WHERE id = ${id}`;
  }

  // --- the register ---

  async list(
    claims: TenantClaims,
    q: { projectId?: string | undefined; status?: RequisitionStatus | 'open' | undefined },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    if (q.projectId) await this.projects.access(db, claims, q.projectId);
    const all = claims.role === 'admin' || (await this.permissions.can(claims, 'projects.all'));
    return db`
      SELECT r.id, r.number, r.title, r.status, r.amount::text AS amount,
        to_char(r.needed_by, 'YYYY-MM-DD') AS "neededBy", r.created_at AS "createdAt",
        u.display_name AS "createdBy",
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        (SELECT count(*)::int FROM proc.requisition_line l WHERE l.requisition_id = r.id) AS lines
      FROM proc.requisition r
      JOIN proj.project p ON p.id = r.project_id
      LEFT JOIN platform."user" u ON u.id = r.created_by
      WHERE ${
        all
          ? db`true`
          : db`EXISTS (SELECT 1 FROM proj.member m WHERE m.project_id = r.project_id AND m.user_id = ${claims.sub})`
      }
        ${q.projectId ? db`AND r.project_id = ${q.projectId}` : db``}
        ${
          q.status === 'open'
            ? db`AND r.status IN ('draft', 'submitted', 'rejected')`
            : q.status
              ? db`AND r.status = ${q.status}`
              : db``
        }
      ORDER BY r.created_at DESC LIMIT 500`;
  }

  async create(claims: TenantClaims, projectId: string, input: RequisitionInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mayWork(db, claims, projectId);
    const lines = await this.resolve(db, projectId, input);
    const id = await db.begin(async (tx) => {
      const [p] = await tx<{ entity_id: string }[]>`
        SELECT entity_id FROM proj.project WHERE id = ${projectId}`;
      const number = await nextNumber(tx, REQUISITION, p!.entity_id, 'PR', new Date());
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO proc.requisition (project_id, number, site_id, title, needed_by, notes, created_by, updated_by)
        VALUES (${projectId}, ${number}, ${input.siteId}, ${input.title}, ${input.neededBy}, ${input.notes},
          ${claims.sub}, ${claims.sub})
        RETURNING id`;
      await this.saveLines(tx, r!.id, lines);
      await audit(tx, claims.sub, 'requisition.create', 'requisition', r!.id, {
        number,
        projectId,
      });
      return r!.id;
    });
    return this.get(claims, id);
  }

  async update(claims: TenantClaims, id: string, rowVersion: number, input: RequisitionInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.row(db, id);
    await this.mayWork(db, claims, r.project_id);
    if (!EDITABLE.includes(r.status))
      throw new ConflictException({
        code: 'not_editable',
        message:
          r.status === 'submitted'
            ? 'It is waiting for approval: withdraw it to change it.'
            : `A requisition that is ${r.status} cannot be changed.`,
      });
    const lines = await this.resolve(db, r.project_id, input);
    await db.begin(async (tx) => {
      const [u] = await tx`
        UPDATE proc.requisition SET title = ${input.title}, site_id = ${input.siteId},
          needed_by = ${input.neededBy}, notes = ${input.notes}, status = 'draft', status_reason = NULL,
          updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id} AND row_version = ${rowVersion} AND status IN ('draft', 'rejected') RETURNING id`;
      if (!u) throw stale();
      await this.saveLines(tx, id, lines);
      await audit(tx, claims.sub, 'requisition.update', 'requisition', id, { lines: lines.length });
    });
    return this.get(claims, id);
  }

  /** Sends it for approval; with no approval rule for its amount it is approved at once. */
  async submit(claims: TenantClaims, id: string, rowVersion: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.row(db, id);
    await this.mayWork(db, claims, r.project_id);
    await db.begin(async (tx) => {
      const cur = await this.row(tx, id, true);
      if (cur.row_version !== rowVersion) throw stale();
      if (!EDITABLE.includes(cur.status))
        throw new ConflictException({
          code: 'not_submittable',
          message: `A requisition that is ${cur.status} cannot be submitted.`,
        });
      const [n] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM proc.requisition_line WHERE requisition_id = ${id}`;
      if (!n!.n)
        throw new BadRequestException({
          code: 'no_lines',
          message: 'Add what is needed before submitting.',
        });
      const res = await this.approvals.submit(tx, claims, {
        docType: REQUISITION,
        docId: id,
        projectId: cur.project_id,
        title: `${cur.number} · ${cur.title}`,
        amount: cur.amount,
      });
      await tx`
        UPDATE proc.requisition SET status = ${res.status === 'approved' ? 'approved' : 'submitted'},
          status_reason = NULL, updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id}`;
      await audit(tx, claims.sub, 'requisition.submit', 'requisition', id, {
        approval: res.requestId,
        status: res.status,
      });
    });
    return this.get(claims, id);
  }

  async cancel(claims: TenantClaims, id: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.row(db, id);
    await this.mayWork(db, claims, r.project_id);
    await db.begin(async (tx) => {
      const cur = await this.row(tx, id, true);
      if (cur.status === 'submitted')
        throw new ConflictException({
          code: 'withdraw_first',
          message: 'It is waiting for approval: withdraw it first.',
        });
      if (cur.status === 'cancelled')
        throw new ConflictException({ code: 'already_cancelled', message: 'Already cancelled.' });
      await tx`UPDATE proc.requisition SET status = 'cancelled', status_reason = ${reason}, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${id}`;
      await audit(tx, claims.sub, 'requisition.cancel', 'requisition', id, { reason });
    });
    return this.get(claims, id);
  }

  /** The approval engine's decision, in its transaction. */
  private async decided(
    tx: TransactionSql,
    id: string,
    outcome: Outcome,
    claims: TenantClaims,
    comment: string | null,
  ) {
    const status = outcome === 'withdrawn' ? 'draft' : outcome;
    await tx`UPDATE proc.requisition SET status = ${status},
      status_reason = ${outcome === 'rejected' ? comment : null}, updated_at = now(), updated_by = ${claims.sub},
      row_version = row_version + 1 WHERE id = ${id}`;
  }

  // --- reading ---

  private async lines(db: Db, id: string) {
    return db`
      SELECT l.position, l.resource_id AS "resourceId", res.code AS "resourceCode", l.description, l.unit,
        l.qty::text AS qty, l.rate::text AS rate, l.amount::text AS amount, to_char(l.needed_by, 'YYYY-MM-DD')
          AS "neededBy", l.notes,
        bi.code AS "boqCode", bi.description AS "boqDescription", w.code AS "wbsCode", w.name AS "wbsName",
        -- The material budget in force for the resource, and what the project's other live requisitions take of it.
        mb.qty::text AS "budgetQty",
        CASE WHEN mb.resource_id IS NULL THEN NULL ELSE coalesce((SELECT sum(ol.qty) FROM proc.requisition o
          JOIN proc.requisition_line ol ON ol.requisition_id = o.id
          WHERE o.project_id = r.project_id AND o.id <> r.id AND o.status IN ('submitted', 'approved')
            AND ol.resource_id = l.resource_id), 0)::text END AS "budgetUsedElsewhere",
        EXISTS (SELECT 1 FROM proj.material_budget x WHERE x.project_id = r.project_id AND x.status = 'approved')
          AS "hasBudget"
      FROM proc.requisition_line l
      JOIN proc.requisition r ON r.id = l.requisition_id
      LEFT JOIN LATERAL (
        SELECT bl.resource_id, bl.qty FROM proj.material_budget b
        JOIN proj.material_budget_line bl ON bl.budget_id = b.id AND bl.resource_id = l.resource_id
        WHERE b.project_id = r.project_id AND b.status = 'approved') mb ON l.resource_id IS NOT NULL
      LEFT JOIN est.resource res ON res.id = l.resource_id
      LEFT JOIN proj.wbs w ON w.id = l.wbs_id
      LEFT JOIN LATERAL (
        SELECT n.code, t.description FROM est.boq b
        JOIN est.boq_node n ON n.boq_id = b.id AND n.line_key = l.line_key
        JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
        WHERE b.project_id = r.project_id AND b.kind = 'contract' AND b.archived_at IS NULL
        ORDER BY b.created_at LIMIT 1) bi ON l.line_key IS NOT NULL
      WHERE l.requisition_id = ${id} ORDER BY l.position`;
  }

  private async head(db: Db, id: string) {
    const [h] = await db<
      {
        id: string;
        number: string;
        title: string;
        status: RequisitionStatus;
        statusReason: string | null;
        amount: string;
        neededBy: string | null;
        notes: string;
        site: { id: string; name: string } | null;
        project: { id: string; number: string; name: string };
        createdBy: string | null;
        createdAt: string;
        rowVersion: number;
      }[]
    >`
      SELECT r.id, r.number, r.title, r.status, r.status_reason AS "statusReason", r.amount::text AS amount,
        to_char(r.needed_by, 'YYYY-MM-DD') AS "neededBy", r.notes,
        CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id', s.id, 'name', s.name) END AS site,
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        u.display_name AS "createdBy", r.created_at AS "createdAt", r.row_version AS "rowVersion"
      FROM proc.requisition r
      JOIN proj.project p ON p.id = r.project_id
      LEFT JOIN proj.site s ON s.id = r.site_id
      LEFT JOIN platform."user" u ON u.id = r.created_by
      WHERE r.id = ${id}`;
    if (!h) throw new NotFoundException({ code: 'requisition_not_found' });
    return h;
  }

  /** What an approver sees, who may not be on the project. */
  private async summary(db: Db, id: string) {
    return { ...(await this.head(db, id)), lines: await this.lines(db, id) };
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.row(db, id);
    const a = await this.projects.access(db, claims, r.project_id);
    const mayWork = a.canEdit || a.role === 'member' || a.role === 'lead';
    const h = await this.head(db, id);
    const lines = await this.lines(db, id);
    return {
      ...h,
      lines,
      approval: await this.approvals.latestFor(db, claims, REQUISITION, id),
      /** The enquiries to vendors asking for its lines (step 3). */
      enquiries: await db<
        { id: string; number: string; title: string; status: string; lines: number }[]
      >`
        SELECT r.id, r.number, r.title, r.status, count(DISTINCT x.position)::int AS lines
        FROM proc.rfq_requisition_line x JOIN tender.rfq_line l ON l.id = x.rfq_line_id
        JOIN tender.rfq r ON r.id = l.rfq_id
        WHERE x.requisition_id = ${id} GROUP BY r.id ORDER BY r.number`,
      mayEdit: mayWork && EDITABLE.includes(r.status),
      maySubmit: mayWork && EDITABLE.includes(r.status) && lines.length > 0,
      mayCancel: mayWork && r.status !== 'submitted' && r.status !== 'cancelled',
    };
  }
}
