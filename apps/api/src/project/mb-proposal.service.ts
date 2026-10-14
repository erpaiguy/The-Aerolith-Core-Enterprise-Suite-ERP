// Daily reports into the measurement book (docs/wave7-plan.md step 7c.1): at the month's end, what the site reported
// done against each contract BOQ item in its submitted daily reports, less what the book already has for that month,
// is proposed; the team reviews the figures and accepts them, and each becomes a measurement dated the month's last day
// (or today, in the month still running). Nothing reaches the book without a person accepting it.
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { ProjectService } from './project.service.js';

export interface ProposalLine {
  boqId: string;
  lineKey: string;
  qty: string;
}

const indiaToday = (now = new Date()) =>
  new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);

/** The month's first and last day, and the day accepted figures are booked on. */
export function monthSpan(month: string, today = indiaToday()) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = `${month}-01`;
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  if (from > today)
    throw new BadRequestException({
      code: 'future_month',
      message: 'That month is still to come.',
    });
  return { from, to, bookOn: to < today ? to : today };
}

@Injectable()
export class MbProposalService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  async proposal(claims: TenantClaims, projectId: string, month: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const access = await this.projects.access(db, claims, projectId);
    const { from, to, bookOn } = monthSpan(month);
    const lines = await db<
      {
        boqId: string;
        boq: string;
        lineId: string;
        lineKey: string;
        code: string | null;
        description: string;
        unit: string | null;
        contractQty: string | null;
        reported: string;
        reports: number;
        measured: string;
        proposed: string;
      }[]
    >`
      WITH reported AS (
        SELECT w.line_key, sum(w.qty) AS qty, count(DISTINCT r.id)::int AS reports
        FROM proj.daily_report r JOIN proj.dr_work w ON w.report_id = r.id
        WHERE r.project_id = ${projectId} AND r.status <> 'draft' AND r.report_date BETWEEN ${from} AND ${to}
          AND w.line_key IS NOT NULL AND w.qty > 0
        GROUP BY w.line_key),
      measured AS (
        SELECT line_key, sum(qty) AS qty FROM proj.measurement
        WHERE project_id = ${projectId} AND measured_on BETWEEN ${from} AND ${to} GROUP BY line_key)
      SELECT n.boq_id AS "boqId", n.boq, n.id::text AS "lineId", r.line_key AS "lineKey", n.code,
        coalesce(t.description, '') AS description, n.unit, n.qty::text AS "contractQty", r.qty::text AS reported,
        r.reports, coalesce(m.qty, 0)::text AS measured, greatest(r.qty - coalesce(m.qty, 0), 0)::text AS proposed
      FROM reported r
      JOIN LATERAL (
        SELECT n.boq_id, b.name AS boq, n.id, n.code, n.unit, n.qty FROM est.boq_node n JOIN est.boq b ON b.id = n.boq_id
        WHERE n.line_key = r.line_key AND b.project_id = ${projectId} AND b.kind = 'contract'
          AND b.archived_at IS NULL AND n.node_type = 'item'
        LIMIT 1) n ON true
      LEFT JOIN est.boq_node_text t ON t.boq_id = n.boq_id AND t.node_id = n.id
      LEFT JOIN measured m ON m.line_key = r.line_key
      ORDER BY n.boq, n.code NULLS LAST`;
    return {
      month,
      from,
      to,
      bookOn,
      lines,
      mayAccept: access.canEdit || access.role === 'member',
    };
  }

  /** The reviewed quantities, each a measurement on the booking day. */
  async accept(claims: TenantClaims, projectId: string, month: string, lines: ProposalLine[]) {
    const db = await this.tenants.forTenant(claims.ten);
    const access = await this.projects.access(db, claims, projectId);
    if (!access.canEdit && access.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) records progress.",
      });
    const { bookOn } = monthSpan(month);
    const keep = lines.filter((l) => Number(l.qty) > 0);
    if (!keep.length)
      throw new BadRequestException({
        code: 'nothing_to_accept',
        message: 'No quantity to put in the book.',
      });
    await db.begin(async (tx) => {
      for (const l of keep) {
        const [n] = await tx`
          SELECT 1 FROM est.boq_node n JOIN est.boq b ON b.id = n.boq_id
          WHERE b.id = ${l.boqId} AND n.line_key = ${l.lineKey} AND b.project_id = ${projectId}
            AND b.kind = 'contract' AND b.archived_at IS NULL AND n.node_type = 'item'`;
        if (!n)
          throw new BadRequestException({
            code: 'not_a_contract_item',
            message: "Every line must be an item of the project's contract BOQ.",
          });
        const [m] = await tx<{ id: string }[]>`
          INSERT INTO proj.measurement (project_id, boq_id, line_key, measured_on, qty, description, created_by)
          VALUES (${projectId}, ${l.boqId}, ${l.lineKey}, ${bookOn}, ${l.qty},
            ${`From the daily reports of ${month}`}, ${claims.sub})
          RETURNING id`;
        await audit(tx, claims.sub, 'progress.from_daily_reports', 'measurement', m!.id, {
          month,
          qty: l.qty,
        });
      }
    });
    return this.proposal(claims, projectId, month);
  }
}
