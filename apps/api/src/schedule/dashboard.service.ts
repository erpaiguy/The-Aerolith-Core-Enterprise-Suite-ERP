// A project's dashboard (docs/wave2a-plan.md step 7): one page of where the project stands, computed when asked for.
// - Money: the contract against the budget (the planned margin), the work done at contract and budget rates, and this
//   month's.
// - Each live schedule: its finish against its baseline, and three progress figures side by side, never blended:
//   **planned** (where the baseline says the work should be by the data date), **scheduled** (what the planners
//   report, by working days) and **measured** (the physical progress of the BOQ items its activities carry out).
// - The S-curve: the value of the linked BOQ items spread over the baseline (planned) and the current schedule
//   (forecast), month by month, against the value measured (earned).
// Planned progress and the curves count working days on each activity's calendar (holidays included), as the
// schedule does.
// - The look-ahead of the next two weeks and the next milestones, across the live schedules.
import { Injectable } from '@nestjs/common';
import { WorkCalendar, dayNumber } from '@aerolith/shared';
import type { TenantClaims } from '../auth/auth.service.js';
import { ProgressService } from '../project/progress.service.js';
import { ProjectBoqService } from '../project/project-boq.service.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { toSpec, type Calendar } from './programme-model.js';

/** Today in India: the dashboard's "now". */
const indiaToday = (now = new Date()) =>
  new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const LOOKAHEAD_DAYS = 14;
const MAX_MONTHS = 120;
/** Where the calendars' day positions start: before any date a plan can hold. */
const CAL_FROM = dayNumber('1990-01-01');

const pct1 = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
const rupees = (n: number) => Math.round(n * 100) / 100;

/** The months ('YYYY-MM') from the one holding `from` to the one holding `to`, at most MAX_MONTHS. */
export function monthsBetween(from: string, to: string) {
  const out: { month: string; first: number; last: number }[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = to.slice(0, 7);
  for (;;) {
    const month = `${y}-${String(m).padStart(2, '0')}`;
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    out.push({
      month,
      first: dayNumber(`${month}-01`),
      last: dayNumber(`${ny}-${String(nm).padStart(2, '0')}-01`) - 1,
    });
    if (month >= end || out.length >= MAX_MONTHS) return out;
    y = ny;
    m = nm;
  }
}

/** Working days of `cal` from day `a` to day `b`, both included. */
const workDays = (cal: WorkCalendar, a: number, b: number) =>
  b < a ? 0 : cal.cum(b + 1) - cal.cum(a);

/**
 * Value spread evenly over the working days of each span (on its calendar), added up month by month, then
 * cumulated. A span with no working day (a milestone on a holiday) puts all of its value on its first day.
 */
export function cumulativeSpread(
  spans: { start: string; finish: string; value: number; cal: WorkCalendar }[],
  months: ReturnType<typeof monthsBetween>,
) {
  const byMonth = new Array<number>(months.length).fill(0);
  for (const s of spans) {
    const a = dayNumber(s.start);
    const b = Math.max(a, dayNumber(s.finish));
    const all = workDays(s.cal, a, b);
    months.forEach((m, i) => {
      if (all === 0) {
        if (a >= m.first && a <= m.last) byMonth[i]! += s.value;
        return;
      }
      const w = workDays(s.cal, Math.max(a, m.first), Math.min(b, m.last));
      if (w > 0) byMonth[i]! += (s.value * w) / all;
    });
  }
  let run = 0;
  return byMonth.map((v) => rupees((run += v)));
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly progress: ProgressService,
    private readonly boqs: ProjectBoqService,
  ) {}

  async dashboard(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const today = indiaToday();
    const monthStart = `${today.slice(0, 8)}01`;
    const [money, progress] = await Promise.all([
      this.boqs.summary(claims, projectId),
      this.progress.report(claims, projectId, monthStart, today),
    ]);

    // The live schedules, each with its three progress figures. Planned: each baselined activity's baseline working
    // days times the share of its baseline span's working days before the data date. Scheduled: working days done,
    // as the macro plan counts them. Measured: the linked items' work within their quantities, by contract value.
    const schedules = await db<
      {
        id: string;
        name: string;
        dataDate: string;
        finish: string | null;
        baselineName: string | null;
        baselineFinish: string | null;
        activities: number;
        finished: number;
        inProgress: number;
        critical: number;
        lateToBaseline: number;
        days: number;
        doneDays: number;
        linkedValue: string;
        linkedPhysical: string;
      }[]
    >`
      WITH p AS (
        SELECT p.id, p.name, coalesce(p.data_date, p.start_on) AS dd, p.finish_on, p.baseline_id, p.created_at
        FROM sched.plan p
        WHERE p.project_id = ${projectId} AND p.kind = 'project_schedule' AND p.archived_at IS NULL
      ),
      a AS (
        SELECT a.plan_id, a.duration, a.status, a.critical, a.remaining_left, b.start_on AS bl_start,
          b.finish_on AS bl_finish
        FROM p JOIN sched.activity a ON a.plan_id = p.id AND a.kind <> 'summary'
        LEFT JOIN sched.baseline_activity b ON b.plan_id = a.plan_id AND b.baseline_id = p.baseline_id
          AND b.activity_id = a.id
      ),
      t AS (
        SELECT a.plan_id, count(*)::int AS activities,
          count(*) FILTER (WHERE status = 'finished')::int AS finished,
          count(*) FILTER (WHERE status = 'in_progress')::int AS "inProgress",
          count(*) FILTER (WHERE critical AND status <> 'finished')::int AS critical,
          count(*) FILTER (WHERE status <> 'finished' AND bl_finish < p.dd)::int AS "lateToBaseline",
          coalesce(sum(duration), 0)::int AS days,
          coalesce(sum(CASE status WHEN 'finished' THEN duration
            WHEN 'in_progress' THEN greatest(duration - coalesce(remaining_left, 0), 0) ELSE 0 END), 0)::int
            AS "doneDays"
        FROM a JOIN p ON p.id = a.plan_id GROUP BY a.plan_id
      ),
      done AS (
        SELECT line_key, sum(qty) AS qty FROM proj.measurement WHERE project_id = ${projectId} GROUP BY line_key
      ),
      items AS (
        SELECT n.line_key, n.qty, n.rate, n.amount
        FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item' AND n.amount IS NOT NULL
        WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
      ),
      linked AS (
        SELECT l.plan_id, sum(i.amount) AS value,
          sum(round(least(coalesce(d.qty, 0), greatest(i.qty, 0)) * i.rate, 2)) AS physical
        FROM (SELECT DISTINCT al.plan_id, al.line_key FROM sched.activity_line al JOIN p ON p.id = al.plan_id) l
        JOIN items i ON i.line_key = l.line_key
        LEFT JOIN done d ON d.line_key = l.line_key
        GROUP BY l.plan_id
      )
      SELECT p.id, p.name, to_char(p.dd, 'YYYY-MM-DD') AS "dataDate", to_char(p.finish_on, 'YYYY-MM-DD') AS finish,
        bl.name AS "baselineName", to_char(bl.finish_on, 'YYYY-MM-DD') AS "baselineFinish",
        coalesce(t.activities, 0) AS activities, coalesce(t.finished, 0) AS finished,
        coalesce(t."inProgress", 0) AS "inProgress", coalesce(t.critical, 0) AS critical,
        coalesce(t."lateToBaseline", 0) AS "lateToBaseline", coalesce(t.days, 0) AS days,
        coalesce(t."doneDays", 0) AS "doneDays", coalesce(lk.value, 0)::text AS "linkedValue",
        coalesce(lk.physical, 0)::text AS "linkedPhysical"
      FROM p
      LEFT JOIN sched.baseline bl ON bl.id = p.baseline_id
      LEFT JOIN t ON t.plan_id = p.id
      LEFT JOIN linked lk ON lk.plan_id = p.id
      ORDER BY p.created_at`;

    // The calendars of the live schedules, and each baselined activity's span on its calendar.
    const plans = schedules.map((s) => s.id);
    const calendarRows = await db<(Calendar & { planId: string })[]>`
      SELECT id, plan_id AS "planId", name, work_week AS "workWeek",
        coalesce((SELECT array_agg(to_char(d, 'YYYY-MM-DD') ORDER BY d) FROM unnest(holidays) d), '{}') AS holidays,
        coalesce((SELECT array_agg(to_char(d, 'YYYY-MM-DD') ORDER BY d) FROM unnest(working_days) d), '{}')
          AS "workingDays"
      FROM sched.calendar WHERE plan_id = ANY(${plans}::uuid[])`;
    const calendars = new Map<string, WorkCalendar>();
    const calendar = (id: string) => {
      let c = calendars.get(id);
      if (!c) {
        c = new WorkCalendar(toSpec(calendarRows.find((r) => r.id === id)!), CAL_FROM);
        calendars.set(id, c);
      }
      return c;
    };
    const baselined = await db<
      { planId: string; calendarId: string; duration: number; start: string; finish: string }[]
    >`
      SELECT a.plan_id AS "planId", coalesce(a.calendar_id, p.calendar_id)::text AS "calendarId",
        b.duration, to_char(b.start_on, 'YYYY-MM-DD') AS start, to_char(b.finish_on, 'YYYY-MM-DD') AS finish
      FROM sched.plan p
      JOIN sched.activity a ON a.plan_id = p.id AND a.kind <> 'summary'
      JOIN sched.baseline_activity b ON b.plan_id = a.plan_id AND b.baseline_id = p.baseline_id
        AND b.activity_id = a.id
      WHERE p.id = ANY(${plans}::uuid[]) AND b.start_on IS NOT NULL AND b.finish_on IS NOT NULL`;
    const planned = new Map<string, { days: number; due: number }>();
    for (const b of baselined) {
      const dd = dayNumber(schedules.find((s) => s.id === b.planId)!.dataDate);
      const cal = calendar(b.calendarId);
      const a = dayNumber(b.start);
      const span = workDays(cal, a, dayNumber(b.finish));
      const before = Math.min(span, workDays(cal, a, dd - 1));
      const t = planned.get(b.planId) ?? { days: 0, due: 0 };
      t.days += b.duration;
      t.due += span > 0 ? (b.duration * before) / span : 0;
      planned.set(b.planId, t);
    }

    // The S-curve. Each linked item's contract value is shared equally among the activities that carry it out (in
    // all live schedules), then spread over each activity's baseline span and its current span.
    const spans = await db<
      {
        start: string | null;
        finish: string | null;
        blStart: string | null;
        blFinish: string | null;
        calendarId: string;
        value: string;
      }[]
    >`
      WITH p AS (
        SELECT id, baseline_id, calendar_id FROM sched.plan
        WHERE project_id = ${projectId} AND kind = 'project_schedule' AND archived_at IS NULL
      ),
      items AS (
        SELECT n.line_key, n.amount
        FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item' AND n.amount IS NOT NULL
        WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
      ),
      links AS (
        SELECT al.plan_id, al.activity_id, al.line_key, count(*) OVER (PARTITION BY al.line_key) AS shared
        FROM sched.activity_line al JOIN p ON p.id = al.plan_id
      )
      SELECT to_char(a.early_start, 'YYYY-MM-DD') AS start, to_char(a.early_finish, 'YYYY-MM-DD') AS finish,
        to_char(b.start_on, 'YYYY-MM-DD') AS "blStart", to_char(b.finish_on, 'YYYY-MM-DD') AS "blFinish",
        coalesce(a.calendar_id, p.calendar_id)::text AS "calendarId", sum(i.amount / l.shared)::text AS value
      FROM links l
      JOIN items i ON i.line_key = l.line_key
      JOIN p ON p.id = l.plan_id
      JOIN sched.activity a ON a.plan_id = l.plan_id AND a.id = l.activity_id
      LEFT JOIN sched.baseline_activity b ON b.plan_id = a.plan_id AND b.baseline_id = p.baseline_id
        AND b.activity_id = a.id
      GROUP BY 1, 2, 3, 4, 5`;
    const [measured] = await db<{ first: string | null; linked: string }[]>`
      SELECT to_char(min(m.measured_on), 'YYYY-MM-DD') AS first,
        (SELECT coalesce(sum(n.amount), 0)::text FROM est.boq b
          JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item' AND n.amount IS NOT NULL
          WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
            AND n.line_key IN (SELECT al.line_key FROM sched.activity_line al JOIN sched.plan p ON p.id = al.plan_id
              WHERE p.project_id = ${projectId} AND p.kind = 'project_schedule' AND p.archived_at IS NULL)) AS linked
      FROM proj.measurement m WHERE m.project_id = ${projectId}`;
    const dates = [
      ...spans.flatMap((s) => [s.start, s.finish, s.blStart, s.blFinish]),
      measured!.first,
    ].filter((d): d is string => d !== null);
    let curve = null;
    if (dates.length) {
      const first = dates.reduce((a, b) => (a < b ? a : b));
      const last = [...dates, today].reduce((a, b) => (a > b ? a : b));
      const months = monthsBetween(first, last);
      const planned = cumulativeSpread(
        spans
          .filter((s) => s.blStart && s.blFinish)
          .map((s) => ({
            start: s.blStart!,
            finish: s.blFinish!,
            value: Number(s.value),
            cal: calendar(s.calendarId),
          })),
        months,
      );
      const forecast = cumulativeSpread(
        spans
          .filter((s) => s.start && s.finish)
          .map((s) => ({
            start: s.start!,
            finish: s.finish!,
            value: Number(s.value),
            cal: calendar(s.calendarId),
          })),
        months,
      );
      // Earned: at the end of each month to this one, every item's quantity measured by then at its contract rate
      // (as the progress report values it, so the last point is its "value done").
      const earnedRows = await db<{ month: string; earned: string }[]>`
        WITH m AS (
          SELECT generate_series(${months[0]!.month + '-01'}::date, date_trunc('month', ${today}::date)::date,
            interval '1 month')::date AS month
        ),
        d AS (
          SELECT line_key, date_trunc('month', measured_on)::date AS month, sum(qty) AS qty
          FROM proj.measurement WHERE project_id = ${projectId} AND measured_on <= ${today} GROUP BY 1, 2
        ),
        items AS (
          SELECT n.line_key, n.rate
          FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item' AND n.amount IS NOT NULL
          WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL
        )
        SELECT to_char(m.month, 'YYYY-MM') AS month,
          coalesce((SELECT sum(round(x.qty * i.rate, 2)) FROM
            (SELECT d.line_key, sum(d.qty) AS qty FROM d WHERE d.month <= m.month GROUP BY d.line_key) x
            JOIN items i ON i.line_key = x.line_key), 0)::text AS earned
        FROM m ORDER BY m.month`;
      const earned = new Map(earnedRows.map((r) => [r.month, Number(r.earned)]));
      curve = {
        months: months.map((m) => m.month),
        planned: spans.some((s) => s.blStart) ? planned : null,
        forecast,
        earned: months.map((m) => earned.get(m.month) ?? null),
        /** The contract value the planned and forecast curves spread: the items linked to activities. */
        linkedValue: measured!.linked,
      };
    }

    // What is on or coming in the next two weeks from each schedule's data date, and the next milestones.
    const lookahead = await db<
      {
        planId: string;
        schedule: string;
        id: string;
        code: string;
        name: string;
        status: string;
        start: string;
        finish: string;
        critical: boolean;
        totalFloat: number | null;
        wbsCode: string | null;
      }[]
    >`
      SELECT a.plan_id AS "planId", p.name AS schedule, a.id::text AS id, a.code, a.name, a.status,
        to_char(a.early_start, 'YYYY-MM-DD') AS start, to_char(a.early_finish, 'YYYY-MM-DD') AS finish,
        a.critical, a.total_float AS "totalFloat", w.code AS "wbsCode"
      FROM sched.plan p
      JOIN sched.activity a ON a.plan_id = p.id AND a.kind <> 'summary' AND a.status <> 'finished'
      LEFT JOIN proj.wbs w ON w.id = a.wbs_id
      WHERE p.project_id = ${projectId} AND p.kind = 'project_schedule' AND p.archived_at IS NULL
        AND a.early_start <= coalesce(p.data_date, p.start_on) + ${LOOKAHEAD_DAYS - 1}::int
        AND a.early_finish >= coalesce(p.data_date, p.start_on)
      ORDER BY a.early_start, a.critical DESC, a.code LIMIT 201`;
    const milestones = await db<
      {
        planId: string;
        schedule: string;
        id: string;
        code: string;
        name: string;
        date: string | null;
        baselineDate: string | null;
        slipDays: number | null;
        critical: boolean;
      }[]
    >`
      SELECT a.plan_id AS "planId", p.name AS schedule, a.id::text AS id, a.code, a.name,
        to_char(a.early_start, 'YYYY-MM-DD') AS date, to_char(b.start_on, 'YYYY-MM-DD') AS "baselineDate",
        CASE WHEN b.start_on IS NULL THEN NULL ELSE a.early_start - b.start_on END AS "slipDays", a.critical
      FROM sched.plan p
      JOIN sched.activity a ON a.plan_id = p.id AND a.kind = 'milestone' AND a.status <> 'finished'
      LEFT JOIN sched.baseline_activity b ON b.plan_id = a.plan_id AND b.baseline_id = p.baseline_id
        AND b.activity_id = a.id
      WHERE p.project_id = ${projectId} AND p.kind = 'project_schedule' AND p.archived_at IS NULL
      ORDER BY a.early_start NULLS LAST, a.code LIMIT 8`;

    return {
      asOf: today,
      money: {
        contractValue: money.contractValue,
        contract: money.contract,
        budget: money.budget,
        margin: money.margin,
        marginPct: money.marginPct,
        boqs: money.boqs.map((b) => ({
          contractId: b.contractId,
          name: b.name,
          contract: b.contract,
          budget: b.budget,
          margin: b.margin,
        })),
      },
      progress: {
        from: progress.from,
        to: progress.to,
        total: progress.total,
        sections: progress.boqs.flatMap((b) => b.sections.map((s) => ({ boq: b.name, ...s }))),
      },
      schedules: schedules.map((s) => ({
        id: s.id,
        name: s.name,
        dataDate: s.dataDate,
        finish: s.finish,
        baselineName: s.baselineName,
        baselineFinish: s.baselineFinish,
        slipDays:
          s.finish && s.baselineFinish ? dayNumber(s.finish) - dayNumber(s.baselineFinish) : null,
        activities: s.activities,
        finished: s.finished,
        inProgress: s.inProgress,
        critical: s.critical,
        lateToBaseline: s.lateToBaseline,
        /** Where the baseline says the work should be by the data date (by working days). */
        plannedPct: s.baselineName
          ? pct1(planned.get(s.id)?.due ?? 0, planned.get(s.id)?.days ?? 0)
          : null,
        /** What the planners report done (by working days). */
        scheduledPct: pct1(s.doneDays, s.days),
        /** What is measured on the BOQ items its activities carry out (by contract value). */
        measuredPct: pct1(Number(s.linkedPhysical), Number(s.linkedValue)),
        linkedValue: s.linkedValue,
      })),
      curve,
      lookahead: {
        days: LOOKAHEAD_DAYS,
        activities: lookahead.slice(0, 200),
        more: lookahead.length > 200,
      },
      milestones,
    };
  }
}
