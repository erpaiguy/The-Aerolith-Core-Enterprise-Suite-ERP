// Material reconciliation (docs/wave7-plan.md step 7c.2): for a project and a period, what the measured work should
// have taken of each material (each contract BOQ item's measured quantity × its norm from the rate analysis, wastage
// allowed in the analysis worked in) against what the stores issued to the work, net of returns. The difference over
// the theoretical is the wastage beyond the norm; a material issued with no norm shows as unexplained.
import { Injectable } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

export interface ReconciliationRow {
  resource: { id: string; code: string; name: string; unit: string };
  theoretical: string;
  issued: string;
  issuedValue: string;
  difference: string;
  /** Issued over (or under) the theoretical, as a percentage of it; null without a theoretical quantity. */
  overPct: number | null;
  items: number;
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  async reconcile(claims: TenantClaims, projectId: string, q: { from?: string; to?: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const from = q.from ?? '1900-01-01';
    const to = q.to ?? '2999-12-31';
    const rows = await db<(Omit<ReconciliationRow, 'overPct'> & { overPct: string | null })[]>`
      WITH measured AS (
        SELECT line_key, sum(qty) AS qty FROM proj.measurement
        WHERE project_id = ${projectId} AND measured_on BETWEEN ${from} AND ${to} GROUP BY line_key),
      theory AS (
        SELECT n.resource_id, sum(m.qty * n.per_unit) AS qty, count(*)::int AS items
        FROM measured m JOIN proj.material_norm n ON n.project_id = ${projectId} AND n.line_key = m.line_key
        GROUP BY n.resource_id),
      issued AS (
        SELECT m.resource_id, sum(-m.qty) AS qty, sum(-m.value) AS value
        FROM proc.stock_move m JOIN proc.store s ON s.id = m.store_id
        WHERE s.project_id = ${projectId} AND m.kind IN ('issue', 'issue_return')
          AND m.moved_on BETWEEN ${from} AND ${to}
        GROUP BY m.resource_id)
      SELECT json_build_object('id', r.id, 'code', r.code, 'name', r.name, 'unit', r.unit) AS resource,
        round(coalesce(t.qty, 0), 3)::text AS theoretical, round(coalesce(i.qty, 0), 3)::text AS issued,
        round(coalesce(i.value, 0), 2)::text AS "issuedValue",
        round(coalesce(i.qty, 0) - coalesce(t.qty, 0), 3)::text AS difference,
        CASE WHEN coalesce(t.qty, 0) > 0
          THEN round((coalesce(i.qty, 0) - t.qty) / t.qty * 100, 1)::text END AS "overPct",
        coalesce(t.items, 0) AS items
      FROM est.resource r
      LEFT JOIN theory t ON t.resource_id = r.id LEFT JOIN issued i ON i.resource_id = r.id
      WHERE r.kind = 'material' AND (coalesce(t.qty, 0) <> 0 OR coalesce(i.qty, 0) <> 0)
      ORDER BY abs(coalesce(i.value, 0)) DESC, r.code`;
    return {
      from: q.from ?? null,
      to: q.to ?? null,
      rows: rows.map((r) => ({ ...r, overPct: r.overPct === null ? null : Number(r.overPct) })),
    };
  }

  /**
   * Estimate against actual (docs/wave7-plan.md step 7c.3): each measured, analysed item's materials per unit as
   * estimated (its norms) against what was issued to that item (issue lines that name it, net of returns), per unit of
   * work measured; and labour, which the site does not book to items, for the project as a whole: the norms' labour
   * at the budget's rates for the work measured, against the contractors' wage sheets for its sites.
   */
  async estimateVsActual(
    claims: TenantClaims,
    projectId: string,
    q: { from?: string; to?: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const from = q.from ?? '1900-01-01';
    const to = q.to ?? '2999-12-31';
    const lines = await db<
      {
        lineKey: string;
        code: string | null;
        description: string;
        unit: string | null;
        measured: string;
        resource: { id: string; code: string; name: string; unit: string };
        norm: string;
        estimated: string;
        issued: string;
        actualPerUnit: string | null;
        overPct: string | null;
      }[]
    >`
      WITH measured AS (
        SELECT line_key, sum(qty) AS qty FROM proj.measurement
        WHERE project_id = ${projectId} AND measured_on BETWEEN ${from} AND ${to} GROUP BY line_key
        HAVING sum(qty) > 0),
      issued AS (
        SELECT l.line_key, l.resource_id,
          sum(l.qty) - coalesce(sum((SELECT sum(rl.qty) FROM proc.stock_issue_return r
            JOIN proc.stock_issue_return_line rl ON rl.return_id = r.id
            WHERE r.issue_id = i.id AND rl.position = l.position)), 0) AS qty
        FROM proc.stock_issue i JOIN proc.stock_issue_line l ON l.issue_id = i.id
        WHERE i.project_id = ${projectId} AND l.line_key IS NOT NULL AND i.issued_on BETWEEN ${from} AND ${to}
        GROUP BY l.line_key, l.resource_id)
      SELECT m.line_key AS "lineKey", b.code, coalesce(t.description, '') AS description, b.unit,
        m.qty::text AS measured,
        json_build_object('id', r.id, 'code', r.code, 'name', r.name, 'unit', r.unit) AS resource,
        round(n.per_unit, 4)::text AS norm, round(m.qty * n.per_unit, 3)::text AS estimated,
        round(coalesce(x.qty, 0), 3)::text AS issued,
        round(coalesce(x.qty, 0) / m.qty, 4)::text AS "actualPerUnit",
        CASE WHEN n.per_unit > 0 THEN round((coalesce(x.qty, 0) - m.qty * n.per_unit) / (m.qty * n.per_unit) * 100, 1)::text
        END AS "overPct"
      FROM measured m
      JOIN proj.material_norm n ON n.project_id = ${projectId} AND n.line_key = m.line_key
      JOIN est.resource r ON r.id = n.resource_id AND r.kind = 'material'
      LEFT JOIN issued x ON x.line_key = m.line_key AND x.resource_id = n.resource_id
      LEFT JOIN LATERAL (
        SELECT nd.boq_id, nd.id, nd.code, nd.unit FROM est.boq_node nd JOIN est.boq bq ON bq.id = nd.boq_id
        WHERE nd.line_key = m.line_key AND bq.project_id = ${projectId} AND bq.kind = 'contract' LIMIT 1) b ON true
      LEFT JOIN est.boq_node_text t ON t.boq_id = b.boq_id AND t.node_id = b.id
      ORDER BY b.code NULLS LAST, r.code`;
    const items = new Map<
      string,
      {
        lineKey: string;
        code: string | null;
        description: string;
        unit: string | null;
        measured: string;
        materials: {
          resource: { id: string; code: string; name: string; unit: string };
          norm: string;
          estimated: string;
          issued: string;
          actualPerUnit: string | null;
          overPct: number | null;
        }[];
      }
    >();
    for (const l of lines) {
      const it = items.get(l.lineKey) ?? {
        lineKey: l.lineKey,
        code: l.code,
        description: l.description,
        unit: l.unit,
        measured: l.measured,
        materials: [],
      };
      it.materials.push({
        resource: l.resource,
        norm: l.norm,
        estimated: l.estimated,
        issued: l.issued,
        actualPerUnit: l.actualPerUnit,
        overPct: l.overPct === null ? null : Number(l.overPct),
      });
      items.set(l.lineKey, it);
    }
    const labour = await db<
      { resource: { code: string; name: string; unit: string }; qty: string; cost: string }[]
    >`
      WITH measured AS (
        SELECT line_key, sum(qty) AS qty FROM proj.measurement
        WHERE project_id = ${projectId} AND measured_on BETWEEN ${from} AND ${to} GROUP BY line_key),
      rate AS (
        -- The budget in force's rate, else the last one an earlier revision gave (a line taken out keeps its rate).
        SELECT DISTINCT ON (l.resource_id) l.resource_id, l.rate FROM proj.material_budget_line l
        JOIN proj.material_budget b ON b.id = l.budget_id
        WHERE b.project_id = ${projectId} AND b.status IN ('approved', 'superseded') AND l.rate IS NOT NULL
        ORDER BY l.resource_id, b.status = 'approved' DESC, b.revision DESC)
      SELECT json_build_object('code', r.code, 'name', r.name, 'unit', r.unit) AS resource,
        round(sum(m.qty * n.per_unit), 3)::text AS qty, round(sum(m.qty * n.per_unit * coalesce(x.rate, 0)), 2)::text AS cost
      FROM measured m JOIN proj.material_norm n ON n.project_id = ${projectId} AND n.line_key = m.line_key
      JOIN est.resource r ON r.id = n.resource_id AND r.kind = 'labour'
      LEFT JOIN rate x ON x.resource_id = r.id
      GROUP BY r.id, r.code, r.name, r.unit ORDER BY r.code`;
    const [paid] = await db<{ total: string }[]>`
      SELECT coalesce(sum(w.total), 0)::text AS total FROM lab.wage_sheet w JOIN proj.site s ON s.id = w.site_id
      WHERE s.project_id = ${projectId} AND w.status IN ('passed', 'verified')
        AND w.month BETWEEN date_trunc('month', ${from}::date) AND ${to}::date`;
    const estimatedCost = labour.reduce((n, l) => n + Math.round(Number(l.cost) * 100), 0) / 100;
    return {
      from: q.from ?? null,
      to: q.to ?? null,
      items: [...items.values()],
      labour: {
        estimated: labour,
        estimatedCost: estimatedCost.toFixed(2),
        actualCost: paid?.total ?? '0',
      },
    };
  }
}
