// A project's material budget (docs/04-features.md R1, docs/wave2b-plan.md step 2): what the project may use of each
// resource, and at what rate.
//
// Revision 0 is made once from the won tender's rate analyses: each contract BOQ item's analysis (as in the tender
// version the contract was copied from), sub-analyses and wastage worked in, gives what one unit of the item takes of
// each resource (its norms, kept for requisitions from BOQ items and the look-ahead); times the budget's quantities,
// added up per resource, at the rates on the estimate's rate date. It is a copy: estimation is not looked at again,
// and the tender's estimate is closed. A project without a tender starts an empty budget.
//
// Later revisions start as a copy of the budget in force; the project's lead changes quantities and rates, adds and
// removes resources, says why, and submits it; once approved under the approval rules it is in force and the one
// before is kept as it was.
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
import { RevisionService } from '../boq/revision.service.js';
import { cents, fromCents } from '../project/money.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { add, dec, div, fmt, mul, plusPct, ZERO, type Dec } from '../rates/decimal.js';
import { MAX_NESTING } from '../rates/engine.js';
import { audit } from '../tender/tender-records.js';

type Db = Sql | TransactionSql;
export const MATERIAL_BUDGET = 'material_budget';
export type BudgetStatus =
  'draft' | 'submitted' | 'approved' | 'rejected' | 'superseded' | 'discarded';

export interface BudgetLineInput {
  resourceId: string;
  qty: string;
  rate: string | null;
  note: string;
}

interface BudgetRow {
  id: string;
  project_id: string;
  revision: number;
  status: BudgetStatus;
  total: string;
  based_on: string | null;
  row_version: number;
}

interface AnalysisDef {
  id: string;
  code: string;
  outputQty: string;
  changedAt: string;
  lines: {
    kind: 'resource' | 'analysis' | 'lump_sum';
    resourceId: string | null;
    subAnalysisId: string | null;
    qty: string;
    wastagePct: string;
  }[];
}

const OPEN: BudgetStatus[] = ['draft', 'submitted', 'rejected'];
const EDITABLE: BudgetStatus[] = ['draft', 'rejected'];
const stale = () =>
  new ConflictException({
    code: 'stale_row',
    message: 'Someone else changed this budget revision. Reload to see their changes.',
  });

/**
 * What one unit of each analysis takes of each resource, sub-analyses and wastage worked in (exact decimals, as the
 * costing engine prices them). Lump sums are money, not resources, and are left out.
 */
export function perUnit(analyses: Map<string, AnalysisDef>) {
  const memo = new Map<string, Map<string, Dec>>();
  const walk = (id: string, path: string[]): Map<string, Dec> => {
    const hit = memo.get(id);
    if (hit) return hit;
    const a = analyses.get(id);
    if (!a) throw new Error(`analysis not loaded: ${id}`);
    if (path.includes(id) || path.length > MAX_NESTING)
      throw new BadRequestException({
        code: 'analysis_cycle',
        message: `Rate analysis ${a.code} contains itself or nests too deep.`,
      });
    const out = new Map<string, Dec>();
    const put = (rid: string, q: Dec) => out.set(rid, add(out.get(rid) ?? ZERO, q));
    for (const l of a.lines) {
      const factor = plusPct(dec(l.qty), dec(l.wastagePct));
      if (l.kind === 'resource') put(l.resourceId!, factor);
      else if (l.kind === 'analysis')
        for (const [rid, q] of walk(l.subAnalysisId!, [...path, id])) put(rid, mul(factor, q));
    }
    const outputQty = dec(a.outputQty);
    for (const [rid, q] of out) out.set(rid, div(q, outputQty));
    memo.set(id, out);
    return out;
  };
  return (id: string) => walk(id, []);
}

@Injectable()
export class MaterialBudgetService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly approvals: ApprovalService,
    private readonly revisions: RevisionService,
  ) {}

  onModuleInit() {
    this.approvals.register(MATERIAL_BUDGET, {
      label: 'Material budget revision',
      projectScoped: true,
      link: (id) => `/material-budgets/${id}`,
      decided: (tx, id, outcome, claims, comment) => this.decided(tx, id, outcome, claims, comment),
      summary: (db, id) => this.summary(db, id),
      canSee: async (db, claims, id) => {
        const [b] = await db<{ project_id: string }[]>`
          SELECT project_id FROM proj.material_budget WHERE id = ${id}`;
        if (!b) return false;
        return this.projects.access(db, claims, b.project_id).then(
          () => true,
          () => false,
        );
      },
    });
  }

  /** The project's lead (and those who edit projects) keeps its budget; the team reads it. */
  private async mayKeep(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          "Only the project's lead (or someone who edits projects) changes its material budget.",
      });
  }

  private async row(db: Db, id: string, lock = false) {
    const [b] = lock
      ? await db<BudgetRow[]>`SELECT * FROM proj.material_budget WHERE id = ${id} FOR UPDATE`
      : await db<BudgetRow[]>`SELECT * FROM proj.material_budget WHERE id = ${id}`;
    if (!b) throw new NotFoundException({ code: 'budget_not_found' });
    return b;
  }

  // --- making revision 0 ---

  /**
   * Revision 0 from the won tender: norms per contract BOQ item from its rate analysis, quantities per resource, rates
   * on the estimate's rate date; then the tender's estimate is closed.
   */
  async fromTender(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mayKeep(db, claims, projectId);
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`material_budget:${projectId}`}))`;
      await this.refuseIfStarted(tx, projectId);
      const [p] = await tx<{ number: string; tender_id: string | null }[]>`
        SELECT number, tender_id FROM proj.project WHERE id = ${projectId}`;
      if (!p!.tender_id)
        throw new ConflictException({
          code: 'no_tender',
          message: 'This project did not come from a tender here: start an empty budget.',
        });
      const sources = await tx<
        {
          contract_id: string;
          source_id: string;
          version: number;
          rate_date: string;
          budget_id: string | null;
          frozen_at: string | null;
        }[]
      >`
        SELECT c.id AS contract_id, c.source_boq_id AS source_id, c.source_version_no AS version,
          s.rate_date::text AS rate_date,
          (SELECT bu.id FROM est.boq bu WHERE bu.project_id = c.project_id AND bu.kind = 'budget'
            AND bu.archived_at IS NULL AND bu.source_boq_id = c.source_boq_id ORDER BY bu.created_at LIMIT 1)
            AS budget_id,
          (SELECT v.frozen_at FROM est.boq_version v WHERE v.boq_id = c.source_boq_id
            AND v.version_no = c.source_version_no) AS frozen_at
        FROM est.boq c JOIN est.boq s ON s.id = c.source_boq_id
        WHERE c.project_id = ${projectId} AND c.kind = 'contract' AND c.archived_at IS NULL
          AND c.source_boq_id IS NOT NULL
        ORDER BY c.created_at`;
      if (!sources.length)
        throw new ConflictException({
          code: 'no_contract_boq',
          message: 'Make the contract BOQ and budget from the tender first.',
        });

      // Each item: its quantity in the project's budget (else the contract), and the analysis its tender line had
      // in the version the contract was copied from.
      const items: { lineKey: string; qty: string; analysisId: string; frozenAt: string | null }[] =
        [];
      for (const s of sources) {
        const rows = await tx<{ line_key: string; qty: string; analysis_id: string | null }[]>`
          WITH v AS (
            SELECT DISTINCT ON (h.line_key) h.line_key, h.rate_analysis_id FROM est.boq_node_hist h
            WHERE h.boq_id = ${s.source_id} AND h.frozen_version >= ${s.version}
            ORDER BY h.line_key, h.frozen_version
          ),
          src AS (
            SELECT n.line_key, CASE WHEN v.line_key IS NOT NULL THEN v.rate_analysis_id ELSE n.rate_analysis_id END
              AS analysis_id
            FROM est.boq_node n LEFT JOIN v ON v.line_key = n.line_key
            WHERE n.boq_id = ${s.source_id}
            UNION ALL
            SELECT v.line_key, v.rate_analysis_id FROM v
            WHERE NOT EXISTS (SELECT 1 FROM est.boq_node n WHERE n.boq_id = ${s.source_id} AND n.line_key = v.line_key)
          )
          SELECT q.line_key, q.qty::text AS qty, src.analysis_id
          FROM est.boq_node q JOIN src ON src.line_key = q.line_key
          WHERE q.boq_id = ${s.budget_id ?? s.contract_id} AND q.node_type = 'item' AND q.qty IS NOT NULL
            AND q.qty > 0`;
        for (const r of rows)
          if (r.analysis_id)
            items.push({
              lineKey: r.line_key,
              qty: r.qty,
              analysisId: r.analysis_id,
              frozenAt: s.frozen_at,
            });
      }

      // The analyses those items use, with everything inside them.
      const roots = [...new Set(items.map((i) => i.analysisId))];
      const defs = roots.length
        ? await tx<(Omit<AnalysisDef, 'lines'> & { lines: AnalysisDef['lines'] | null })[]>`
            WITH RECURSIVE tree(id) AS (
              SELECT unnest(${roots}::uuid[])
              UNION
              SELECT l.sub_analysis_id FROM est.rate_analysis_line l JOIN tree t ON l.analysis_id = t.id
              WHERE l.sub_analysis_id IS NOT NULL
            )
            SELECT a.id, a.code, a.output_qty::text AS "outputQty", a.updated_at AS "changedAt",
              (SELECT json_agg(json_build_object('kind', l.kind, 'resourceId', l.resource_id,
                  'subAnalysisId', l.sub_analysis_id, 'qty', l.qty::text, 'wastagePct', l.wastage_pct::text)
                ORDER BY l.line_no)
                FROM est.rate_analysis_line l WHERE l.analysis_id = a.id) AS lines
            FROM est.rate_analysis a JOIN tree ON tree.id = a.id`
        : [];
      const analyses = new Map<string, AnalysisDef>(
        defs.map((d) => [d.id, { ...d, lines: d.lines ?? [] }]),
      );
      const per = perUnit(analyses);
      // Edited after the tender version was frozen: the analysis itself or one inside it.
      const changedMemo = new Map<string, string>();
      const lastChange = (id: string, seen = new Set<string>()): string => {
        const hit = changedMemo.get(id);
        if (hit) return hit;
        const a = analyses.get(id)!;
        seen.add(id);
        let latest = new Date(a.changedAt).toISOString();
        for (const l of a.lines)
          if (l.kind === 'analysis' && !seen.has(l.subAnalysisId!)) {
            const t = lastChange(l.subAnalysisId!, seen);
            if (t > latest) latest = t;
          }
        changedMemo.set(id, latest);
        return latest;
      };

      const norms: {
        lineKey: string;
        resourceId: string;
        perUnit: string;
        code: string;
        changed: boolean;
      }[] = [];
      const totals = new Map<string, Dec>();
      for (const it of items) {
        const a = analyses.get(it.analysisId)!;
        const changed =
          it.frozenAt !== null && lastChange(it.analysisId) > new Date(it.frozenAt).toISOString();
        for (const [rid, q] of per(it.analysisId)) {
          norms.push({
            lineKey: it.lineKey,
            resourceId: rid,
            perUnit: fmt(q, 12),
            code: a.code,
            changed,
          });
          totals.set(rid, add(totals.get(rid) ?? ZERO, mul(q, dec(it.qty))));
        }
      }
      const resourceIds = [...totals.keys()];
      const rateDate = sources[0]!.rate_date;
      const resources = resourceIds.length
        ? await tx<
            {
              id: string;
              code: string;
              name: string;
              kind: string;
              unit: string;
              rate: string | null;
            }[]
          >`
            SELECT r.id, r.code, r.name, r.kind, r.unit, (SELECT rr.rate::text FROM est.resource_rate rr
              WHERE rr.resource_id = r.id AND rr.effective_from <= ${rateDate}::date
              ORDER BY rr.effective_from DESC LIMIT 1) AS rate
            FROM est.resource r WHERE r.id = ANY(${resourceIds}::uuid[])`
        : [];

      const [b] = await tx<{ id: string }[]>`
        INSERT INTO proj.material_budget (project_id, revision, source, reason, basis, created_by, updated_by)
        VALUES (${projectId}, 0, 'tender', 'From the tender estimate',
          ${tx.json({
            boqs: sources.map((s) => ({
              boqId: s.source_id,
              version: s.version,
              rateDate: s.rate_date,
            })),
            items: items.length,
            changedItems: new Set(norms.filter((n) => n.changed).map((n) => n.lineKey)).size,
          })}, ${claims.sub}, ${claims.sub})
        RETURNING id`;
      await this.writeLines(
        tx,
        b!.id,
        resources.map((r) => ({
          ...r,
          resourceId: r.id,
          qty: fmt(totals.get(r.id)!, 4),
          note: '',
        })),
      );
      for (let i = 0; i < norms.length; i += 10_000) {
        const chunk = norms.slice(i, i + 10_000);
        await tx`
          INSERT INTO proj.material_norm (project_id, line_key, resource_id, per_unit, analysis_code, analysis_changed)
          SELECT ${projectId}, t.k::uuid, t.r::uuid, t.q::numeric, t.c, t.ch::bool
          FROM unnest(${chunk.map((n) => n.lineKey)}::text[], ${chunk.map((n) => n.resourceId)}::text[],
            ${chunk.map((n) => n.perUnit)}::text[], ${chunk.map((n) => n.code)}::text[],
            ${chunk.map((n) => String(n.changed))}::text[]) AS t(k, r, q, c, ch)`;
      }

      // The estimate is closed: kept as it was, never revised again.
      const reason = `Won: the budget of project ${p!.number}`;
      const tenderBoqs = await tx<{ id: string; status: string }[]>`
        SELECT id, status FROM est.boq WHERE tender_id = ${p!.tender_id} AND archived_at IS NULL
          AND closed_at IS NULL FOR UPDATE`;
      for (const t of tenderBoqs) {
        if (t.status === 'draft')
          await this.revisions.freezeInTx(tx, claims.sub, t.id, {
            kind: 'internal',
            label: 'Closed',
            note: reason,
          });
        await tx`UPDATE est.boq SET closed_at = now(), closed_by = ${claims.sub}, closed_reason = ${reason}
          WHERE id = ${t.id}`;
      }
      await audit(tx, claims.sub, 'material_budget.from_tender', 'material_budget', b!.id, {
        projectId,
        resources: resources.length,
        norms: norms.length,
        closed: tenderBoqs.map((t) => t.id),
      });
      return b!.id;
    });
    return this.get(claims, id);
  }

  /** Revision 0 with nothing in it, for a project that did not come from a tender (or whose tender had no analyses). */
  async blank(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mayKeep(db, claims, projectId);
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`material_budget:${projectId}`}))`;
      await this.refuseIfStarted(tx, projectId);
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO proj.material_budget (project_id, revision, source, reason, created_by, updated_by)
        VALUES (${projectId}, 0, 'blank', '', ${claims.sub}, ${claims.sub}) RETURNING id`;
      await audit(tx, claims.sub, 'material_budget.blank', 'material_budget', b!.id, { projectId });
      return b!.id;
    });
    return this.get(claims, id);
  }

  private async refuseIfStarted(tx: TransactionSql, projectId: string) {
    const [x] =
      await tx`SELECT 1 FROM proj.material_budget WHERE project_id = ${projectId} LIMIT 1`;
    if (x)
      throw new ConflictException({
        code: 'budget_exists',
        message: 'This project already has a material budget: revise it instead.',
      });
  }

  // --- revising ---

  /** A new revision, a copy of the budget in force, to change. */
  async revise(claims: TenantClaims, projectId: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mayKeep(db, claims, projectId);
    const id = await db.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`material_budget:${projectId}`}))`;
      const [open] = await tx`SELECT 1 FROM proj.material_budget WHERE project_id = ${projectId}
        AND status IN ('draft', 'submitted', 'rejected')`;
      if (open)
        throw new ConflictException({
          code: 'revision_open',
          message: 'A revision is already being worked on: finish or discard it first.',
        });
      const [cur] = await tx<BudgetRow[]>`
        SELECT * FROM proj.material_budget WHERE project_id = ${projectId} AND status = 'approved'`;
      if (!cur)
        throw new ConflictException({
          code: 'no_budget_in_force',
          message: 'There is no approved budget to revise yet.',
        });
      const [n] = await tx<{ next: number }[]>`
        SELECT max(revision) + 1 AS next FROM proj.material_budget WHERE project_id = ${projectId}`;
      const next = n!.next;
      const [b] = await tx<{ id: string }[]>`
        INSERT INTO proj.material_budget (project_id, revision, source, based_on, reason, total, created_by,
          updated_by)
        VALUES (${projectId}, ${next}, 'revision', ${cur.id}, ${reason}, ${cur.total}, ${claims.sub}, ${claims.sub})
        RETURNING id`;
      await tx`
        INSERT INTO proj.material_budget_line (budget_id, resource_id, code, name, kind, unit, qty, rate, amount, note)
        SELECT ${b!.id}, resource_id, code, name, kind, unit, qty, rate, amount, note
        FROM proj.material_budget_line WHERE budget_id = ${cur.id}`;
      await audit(tx, claims.sub, 'material_budget.revise', 'material_budget', b!.id, {
        projectId,
        revision: next,
        reason,
      });
      return b!.id;
    });
    return this.get(claims, id);
  }

  /** Replaces a draft (or rejected) revision's lines and reason. */
  async update(
    claims: TenantClaims,
    id: string,
    rowVersion: number,
    input: { reason: string; lines: BudgetLineInput[] },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.row(db, id);
    await this.mayKeep(db, claims, b.project_id);
    if (!EDITABLE.includes(b.status))
      throw new ConflictException({
        code: 'not_editable',
        message:
          b.status === 'submitted'
            ? 'It is waiting for approval: withdraw it to change it.'
            : 'A budget in force (or replaced) is not changed: start a revision.',
      });
    const ids = input.lines.map((l) => l.resourceId);
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException({
        code: 'duplicate_resource',
        message: 'Each resource once: add its quantities together.',
      });
    await db.begin(async (tx) => {
      const [u] = await tx`
        UPDATE proj.material_budget SET reason = ${input.reason}, status = 'draft', status_reason = NULL,
          updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${id} AND row_version = ${rowVersion} AND status IN ('draft', 'rejected') RETURNING id`;
      if (!u) throw stale();
      // Resources already in the revision keep the code, name and unit they were copied with.
      const known = await tx<
        { resource_id: string; code: string; name: string; kind: string; unit: string }[]
      >`
        SELECT resource_id, code, name, kind, unit FROM proj.material_budget_line WHERE budget_id = ${id}`;
      const fresh = ids.filter((r) => !known.some((k) => k.resource_id === r));
      const lib = fresh.length
        ? await tx<{ id: string; code: string; name: string; kind: string; unit: string }[]>`
            SELECT id, code, name, kind, unit FROM est.resource WHERE id = ANY(${fresh}::uuid[]) AND active`
        : [];
      if (lib.length !== fresh.length)
        throw new BadRequestException({
          code: 'resource_not_found',
          message: 'A resource is not in the rate library (or no longer used).',
        });
      await tx`DELETE FROM proj.material_budget_line WHERE budget_id = ${id}`;
      await this.writeLines(
        tx,
        id,
        input.lines.map((l) => {
          const k = known.find((x) => x.resource_id === l.resourceId);
          const r = k ?? lib.find((x) => x.id === l.resourceId)!;
          return {
            resourceId: l.resourceId,
            code: r.code,
            name: r.name,
            kind: r.kind,
            unit: r.unit,
            qty: l.qty,
            rate: l.rate,
            note: l.note,
          };
        }),
      );
      await audit(tx, claims.sub, 'material_budget.update', 'material_budget', id, {
        lines: input.lines.length,
      });
    });
    return this.get(claims, id);
  }

  private async writeLines(
    tx: TransactionSql,
    id: string,
    lines: {
      resourceId: string;
      code: string;
      name: string;
      kind: string;
      unit: string;
      qty: string;
      rate: string | null;
      note: string;
    }[],
  ) {
    for (let i = 0; i < lines.length; i += 5_000) {
      const c = lines.slice(i, i + 5_000);
      await tx`
        INSERT INTO proj.material_budget_line (budget_id, resource_id, code, name, kind, unit, qty, rate, amount, note)
        SELECT ${id}, t.r::uuid, t.code, t.name, t.kind, t.unit, t.q::numeric, t.rate::numeric,
          round(t.q::numeric * t.rate::numeric, 2), t.note
        FROM unnest(${c.map((l) => l.resourceId)}::text[], ${c.map((l) => l.code)}::text[],
          ${c.map((l) => l.name)}::text[], ${c.map((l) => l.kind)}::text[], ${c.map((l) => l.unit)}::text[],
          ${c.map((l) => l.qty)}::text[], ${c.map((l) => l.rate)}::text[], ${c.map((l) => l.note)}::text[])
          AS t(r, code, name, kind, unit, q, rate, note)`;
    }
    await tx`UPDATE proj.material_budget SET total = (SELECT coalesce(sum(amount), 0)
      FROM proj.material_budget_line WHERE budget_id = ${id}) WHERE id = ${id}`;
  }

  /**
   * Sends a revision for approval. Revision 0 is approved for its total; a later one for what it adds to the budget
   * in force (nothing, if it takes away). With no rule for that amount it is in force at once.
   */
  async submit(claims: TenantClaims, id: string, rowVersion: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.row(db, id);
    await this.mayKeep(db, claims, b.project_id);
    await db.begin(async (tx) => {
      const cur = await this.row(tx, id, true);
      if (cur.row_version !== rowVersion) throw stale();
      if (!EDITABLE.includes(cur.status))
        throw new ConflictException({
          code: 'not_submittable',
          message: 'This revision cannot be submitted.',
        });
      const [inForce] = await tx<{ total: string }[]>`
        SELECT total::text FROM proj.material_budget WHERE project_id = ${cur.project_id} AND status = 'approved'`;
      const delta = inForce ? cents(cur.total) - cents(inForce.total) : cents(cur.total);
      const [p] = await tx<
        { number: string }[]
      >`SELECT number FROM proj.project WHERE id = ${cur.project_id}`;
      const res = await this.approvals.submit(tx, claims, {
        docType: MATERIAL_BUDGET,
        docId: id,
        projectId: cur.project_id,
        title: `${p!.number} material budget, revision ${cur.revision}`,
        amount: fromCents(delta > 0n ? delta : 0n),
      });
      await tx`UPDATE proj.material_budget SET status = 'submitted', status_reason = NULL, updated_at = now(),
        updated_by = ${claims.sub}, row_version = row_version + 1 WHERE id = ${id}`;
      if (res.status === 'approved') await this.putInForce(tx, id, cur.project_id);
      await audit(tx, claims.sub, 'material_budget.submit', 'material_budget', id, {
        status: res.status,
      });
    });
    return this.get(claims, id);
  }

  private async putInForce(tx: TransactionSql, id: string, projectId: string) {
    await tx`UPDATE proj.material_budget SET status = 'superseded', row_version = row_version + 1
      WHERE project_id = ${projectId} AND status = 'approved'`;
    await tx`UPDATE proj.material_budget SET status = 'approved', approved_at = now(), row_version = row_version + 1
      WHERE id = ${id}`;
  }

  private async decided(
    tx: TransactionSql,
    id: string,
    outcome: Outcome,
    claims: TenantClaims,
    comment: string | null,
  ) {
    const [b] = await tx<
      BudgetRow[]
    >`SELECT * FROM proj.material_budget WHERE id = ${id} FOR UPDATE`;
    if (outcome === 'approved') await this.putInForce(tx, id, b!.project_id);
    else
      await tx`UPDATE proj.material_budget SET status = ${outcome === 'rejected' ? 'rejected' : 'draft'},
        status_reason = ${outcome === 'rejected' ? comment : null}, updated_by = ${claims.sub},
        row_version = row_version + 1 WHERE id = ${id}`;
  }

  /** Throws away a revision being worked on (not revision 0, which is the budget's start). */
  async discard(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.row(db, id);
    await this.mayKeep(db, claims, b.project_id);
    if (!EDITABLE.includes(b.status) || b.revision === 0)
      throw new ConflictException({
        code: 'not_discardable',
        message:
          b.status === 'submitted'
            ? 'It is waiting for approval: withdraw it first.'
            : 'Only a later revision being worked on can be discarded.',
      });
    await db.begin(async (tx) => {
      // Never submitted: gone. Submitted before: its approval history is kept, so the revision is kept, discarded.
      const [history] =
        await tx`SELECT 1 FROM platform.approval_request WHERE doc_type = ${MATERIAL_BUDGET}
        AND doc_id = ${id} LIMIT 1`;
      if (history)
        await tx`UPDATE proj.material_budget SET status = 'discarded', updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1 WHERE id = ${id}`;
      else {
        await tx`DELETE FROM proj.material_budget_line WHERE budget_id = ${id}`;
        await tx`DELETE FROM proj.material_budget WHERE id = ${id}`;
      }
      await audit(tx, claims.sub, 'material_budget.discard', 'material_budget', id, {
        revision: b.revision,
      });
    });
    return this.overview(claims, b.project_id);
  }

  // --- reading ---

  /** The project's budget: the revision in force, the one being worked on, all of them, and what can be done. */
  async overview(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.projects.access(db, claims, projectId);
    const revisions = await db<
      {
        id: string;
        revision: number;
        status: BudgetStatus;
        reason: string;
        source: string;
        total: string;
        createdBy: string | null;
        createdAt: string;
        approvedAt: string | null;
        lines: number;
      }[]
    >`
      SELECT b.id, b.revision, b.status, b.reason, b.source, b.total::text AS total, u.display_name AS "createdBy",
        b.created_at AS "createdAt", b.approved_at AS "approvedAt",
        (SELECT count(*)::int FROM proj.material_budget_line l WHERE l.budget_id = b.id) AS lines
      FROM proj.material_budget b LEFT JOIN platform."user" u ON u.id = b.created_by
      WHERE b.project_id = ${projectId} ORDER BY b.revision DESC`;
    const [p] = await db<{ tender: boolean }[]>`
      SELECT p.tender_id IS NOT NULL AS tender FROM proj.project p WHERE p.id = ${projectId}`;
    return {
      inForce: revisions.find((r) => r.status === 'approved') ?? null,
      open: revisions.find((r) => OPEN.includes(r.status)) ?? null,
      revisions,
      mayKeep: a.canEdit,
      mayStart: a.canEdit && revisions.length === 0,
      /** Came from a tender here: the budget is made from it (once its contract BOQ is copied). */
      fromTender: p!.tender,
    };
  }

  private async head(db: Db, id: string) {
    const [h] = await db<
      {
        id: string;
        projectId: string;
        project: { id: string; number: string; name: string };
        revision: number;
        status: BudgetStatus;
        statusReason: string | null;
        reason: string;
        source: string;
        basis: { boqs?: unknown[]; items?: number; changedItems?: number };
        basedOn: { id: string; revision: number } | null;
        total: string;
        createdBy: string | null;
        createdAt: string;
        approvedAt: string | null;
        rowVersion: number;
      }[]
    >`
      SELECT b.id, b.project_id AS "projectId",
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project, b.revision, b.status,
        b.status_reason AS "statusReason", b.reason, b.source, b.basis,
        CASE WHEN o.id IS NULL THEN NULL ELSE json_build_object('id', o.id, 'revision', o.revision) END AS "basedOn",
        b.total::text AS total, u.display_name AS "createdBy", b.created_at AS "createdAt",
        b.approved_at AS "approvedAt", b.row_version AS "rowVersion"
      FROM proj.material_budget b
      JOIN proj.project p ON p.id = b.project_id
      LEFT JOIN proj.material_budget o ON o.id = b.based_on
      LEFT JOIN platform."user" u ON u.id = b.created_by
      WHERE b.id = ${id}`;
    if (!h) throw new NotFoundException({ code: 'budget_not_found' });
    return h;
  }

  /** A revision's lines with the revision before it and what the project's requisitions already take of each. */
  private async lines(db: Db, id: string, projectId: string) {
    return db<
      {
        resourceId: string;
        code: string;
        name: string;
        kind: string;
        unit: string;
        qty: string;
        rate: string | null;
        amount: string | null;
        note: string;
        prevQty: string | null;
        prevAmount: string | null;
        requisitioned: string;
      }[]
    >`
      WITH used AS (
        SELECT l.resource_id, sum(l.qty) AS qty FROM proc.requisition r
        JOIN proc.requisition_line l ON l.requisition_id = r.id
        WHERE r.project_id = ${projectId} AND r.status IN ('submitted', 'approved') AND l.resource_id IS NOT NULL
        GROUP BY l.resource_id
      ),
      prev AS (
        SELECT pl.* FROM proj.material_budget b JOIN proj.material_budget_line pl ON pl.budget_id = b.based_on
        WHERE b.id = ${id}
      )
      SELECT coalesce(l.resource_id, prev.resource_id) AS "resourceId", coalesce(l.code, prev.code) AS code,
        coalesce(l.name, prev.name) AS name, coalesce(l.kind, prev.kind) AS kind, coalesce(l.unit, prev.unit) AS unit,
        coalesce(l.qty, 0)::text AS qty, l.rate::text AS rate, l.amount::text AS amount, coalesce(l.note, '') AS note,
        prev.qty::text AS "prevQty", prev.amount::text AS "prevAmount",
        coalesce(used.qty, 0)::text AS requisitioned
      FROM (SELECT * FROM proj.material_budget_line WHERE budget_id = ${id}) l
      FULL JOIN prev ON prev.resource_id = l.resource_id
      LEFT JOIN used ON used.resource_id = coalesce(l.resource_id, prev.resource_id)
      ORDER BY CASE coalesce(l.kind, prev.kind) WHEN 'material' THEN 0 WHEN 'labour' THEN 1 WHEN 'equipment' THEN 2
        WHEN 'subcontract' THEN 3 ELSE 4 END, lower(coalesce(l.code, prev.code))`;
  }

  private async summary(db: Db, id: string) {
    const h = await this.head(db, id);
    return { ...h, lines: await this.lines(db, id, h.projectId) };
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const b = await this.row(db, id);
    const a = await this.projects.access(db, claims, b.project_id);
    const h = await this.head(db, id);
    const lines = await this.lines(db, id, b.project_id);
    return {
      ...h,
      lines,
      approval: await this.approvals.latestFor(db, claims, MATERIAL_BUDGET, id),
      mayEdit: a.canEdit && EDITABLE.includes(b.status),
      maySubmit: a.canEdit && EDITABLE.includes(b.status),
      mayDiscard: a.canEdit && EDITABLE.includes(b.status) && b.revision > 0,
    };
  }

  // --- demand ---

  /** The budget in force, per resource: quantity and rate, and what the project's requisitions take of it. */
  async inForceUse(db: Db, projectId: string) {
    return db<
      { resource_id: string; qty: string; rate: string | null; unit: string; used: string }[]
    >`
      SELECT l.resource_id, l.qty::text AS qty, l.rate::text AS rate, l.unit,
        coalesce((SELECT sum(rl.qty) FROM proc.requisition r JOIN proc.requisition_line rl ON rl.requisition_id = r.id
          WHERE r.project_id = ${projectId} AND r.status IN ('submitted', 'approved')
            AND rl.resource_id = l.resource_id), 0)::text AS used
      FROM proj.material_budget b JOIN proj.material_budget_line l ON l.budget_id = b.id
      WHERE b.project_id = ${projectId} AND b.status = 'approved'`;
  }

  /** What a quantity of work on a contract BOQ item (by its code) takes of each resource, by its norms. */
  async forItem(claims: TenantClaims, projectId: string, code: string, qty: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const items = await db<
      { line_key: string; code: string; description: string; unit: string | null }[]
    >`
      SELECT n.line_key, n.code, t.description, n.unit FROM est.boq b
      JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
      JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
        AND lower(n.code) = lower(${code}) LIMIT 2`;
    if (!items.length)
      throw new BadRequestException({
        code: 'boq_item_not_found',
        message: `No item ${code} in the project's contract BOQ.`,
      });
    if (items.length > 1)
      throw new BadRequestException({
        code: 'boq_item_ambiguous',
        message: `More than one contract BOQ item is coded ${code}.`,
      });
    const it = items[0]!;
    const lines = await this.demandLines(
      db,
      projectId,
      db`
      SELECT resource_id, round(per_unit * ${qty}::numeric, 4) AS qty FROM proj.material_norm
      WHERE project_id = ${projectId} AND line_key = ${it.line_key}`,
    );
    return { item: { code: it.code, description: it.description, unit: it.unit }, qty, lines };
  }

  /**
   * What the next weeks' work takes: the contract BOQ items carried out by activities on or due between each live
   * schedule's data date and the weeks after it, for the work on them not yet measured, by their norms.
   */
  async lookahead(claims: TenantClaims, projectId: string, weeks: number) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const work = db`
      WITH items AS (
        SELECT DISTINCT al.line_key FROM sched.plan p
        JOIN sched.activity a ON a.plan_id = p.id AND a.kind <> 'summary' AND a.status <> 'finished'
        JOIN sched.activity_line al ON al.plan_id = a.plan_id AND al.activity_id = a.id
        WHERE p.project_id = ${projectId} AND p.kind = 'project_schedule' AND p.archived_at IS NULL
          AND a.early_start < coalesce(p.data_date, p.start_on) + ${weeks * 7}::int
          AND a.early_finish >= coalesce(p.data_date, p.start_on)
      ),
      left_to_do AS (
        SELECT i.line_key, greatest(n.qty - coalesce((SELECT sum(m.qty) FROM proj.measurement m
          WHERE m.project_id = ${projectId} AND m.line_key = i.line_key), 0), 0) AS qty
        FROM items i JOIN est.boq b ON b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
        JOIN est.boq_node n ON n.boq_id = b.id AND n.line_key = i.line_key AND n.node_type = 'item'
      )
      SELECT nm.resource_id, round(sum(nm.per_unit * w.qty), 4) AS qty
      FROM left_to_do w JOIN proj.material_norm nm ON nm.project_id = ${projectId} AND nm.line_key = w.line_key
      GROUP BY nm.resource_id`;
    const [count] = await db<{ items: number }[]>`
      SELECT count(DISTINCT al.line_key)::int AS items FROM sched.plan p
      JOIN sched.activity a ON a.plan_id = p.id AND a.kind <> 'summary' AND a.status <> 'finished'
      JOIN sched.activity_line al ON al.plan_id = a.plan_id AND al.activity_id = a.id
      WHERE p.project_id = ${projectId} AND p.kind = 'project_schedule' AND p.archived_at IS NULL
        AND a.early_start < coalesce(p.data_date, p.start_on) + ${weeks * 7}::int
        AND a.early_finish >= coalesce(p.data_date, p.start_on)`;
    return {
      weeks,
      items: count!.items,
      asOf: indiaToday(),
      lines: await this.demandLines(db, projectId, work),
    };
  }

  /** Resource quantities with what the library and the budget in force say of each. */
  private async demandLines(
    db: Db,
    projectId: string,
    need: ReturnType<Db['unsafe']> | ReturnType<typeof db>,
  ) {
    const rows = await db<
      {
        resourceId: string;
        code: string;
        name: string;
        kind: string;
        unit: string;
        qty: string;
        rate: string | null;
        budgetQty: string | null;
        requisitioned: string;
      }[]
    >`
      WITH need AS (${need}),
      used AS (
        SELECT rl.resource_id, sum(rl.qty) AS qty FROM proc.requisition r
        JOIN proc.requisition_line rl ON rl.requisition_id = r.id
        WHERE r.project_id = ${projectId} AND r.status IN ('submitted', 'approved') GROUP BY rl.resource_id
      )
      SELECT r.id AS "resourceId", r.code, r.name, r.kind, r.unit, need.qty::text AS qty,
        coalesce(bl.rate, (SELECT rr.rate FROM est.resource_rate rr WHERE rr.resource_id = r.id
          AND rr.effective_from <= ${indiaToday()}::date ORDER BY rr.effective_from DESC LIMIT 1))::text AS rate,
        bl.qty::text AS "budgetQty", coalesce(used.qty, 0)::text AS requisitioned
      FROM need JOIN est.resource r ON r.id = need.resource_id
      LEFT JOIN proj.material_budget b ON b.project_id = ${projectId} AND b.status = 'approved'
      LEFT JOIN proj.material_budget_line bl ON bl.budget_id = b.id AND bl.resource_id = r.id
      LEFT JOIN used ON used.resource_id = r.id
      WHERE need.qty > 0
      ORDER BY CASE r.kind WHEN 'material' THEN 0 WHEN 'labour' THEN 1 WHEN 'equipment' THEN 2 ELSE 3 END,
        lower(r.code)`;
    return rows;
  }
}
