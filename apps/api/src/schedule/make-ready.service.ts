// Look-ahead with constraints (docs/wave8-plan.md step 8d.2), in the manner of the Last Planner: a make-ready log of
// what each activity in the look-ahead still waits for (drawings, material, the front, approvals, labour), each with an
// owner and a date; the weekly work plan of what the site commits to; and when the week is closed, what was done, the
// percent plan complete and the reasons for the misses.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

type Db = Sql | TransactionSql;

export const CONSTRAINT_KINDS = [
  'drawings',
  'material',
  'front',
  'approvals',
  'labour',
  'equipment',
  'other',
] as const;
export const MISS_REASONS = [
  ...CONSTRAINT_KINDS.filter((k) => k !== 'other'),
  'weather',
  'predecessor',
  'other',
] as const;

/** Percent plan complete: commitments done of those decided, to one place; null before any is decided. */
export function ppc(rows: { done: boolean | null }[]) {
  const decided = rows.filter((r) => r.done !== null);
  if (!decided.length) return null;
  return Math.round((decided.filter((r) => r.done).length / decided.length) * 1000) / 10;
}

/** The Monday of a date's week. */
export function mondayOf(day: string) {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

@Injectable()
export class MakeReadyService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  /** The plan's project, and whether this person may see it or plan on it. */
  private async plan(db: Db, claims: TenantClaims, planId: string, write: boolean) {
    const [p] = await db<{ project_id: string | null; kind: string; as_of: string }[]>`
      SELECT project_id, kind, to_char(coalesce(data_date, start_on), 'YYYY-MM-DD') AS as_of
      FROM sched.plan WHERE id = ${planId}`;
    if (!p) throw new NotFoundException({ code: 'programme_not_found' });
    if (p.kind !== 'project_schedule' || !p.project_id)
      throw new BadRequestException({
        code: 'not_for_tender_programme',
        message: "A tender's programme has no look-ahead.",
      });
    const a = await this.projects.access(db, claims, p.project_id);
    if (write && !a.canEdit && a.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) plans its work.",
      });
    return p;
  }

  // --- the make-ready log ---

  async constraints(claims: TenantClaims, planId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.plan(db, claims, planId, false);
    return this.list(db, planId);
  }

  private list(db: Db, planId: string) {
    return db`
      SELECT c.id, c.activity_id::text AS "activityId", a.code AS "activityCode", a.name AS activity, c.kind,
        c.description, c.owner_id AS "ownerId", u.display_name AS owner, to_char(c.due_on, 'YYYY-MM-DD') AS "dueOn",
        to_char(c.cleared_on, 'YYYY-MM-DD') AS "clearedOn",
        c.cleared_on IS NULL AND c.due_on < (now() AT TIME ZONE 'Asia/Kolkata')::date AS overdue
      FROM sched.constraint_item c JOIN sched.activity a ON a.plan_id = c.plan_id AND a.id = c.activity_id
      LEFT JOIN platform."user" u ON u.id = c.owner_id
      WHERE c.plan_id = ${planId} ORDER BY c.cleared_on IS NOT NULL, c.due_on, a.code`;
  }

  async addConstraint(
    claims: TenantClaims,
    planId: string,
    input: {
      activityId: string;
      kind: string;
      description: string;
      ownerId: string | null;
      dueOn: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.plan(db, claims, planId, true);
    const [a] =
      await db`SELECT 1 FROM sched.activity WHERE plan_id = ${planId} AND id = ${input.activityId}`;
    if (!a)
      throw new BadRequestException({
        code: 'not_an_activity',
        message: 'No such activity on this programme.',
      });
    await db`
      INSERT INTO sched.constraint_item (plan_id, activity_id, kind, description, owner_id, due_on, created_by)
      VALUES (${planId}, ${input.activityId}, ${input.kind}, ${input.description}, ${input.ownerId}, ${input.dueOn},
        ${claims.sub})`;
    return this.list(db, planId);
  }

  async clear(claims: TenantClaims, id: string, on: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [c] = await db<{ plan_id: string; cleared_on: string | null }[]>`
      SELECT plan_id, cleared_on::text FROM sched.constraint_item WHERE id = ${id}`;
    if (!c) throw new NotFoundException({ code: 'not_found' });
    await this.plan(db, claims, c.plan_id, true);
    if (c.cleared_on)
      throw new ConflictException({ code: 'already_cleared', message: 'Already cleared.' });
    await db`UPDATE sched.constraint_item SET cleared_on = ${on} WHERE id = ${id}`;
    return this.list(db, c.plan_id);
  }

  /** The look-ahead's activities with what each still waits for: ready when nothing is open. */
  async readiness(claims: TenantClaims, planId: string, weeks: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const p = await this.plan(db, claims, planId, false);
    const [w] = await db<
      { to: string }[]
    >`SELECT to_char(${p.as_of}::date + ${weeks * 7 - 1}::int, 'YYYY-MM-DD') AS to`;
    const rows = await db<
      {
        id: string;
        code: string;
        name: string;
        start: string;
        finish: string;
        open: number;
        overdue: number;
      }[]
    >`
      SELECT a.id::text, a.code, a.name, to_char(a.early_start, 'YYYY-MM-DD') AS start,
        to_char(a.early_finish, 'YYYY-MM-DD') AS finish,
        (SELECT count(*)::int FROM sched.constraint_item c WHERE c.plan_id = a.plan_id AND c.activity_id = a.id
          AND c.cleared_on IS NULL) AS open,
        (SELECT count(*)::int FROM sched.constraint_item c WHERE c.plan_id = a.plan_id AND c.activity_id = a.id
          AND c.cleared_on IS NULL AND c.due_on < (now() AT TIME ZONE 'Asia/Kolkata')::date) AS overdue
      FROM sched.activity a
      WHERE a.plan_id = ${planId} AND a.kind <> 'summary' AND a.status <> 'finished'
        AND a.early_start <= ${w!.to}::date AND a.early_finish >= ${p.as_of}::date
      ORDER BY a.early_start, a.code LIMIT 2000`;
    return {
      from: p.as_of,
      to: w!.to,
      activities: rows.map((r) => ({ ...r, ready: r.open === 0 })),
      ready: rows.filter((r) => r.open === 0).length,
    };
  }

  // --- the weekly work plan ---

  async week(claims: TenantClaims, planId: string, weekStart: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.plan(db, claims, planId, false);
    return this.weekOf(db, planId, mondayOf(weekStart));
  }

  private async weekOf(db: Db, planId: string, weekStart: string) {
    const [w] = await db<{ id: string; closed: boolean }[]>`
      SELECT id, closed_at IS NOT NULL AS closed FROM sched.weekly_plan
      WHERE plan_id = ${planId} AND week_start = ${weekStart}`;
    const rows = w
      ? await db<
          {
            id: string;
            activityId: string | null;
            activityCode: string | null;
            what: string;
            done: boolean | null;
            missReason: string | null;
            note: string;
          }[]
        >`
          SELECT c.id, c.activity_id::text AS "activityId", a.code AS "activityCode", c.what, c.done,
            c.miss_reason AS "missReason", c.note
          FROM sched.commitment c LEFT JOIN sched.activity a ON a.plan_id = ${planId} AND a.id = c.activity_id
          WHERE c.weekly_plan_id = ${w.id} ORDER BY a.code NULLS LAST, c.what`
      : [];
    return {
      weekStart,
      id: w?.id ?? null,
      closed: w?.closed ?? false,
      commitments: rows,
      ppc: ppc(rows),
    };
  }

  /** What the site commits to for a week: each line an activity (or work outside the schedule) and what of it. */
  async commit(
    claims: TenantClaims,
    planId: string,
    input: { weekStart: string; items: { activityId: string | null; what: string }[] },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.plan(db, claims, planId, true);
    const weekStart = mondayOf(input.weekStart);
    await db.begin(async (tx) => {
      const [w] = await tx<{ id: string; closed: boolean }[]>`
        INSERT INTO sched.weekly_plan (plan_id, week_start, created_by) VALUES (${planId}, ${weekStart}, ${claims.sub})
        ON CONFLICT (plan_id, week_start) DO UPDATE SET week_start = EXCLUDED.week_start
        RETURNING id, closed_at IS NOT NULL AS closed`;
      if (w!.closed)
        throw new ConflictException({ code: 'week_closed', message: 'That week is closed.' });
      for (const i of input.items) {
        if (i.activityId) {
          const [a] =
            await tx`SELECT 1 FROM sched.activity WHERE plan_id = ${planId} AND id = ${i.activityId}`;
          if (!a)
            throw new BadRequestException({
              code: 'not_an_activity',
              message: 'No such activity.',
            });
        }
        await tx`INSERT INTO sched.commitment (weekly_plan_id, activity_id, what)
          VALUES (${w!.id}, ${i.activityId}, ${i.what})`;
      }
    });
    return this.weekOf(db, planId, weekStart);
  }

  /** The week over: each commitment done, or missed with its reason; then it is closed. */
  async close(
    claims: TenantClaims,
    planId: string,
    input: {
      weekStart: string;
      results: { id: string; done: boolean; missReason: string | null; note: string }[];
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.plan(db, claims, planId, true);
    const weekStart = mondayOf(input.weekStart);
    await db.begin(async (tx) => {
      const [w] = await tx<{ id: string; closed: boolean }[]>`
        SELECT id, closed_at IS NOT NULL AS closed FROM sched.weekly_plan
        WHERE plan_id = ${planId} AND week_start = ${weekStart} FOR UPDATE`;
      if (!w)
        throw new NotFoundException({
          code: 'no_week',
          message: 'Nothing was committed for that week.',
        });
      if (w.closed)
        throw new ConflictException({ code: 'week_closed', message: 'That week is closed.' });
      for (const r of input.results) {
        if (!r.done && !r.missReason)
          throw new BadRequestException({
            code: 'reason_needed',
            message: 'Give the reason for each miss.',
          });
        await tx`UPDATE sched.commitment SET done = ${r.done}, miss_reason = ${r.done ? null : r.missReason},
          note = ${r.note} WHERE id = ${r.id} AND weekly_plan_id = ${w.id}`;
      }
      const [open] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM sched.commitment WHERE weekly_plan_id = ${w.id} AND done IS NULL`;
      if (open!.n)
        throw new BadRequestException({
          code: 'undecided',
          message: `${open!.n} commitment${open!.n === 1 ? ' is' : 's are'} not marked done or missed.`,
        });
      await tx`UPDATE sched.weekly_plan SET closed_at = now() WHERE id = ${w.id}`;
    });
    return this.weekOf(db, planId, weekStart);
  }

  /** PPC week by week, and why commitments were missed. */
  async ppcTrend(claims: TenantClaims, planId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.plan(db, claims, planId, false);
    const weeks = await db<{ weekStart: string; committed: number; done: number }[]>`
      SELECT to_char(w.week_start, 'YYYY-MM-DD') AS "weekStart", count(c.*)::int AS committed,
        count(c.*) FILTER (WHERE c.done)::int AS done
      FROM sched.weekly_plan w LEFT JOIN sched.commitment c ON c.weekly_plan_id = w.id
      WHERE w.plan_id = ${planId} AND w.closed_at IS NOT NULL GROUP BY w.week_start ORDER BY w.week_start`;
    const reasons = await db<{ reason: string; n: number }[]>`
      SELECT c.miss_reason AS reason, count(*)::int AS n FROM sched.commitment c
      JOIN sched.weekly_plan w ON w.id = c.weekly_plan_id
      WHERE w.plan_id = ${planId} AND c.done = false GROUP BY c.miss_reason ORDER BY n DESC, reason`;
    return {
      weeks: weeks.map((w) => ({
        ...w,
        ppc: w.committed ? Math.round((w.done / w.committed) * 1000) / 10 : null,
      })),
      reasons,
    };
  }
}
