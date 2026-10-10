// A project's macro plan (docs/04-features.md J5, docs/wave2a-plan.md step 5): its live schedules (the micro plans)
// rolled up through the WBS, computed when asked for. Each WBS element gets the span of the activities on it and under
// it, the span of the same in the baselines shown, the slip of its finish against that, progress by working days, and
// how many activities are done, going, critical. The same by package, trade and zone; and every milestone, with its
// baseline date.
import { Injectable } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { treeOrder } from '../project/cost-code.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dayNumber } from '@aerolith/shared';

export type GroupBy = 'wbs' | 'package' | 'trade' | 'zone';

/** What a set of activities adds up to. */
interface Tally {
  activities: number;
  finished: number;
  inProgress: number;
  critical: number;
  start: string | null;
  finish: string | null;
  baselineStart: string | null;
  baselineFinish: string | null;
  /** Working days of all of them, and of the work done. */
  days: number;
  doneDays: number;
}

const EMPTY: Tally = {
  activities: 0,
  finished: 0,
  inProgress: 0,
  critical: 0,
  start: null,
  finish: null,
  baselineStart: null,
  baselineFinish: null,
  days: 0,
  doneDays: 0,
};

const min = (a: string | null, b: string | null) => (a === null ? b : b === null || a < b ? a : b);
const max = (a: string | null, b: string | null) => (a === null ? b : b === null || a > b ? a : b);

function addInto(t: Tally, x: Tally) {
  t.activities += x.activities;
  t.finished += x.finished;
  t.inProgress += x.inProgress;
  t.critical += x.critical;
  t.start = min(t.start, x.start);
  t.finish = max(t.finish, x.finish);
  t.baselineStart = min(t.baselineStart, x.baselineStart);
  t.baselineFinish = max(t.baselineFinish, x.baselineFinish);
  t.days += x.days;
  t.doneDays += x.doneDays;
}

/** The tally as shown: progress in percent by working days, and the finish against the baseline in days. */
const view = (t: Tally) => ({
  activities: t.activities,
  finished: t.finished,
  inProgress: t.inProgress,
  critical: t.critical,
  start: t.start,
  finish: t.finish,
  baselineStart: t.baselineStart,
  baselineFinish: t.baselineFinish,
  progressPct: t.days > 0 ? Math.round((t.doneDays / t.days) * 1000) / 10 : null,
  slipDays: t.finish && t.baselineFinish ? dayNumber(t.finish) - dayNumber(t.baselineFinish) : null,
});

@Injectable()
export class MacroService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  async macro(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const schedules = await db<
      {
        id: string;
        name: string;
        dataDate: string;
        finishOn: string | null;
        activityCount: number;
        baseline: { name: string; finishOn: string | null } | null;
      }[]
    >`
      SELECT p.id, p.name, to_char(coalesce(p.data_date, p.start_on), 'YYYY-MM-DD') AS "dataDate",
        to_char(p.finish_on, 'YYYY-MM-DD') AS "finishOn", p.activity_count AS "activityCount",
        (SELECT json_build_object('name', b.name, 'finishOn', to_char(b.finish_on, 'YYYY-MM-DD'))
          FROM sched.baseline b WHERE b.id = p.baseline_id) AS baseline
      FROM sched.plan p
      WHERE p.project_id = ${projectId} AND p.kind = 'project_schedule' AND p.archived_at IS NULL
      ORDER BY p.created_at`;
    const ids = schedules.map((s) => s.id);
    // Activities of the live schedules, summaries left out (they are spans of the same), with their baseline dates.
    const live = db`
      SELECT a.*, b.start_on AS bl_start, b.finish_on AS bl_finish
      FROM sched.plan p
      JOIN sched.activity a ON a.plan_id = p.id
      LEFT JOIN sched.baseline_activity b ON b.plan_id = a.plan_id AND b.baseline_id = p.baseline_id
        AND b.activity_id = a.id
      WHERE p.id = ANY(${ids}::uuid[]) AND a.kind <> 'summary'`;
    const groups = await db<(Tally & { by: GroupBy; key: string | null })[]>`
      WITH a AS (${live})
      SELECT CASE WHEN GROUPING(wbs_id) = 0 THEN 'wbs' WHEN GROUPING(package) = 0 THEN 'package'
          WHEN GROUPING(trade) = 0 THEN 'trade' ELSE 'zone' END AS by,
        coalesce(wbs_id::text, package, trade, zone) AS key,
        count(*)::int AS activities,
        count(*) FILTER (WHERE status = 'finished')::int AS finished,
        count(*) FILTER (WHERE status = 'in_progress')::int AS "inProgress",
        count(*) FILTER (WHERE critical AND status <> 'finished')::int AS critical,
        to_char(min(early_start), 'YYYY-MM-DD') AS start, to_char(max(early_finish), 'YYYY-MM-DD') AS finish,
        to_char(min(bl_start), 'YYYY-MM-DD') AS "baselineStart",
        to_char(max(bl_finish), 'YYYY-MM-DD') AS "baselineFinish",
        coalesce(sum(duration), 0)::int AS days,
        coalesce(sum(CASE status WHEN 'finished' THEN duration
          WHEN 'in_progress' THEN greatest(duration - coalesce(remaining_left, 0), 0) ELSE 0 END), 0)::int
          AS "doneDays"
      FROM a
      GROUP BY GROUPING SETS ((wbs_id), (package), (trade), (zone))`;
    const of = (by: GroupBy) => groups.filter((g) => g.by === by);

    // The WBS: each element with what is on it, then everything under it added in (children follow parents).
    const nodes = treeOrder(
      await db<
        { id: string; parentId: string | null; code: string; name: string; position: number }[]
      >`
        SELECT id, parent_id AS "parentId", code, name, position FROM proj.wbs WHERE project_id = ${projectId}`,
      (a, b) => a.position - b.position || a.code.localeCompare(b.code, 'en', { numeric: true }),
    );
    const total = new Map(nodes.map((n) => [n.id, { ...EMPTY }]));
    for (const g of of('wbs')) if (g.key && total.has(g.key)) addInto(total.get(g.key)!, g);
    const parentOf = new Map(nodes.map((n) => [n.id, n.parentId]));
    for (const n of [...nodes].reverse()) {
      const p = parentOf.get(n.id);
      if (p && total.has(p)) addInto(total.get(p)!, total.get(n.id)!);
    }
    const project = { ...EMPTY };
    for (const g of of('wbs')) addInto(project, g);
    const unassigned = of('wbs').find((g) => g.key === null);

    const byValue = (by: Exclude<GroupBy, 'wbs'>) =>
      of(by)
        .sort((a, b) =>
          a.key === null
            ? 1
            : b.key === null
              ? -1
              : a.key.localeCompare(b.key, 'en', { numeric: true }),
        )
        .map((g) => ({ key: g.key, ...view(g) }));

    const milestones = await db`
      WITH a AS (${live})
      SELECT a.id::text AS id, a.plan_id AS "planId", p.name AS schedule, a.code, a.name,
        to_char(a.early_start, 'YYYY-MM-DD') AS date, to_char(a.bl_start, 'YYYY-MM-DD') AS "baselineDate",
        to_char(a.actual_start, 'YYYY-MM-DD') AS "actualDate", a.status, a.critical, w.code AS "wbsCode",
        CASE WHEN a.bl_start IS NULL THEN NULL ELSE (a.early_start - a.bl_start) END AS "slipDays"
      FROM a JOIN sched.plan p ON p.id = a.plan_id LEFT JOIN proj.wbs w ON w.id = a.wbs_id
      WHERE a.kind = 'milestone'
      ORDER BY a.early_start NULLS LAST, a.code LIMIT 1000`;

    return {
      schedules,
      project: view(project),
      wbs: nodes.map((n) => ({
        id: n.id,
        parentId: n.parentId,
        code: n.code,
        name: n.name,
        depth: n.depth,
        ...view(total.get(n.id)!),
      })),
      unassigned: unassigned ? view(unassigned) : null,
      milestones,
      byPackage: byValue('package'),
      byTrade: byValue('trade'),
      byZone: byValue('zone'),
    };
  }

  /** The packages, trades and zones the project's activities already use, to offer them again. */
  async groupValues(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const rows = await db<{ by: 'package' | 'trade' | 'zone'; value: string }[]>`
      SELECT DISTINCT x.by, x.value
      FROM sched.plan p JOIN sched.activity a ON a.plan_id = p.id
      CROSS JOIN LATERAL (VALUES ('package', a.package), ('trade', a.trade), ('zone', a.zone)) AS x(by, value)
      WHERE p.project_id = ${projectId} AND x.value IS NOT NULL
      ORDER BY 1, 2 LIMIT 600`;
    const pick = (by: string) => rows.filter((r) => r.by === by).map((r) => r.value);
    return { package: pick('package'), trade: pick('trade'), zone: pick('zone') };
  }
}
