// Plans (docs/04-features.md E9 and J4): a tender's submission programme (docs/wave1-plan.md step 11) and a project's
// schedules (docs/wave2a-plan.md step 4), edited as a whole and recalculated on every change. The plan is read into
// memory (programme-model.ts), the edits are applied and the plan scheduled there, and only what changed is written
// back, in one transaction under the plan's row version. Changes need `programme.edit`; a project's schedules are
// also kept to its team (ProjectAccess). A project schedule adds activities on the WBS, progress as of a data date,
// baselines, resources per activity, the resources needed week by week, and the look-ahead.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { writeProgrammeXlsx } from './interchange/excel.js';
import { toOps, type ImportedPlan } from './interchange/imported.js';
import { readMspdi, writeMspdi } from './interchange/mspdi.js';
import { readXer, writeXer } from './interchange/xer.js';
import { WorkCalendar, dayNumber, isoDay, weekday } from '@aerolith/shared';
import { ProjectService } from '../project/project.service.js';
import {
  MAX_ACTIVITIES,
  MAX_SCHEDULE_ACTIVITIES,
  Programme,
  ProgrammeError,
  nationalHolidays,
  type Activity,
  type Calendar,
  type Link,
  type Op,
  toSpec,
} from './programme-model.js';

const SITE_WEEK = 0b0111111; // Mon–Sat
const OFFICE_WEEK = 0b0011111; // Mon–Fri

export type PlanKind = 'tender_programme' | 'project_schedule';
/** Whose plan it is: a tender's programme or a project's schedule. */
export type PlanOwner = { tenderId: string } | { projectId: string };

interface PlanRow {
  id: string;
  kind: PlanKind;
  tenderId: string | null;
  projectId: string | null;
  name: string;
  startOn: string;
  dataDate: string | null;
  baselineId: string | null;
  calendarId: string;
  notes: string;
  finishOn: string | null;
  duration: number | null;
  activityCount: number;
  computedAt: string | null;
  archivedAt: string | null;
  rowVersion: number;
}

export interface ActivityView extends Activity {
  depth: number;
  earlyStart: string | null;
  earlyFinish: string | null;
  lateStart: string | null;
  lateFinish: string | null;
  totalFloat: number | null;
  freeFloat: number | null;
  critical: boolean;
  remainingLeft: number | null;
  status: 'not_started' | 'in_progress' | 'finished';
  wbsCode: string | null;
  /** In the baseline shown, if it was there. */
  baselineStart: string | null;
  baselineFinish: string | null;
}

const limitOf = (kind: PlanKind) =>
  kind === 'project_schedule' ? MAX_SCHEDULE_ACTIVITIES : MAX_ACTIVITIES;

/** A plan's activity goes to its owner's log: the tender's or the project's. */
async function planEvent(
  tx: TransactionSql,
  planId: string,
  kind: string,
  data: Record<string, unknown>,
  actorId: string,
) {
  const json = tx.json(JSON.parse(JSON.stringify(data)));
  await tx`INSERT INTO tender.tender_event (tender_id, kind, data, actor_id)
    SELECT tender_id, ${kind}, ${json}, ${actorId} FROM sched.plan WHERE id = ${planId} AND tender_id IS NOT NULL`;
  await tx`INSERT INTO proj.project_event (project_id, kind, data, actor_id)
    SELECT project_id, ${kind}, ${json}, ${actorId} FROM sched.plan WHERE id = ${planId} AND project_id IS NOT NULL`;
}

const toHttp = (err: unknown): never => {
  if (err instanceof ProgrammeError) {
    const body = { code: err.code, message: err.message, activities: err.codes };
    if (err.code === 'activity_not_found') throw new NotFoundException(body);
    if (err.code === 'code_taken') throw new ConflictException(body);
    throw new UnprocessableEntityException(body);
  }
  throw err;
};

@Injectable()
export class ProgrammeService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
  ) {}

  async list(claims: TenantClaims, tenderId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT id, name, to_char(start_on, 'YYYY-MM-DD') AS "startOn", to_char(finish_on, 'YYYY-MM-DD') AS "finishOn",
        duration, activity_count AS "activityCount", archived_at AS "archivedAt"
      FROM sched.plan WHERE tender_id = ${tenderId} ORDER BY archived_at IS NOT NULL, created_at`;
  }

  /** A new programme with two calendars to start from: the site (Mon–Sat) and the office (Mon–Fri). */
  async create(claims: TenantClaims, tenderId: string, input: { name: string; startOn: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db.begin(async (tx) => {
      const [t] = await tx`SELECT 1 FROM tender.tender WHERE id = ${tenderId}`;
      if (!t) throw new NotFoundException({ code: 'tender_not_found' });
      const planId = await insertPlan(tx, { tenderId }, input, claims.sub);
      await planEvent(tx, planId, 'programme_created', { name: input.name }, claims.sub);
      return planId;
    });
    return this.get(claims, id);
  }

  // --- a project's schedules ---

  async listForProject(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    return db`
      SELECT id, name, to_char(start_on, 'YYYY-MM-DD') AS "startOn", to_char(finish_on, 'YYYY-MM-DD') AS "finishOn",
        to_char(data_date, 'YYYY-MM-DD') AS "dataDate", duration, activity_count AS "activityCount",
        archived_at AS "archivedAt",
        (SELECT json_build_object('name', b.name, 'finishOn', to_char(b.finish_on, 'YYYY-MM-DD'))
          FROM sched.baseline b WHERE b.id = p.baseline_id) AS baseline
      FROM sched.plan p WHERE project_id = ${projectId} ORDER BY archived_at IS NOT NULL, created_at`;
  }

  /**
   * A new schedule of the project, empty or laid out on its WBS: each element becomes a summary (with elements under
   * it) or an activity of five days, carrying the element's code, name and link to the WBS.
   */
  async createForProject(
    claims: TenantClaims,
    projectId: string,
    input: { name: string; startOn: string; fromWbs: boolean },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustWork(db, claims, projectId);
    const id = await db.begin(async (tx) => {
      const planId = await insertPlan(tx, { projectId }, input, claims.sub);
      if (input.fromWbs) {
        const nodes = await tx<
          { id: string; parent_id: string | null; code: string; name: string }[]
        >`
          SELECT id, parent_id, code, name FROM proj.wbs WHERE project_id = ${projectId}
          ORDER BY parent_id NULLS FIRST, position, code`;
        if (!nodes.length)
          throw new BadRequestException({
            code: 'no_wbs',
            message: 'The project has no WBS yet. Start an empty schedule, or make the WBS first.',
          });
        const temp = new Map(nodes.map((n, i) => [n.id, `tw${i}`]));
        const last = new Map<string | null, string>();
        const ops: Op[] = [];
        // Parents before children: walk the tree.
        const kids = new Map<string | null, (typeof nodes)[number][]>();
        for (const n of nodes) kids.set(n.parent_id, [...(kids.get(n.parent_id) ?? []), n]);
        const walk = (parent: string | null) => {
          for (const n of kids.get(parent) ?? []) {
            ops.push({
              op: 'insert',
              tempId: temp.get(n.id)!,
              parentId: parent ? temp.get(parent)! : null,
              afterId: last.get(parent) ?? null,
              code: n.code,
              name: n.name,
              duration: 5,
              wbsId: n.id,
            });
            last.set(parent, temp.get(n.id)!);
            walk(n.id);
          }
        };
        walk(null);
        const plan = await this.lock(tx, planId, 1);
        const before = await this.read(tx, planId);
        const model = new Programme([], [], MAX_SCHEDULE_ACTIVITIES);
        try {
          model.apply(ops);
        } catch (err) {
          toHttp(err);
        }
        await this.save(tx, plan, before, model, before.calendars);
      }
      await planEvent(
        tx,
        planId,
        'schedule_created',
        { name: input.name, fromWbs: input.fromWbs },
        claims.sub,
      );
      return planId;
    });
    return this.get(claims, id);
  }

  /** The project's team works on its schedules: its lead, members, and those who edit projects. */
  private async mustWork(db: Sql | TransactionSql, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    if (!a.canEdit && a.role !== 'member')
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) plans its work.",
      });
  }

  async get(claims: TenantClaims, planId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return this.read(db, planId);
  }

  private async read(db: Sql | TransactionSql, planId: string) {
    const [plan] = await db<
      (PlanRow & {
        /** The tender or project it belongs to, as people name it. */
        owner: { kind: 'tender' | 'project'; id: string; number: string; title: string };
        tender: { id: string; number: string; title: string } | null;
      })[]
    >`
      SELECT p.id, p.kind, p.tender_id AS "tenderId", p.project_id AS "projectId", p.name,
        to_char(p.start_on, 'YYYY-MM-DD') AS "startOn", to_char(p.data_date, 'YYYY-MM-DD') AS "dataDate",
        p.baseline_id AS "baselineId", p.calendar_id AS "calendarId", p.notes,
        to_char(p.finish_on, 'YYYY-MM-DD') AS "finishOn", p.duration,
        p.activity_count AS "activityCount", p.computed_at AS "computedAt", p.archived_at AS "archivedAt",
        p.row_version AS "rowVersion",
        CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id', t.id, 'number', t.number, 'title', t.title)
          END AS tender,
        CASE WHEN t.id IS NOT NULL
          THEN json_build_object('kind', 'tender', 'id', t.id, 'number', t.number, 'title', t.title)
          ELSE json_build_object('kind', 'project', 'id', pr.id, 'number', pr.number, 'title', pr.name) END AS owner
      FROM sched.plan p LEFT JOIN tender.tender t ON t.id = p.tender_id
      LEFT JOIN proj.project pr ON pr.id = p.project_id
      WHERE p.id = ${planId}`;
    if (!plan) throw new NotFoundException({ code: 'programme_not_found' });
    const [calendars, rows, links, baselines] = await Promise.all([
      this.calendars(db, planId),
      db<Omit<ActivityView, 'depth'>[]>`
        SELECT a.id::text, a.parent_id::text AS "parentId", a.pos, a.kind, a.code, a.name, a.duration,
          a.calendar_id AS "calendarId", a.constraint_type AS "constraintType",
          to_char(a.constraint_date, 'YYYY-MM-DD') AS "constraintDate", a.notes,
          to_char(a.early_start, 'YYYY-MM-DD') AS "earlyStart", to_char(a.early_finish, 'YYYY-MM-DD') AS "earlyFinish",
          to_char(a.late_start, 'YYYY-MM-DD') AS "lateStart", to_char(a.late_finish, 'YYYY-MM-DD') AS "lateFinish",
          a.total_float AS "totalFloat", a.free_float AS "freeFloat", a.critical,
          a.wbs_id AS "wbsId", w.code AS "wbsCode", a.package, a.trade, a.zone,
          to_char(a.actual_start, 'YYYY-MM-DD') AS "actualStart",
          to_char(a.actual_finish, 'YYYY-MM-DD') AS "actualFinish", a.remaining, a.remaining_left AS "remainingLeft",
          a.status, to_char(b.start_on, 'YYYY-MM-DD') AS "baselineStart",
          to_char(b.finish_on, 'YYYY-MM-DD') AS "baselineFinish"
        FROM sched.activity a
        LEFT JOIN proj.wbs w ON w.id = a.wbs_id
        LEFT JOIN sched.baseline_activity b ON b.plan_id = a.plan_id AND b.baseline_id = ${plan.baselineId}::uuid
          AND b.activity_id = a.id
        WHERE a.plan_id = ${planId}`,
      this.links(db, planId),
      db<
        {
          id: string;
          name: string;
          dataDate: string;
          finishOn: string | null;
          activityCount: number;
          takenAt: string;
          takenBy: string | null;
        }[]
      >`
        SELECT b.id, b.name, to_char(b.data_date, 'YYYY-MM-DD') AS "dataDate",
          to_char(b.finish_on, 'YYYY-MM-DD') AS "finishOn", b.activity_count AS "activityCount",
          b.taken_at AS "takenAt", u.display_name AS "takenBy"
        FROM sched.baseline b LEFT JOIN platform."user" u ON u.id = b.taken_by
        WHERE b.plan_id = ${planId} ORDER BY b.taken_at`,
    ]);
    const model = new Programme(rows, links, limitOf(plan.kind));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const activities: ActivityView[] = model.ordered().map((a) => {
      const r = byId.get(a.id)!;
      return { ...r, depth: model.depth(a.id) };
    });
    return { ...plan, calendars, activities, links, baselines };
  }

  private calendars(db: Sql | TransactionSql, planId: string) {
    return db<Calendar[]>`
      SELECT id, name, work_week AS "workWeek",
        coalesce((SELECT array_agg(to_char(d, 'YYYY-MM-DD') ORDER BY d) FROM unnest(holidays) d), '{}') AS holidays,
        coalesce((SELECT array_agg(to_char(d, 'YYYY-MM-DD') ORDER BY d) FROM unnest(working_days) d), '{}')
          AS "workingDays"
      FROM sched.calendar WHERE plan_id = ${planId} ORDER BY name`;
  }

  private links(db: Sql | TransactionSql, planId: string) {
    return db<Link[]>`
      SELECT pred_id::text AS pred, succ_id::text AS succ, type, lag FROM sched.relation WHERE plan_id = ${planId}`;
  }

  /**
   * Applies edits to the whole plan and recalculates it. A loop of links, a code used twice or a link on a summary
   * refuses the whole edit; nothing is saved.
   */
  async change(claims: TenantClaims, planId: string, rowVersion: number, ops: Op[]) {
    const db = await this.tenants.forTenant(claims.ten);
    const idMap = await db.begin(async (tx) => {
      const plan = await this.lock(tx, planId, rowVersion);
      const before = await this.read(tx, planId);
      const model = new Programme(before.activities, before.links, limitOf(plan.kind));
      const wbsIds = new Set<string>();
      for (const o of ops)
        if (o.op === 'insert' || o.op === 'update') {
          if (o.calendarId && !before.calendars.some((c) => c.id === o.calendarId))
            throw new BadRequestException({ code: 'calendar_not_found' });
          const progress = o.op === 'update' && o.progress !== undefined;
          const grouped = o.package !== undefined || o.trade !== undefined || o.zone !== undefined;
          if ((o.wbsId !== undefined || progress || grouped) && plan.kind !== 'project_schedule')
            throw new BadRequestException({
              code: 'not_for_tender_programme',
              message: "A tender's programme has no WBS or progress.",
            });
          if (o.wbsId) wbsIds.add(o.wbsId);
        }
      if (wbsIds.size) {
        const found = await tx<{ id: string }[]>`
          SELECT id FROM proj.wbs WHERE project_id = ${plan.project_id} AND id = ANY(${[...wbsIds]}::uuid[])`;
        if (found.length !== wbsIds.size)
          throw new BadRequestException({
            code: 'wbs_not_found',
            message: 'Not a WBS element of this project.',
          });
      }
      try {
        model.apply(ops);
      } catch (err) {
        toHttp(err);
      }
      const map = await this.save(tx, plan, before, model, before.calendars);
      await audit(tx, claims.sub, 'programme.change', 'plan', planId, { ops: ops.length });
      await this.touch(tx, planId, claims);
      return map;
    });
    return { idMap: Object.fromEntries(idMap), plan: await this.get(claims, planId) };
  }

  /** Renames, moves the data date, changes the default calendar or notes, and recalculates. */
  async update(
    claims: TenantClaims,
    planId: string,
    input: {
      rowVersion: number;
      name?: string | undefined;
      startOn?: string | undefined;
      calendarId?: string | undefined;
      notes?: string | undefined;
      /** Project schedules: the day progress is reported as of; null goes back to the start. */
      dataDate?: string | null | undefined;
      /** Project schedules: the baseline to show, or null for none. */
      baselineId?: string | null | undefined;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const plan = await this.lock(tx, planId, input.rowVersion);
      if (
        (input.dataDate !== undefined || input.baselineId !== undefined) &&
        plan.kind !== 'project_schedule'
      )
        throw new BadRequestException({
          code: 'not_for_tender_programme',
          message: "A tender's programme has no progress or baselines.",
        });
      if (input.baselineId) {
        const [b] =
          await tx`SELECT 1 FROM sched.baseline WHERE id = ${input.baselineId} AND plan_id = ${planId}`;
        if (!b) throw new BadRequestException({ code: 'baseline_not_found' });
      }
      const cols = Object.fromEntries(
        Object.entries({
          name: input.name,
          start_on: input.startOn,
          calendar_id: input.calendarId,
          notes: input.notes,
          data_date: input.dataDate,
          baseline_id: input.baselineId,
        }).filter(([, v]) => v !== undefined),
      );
      if (Object.keys(cols).length === 0)
        throw new BadRequestException({ code: 'nothing_to_update' });
      if (input.calendarId) {
        const [c] =
          await tx`SELECT 1 FROM sched.calendar WHERE id = ${input.calendarId} AND plan_id = ${planId}`;
        if (!c) throw new BadRequestException({ code: 'calendar_not_found' });
      }
      await tx`UPDATE sched.plan SET ${tx(cols)} WHERE id = ${planId}`;
      await this.recalc(tx, planId);
      await this.touch(tx, planId, claims);
    });
    return this.get(claims, planId);
  }

  async archive(claims: TenantClaims, planId: string, archived: boolean) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [p] = await tx<{ name: string }[]>`
        UPDATE sched.plan SET archived_at = ${archived ? tx`now()` : null}, updated_by = ${claims.sub},
          updated_at = now(), row_version = row_version + 1
        WHERE id = ${planId} RETURNING name`;
      if (!p) throw new NotFoundException({ code: 'programme_not_found' });
      await planEvent(
        tx,
        planId,
        archived ? 'programme_archived' : 'programme_restored',
        { name: p.name },
        claims.sub,
      );
    });
    return this.get(claims, planId);
  }

  // --- other tools' files ---

  /**
   * Reads an MS Project XML or Primavera XER file into a new programme of the tender (an import never changes an
   * existing one), recalculates it here, and reports what could not be carried over and how the finish compares
   * with the file's own.
   */
  async importFile(claims: TenantClaims, owner: PlanOwner, file: { name: string; buffer: Buffer }) {
    const kind: PlanKind = 'projectId' in owner ? 'project_schedule' : 'tender_programme';
    const limit = limitOf(kind);
    const content = file.buffer.toString('utf8').replace(/^\uFEFF/, '');
    let parsed: ImportedPlan;
    try {
      if (content.startsWith('ERMHDR')) parsed = readXer(content);
      else if (content.trimStart().startsWith('<')) parsed = readMspdi(content);
      else
        throw new Error(
          'Choose an MS Project XML file (.xml) or a Primavera XER file (.xer). An .mpp file must first be saved as XML in MS Project.',
        );
    } catch (err) {
      throw new BadRequestException({
        code: 'unreadable_programme',
        message: (err as Error).message,
      });
    }
    if (parsed.activities.length === 0)
      throw new BadRequestException({
        code: 'empty_programme',
        message: 'The file holds no activities.',
      });
    if (parsed.activities.length > limit)
      throw new BadRequestException({
        code: 'too_many',
        message: `A plan holds up to ${limit} activities; this file has ${parsed.activities.length}.`,
      });
    const db = await this.tenants.forTenant(claims.ten);
    if ('projectId' in owner) await this.mustWork(db, claims, owner.projectId);
    const warnings = [...parsed.warnings];
    const planId = await db.begin(async (tx) => {
      if ('tenderId' in owner) {
        const [t] = await tx`SELECT 1 FROM tender.tender WHERE id = ${owner.tenderId}`;
        if (!t) throw new NotFoundException({ code: 'tender_not_found' });
      }
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO sched.plan (kind, tender_id, project_id, name, start_on, notes, created_by, updated_by)
        VALUES (${kind}, ${'tenderId' in owner ? owner.tenderId : null},
          ${'projectId' in owner ? owner.projectId : null}, ${parsed.name}, ${parsed.startOn},
          ${`Imported from ${file.name.slice(-200)}`}, ${claims.sub}, ${claims.sub}) RETURNING id`;
      const calendars =
        parsed.calendars.length > 0
          ? parsed.calendars
          : [
              {
                key: '',
                name: 'Standard (Mon–Fri)',
                workWeek: OFFICE_WEEK,
                holidays: [],
                workingDays: [],
              },
            ];
      const ids = new Map<string, string>();
      const names = new Set<string>();
      for (const c of calendars) {
        let name = c.name.trim() || 'Calendar';
        for (let n = 2; names.has(name.toLowerCase()); n++) name = `${c.name} (${n})`;
        names.add(name.toLowerCase());
        let week = c.workWeek;
        if (week === 0 && c.workingDays.length === 0) {
          warnings.push(`Calendar "${name}" has no working days; Mon–Fri is used.`);
          week = OFFICE_WEEK;
        }
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO sched.calendar (plan_id, name, work_week, holidays, working_days)
          VALUES (${p!.id}, ${name}, ${week}, ${c.holidays.slice(0, 2000)}::date[],
            ${c.workingDays.slice(0, 2000)}::date[]) RETURNING id`;
        ids.set(c.key, row!.id);
      }
      const defaultId = ids.get(parsed.defaultCalendarKey ?? '') ?? [...ids.values()][0]!;
      await tx`UPDATE sched.plan SET calendar_id = ${defaultId} WHERE id = ${p!.id}`;
      const built = toOps(parsed, ids);
      warnings.push(...built.warnings);
      const before = await this.read(tx, p!.id);
      const model = new Programme([], [], limit);
      try {
        model.apply(built.ops);
      } catch (err) {
        toHttp(err);
      }
      await this.save(
        tx,
        {
          id: p!.id,
          start_on: parsed.startOn,
          calendar_id: defaultId,
          data_date: null,
          kind,
          project_id: null,
        },
        before,
        model,
        before.calendars,
      );
      await planEvent(
        tx,
        p!.id,
        'programme_imported',
        { name: parsed.name, format: parsed.format, activities: parsed.activities.length },
        claims.sub,
      );
      await audit(tx, claims.sub, 'programme.import', 'plan', p!.id, {
        file: file.name,
        warnings: warnings.length,
      });
      return p!.id;
    });
    const plan = await this.get(claims, planId);
    return {
      plan,
      report: {
        format: parsed.format,
        activities: plan.activities.length,
        links: plan.links.length,
        calendars: plan.calendars.length,
        fileFinish: parsed.fileFinish,
        finish: plan.finishOn,
        warnings,
      },
    };
  }

  /** The programme as MS Project XML, Primavera XER or Excel. */
  async exportFile(claims: TenantClaims, planId: string, format: 'mspdi' | 'xer' | 'xlsx') {
    const plan = await this.get(claims, planId);
    const base = fileSafe(`${plan.owner.number} ${plan.name}`);
    if (format === 'mspdi')
      return {
        body: Buffer.from(writeMspdi(plan), 'utf8'),
        type: 'application/xml',
        fileName: `${base}.xml`,
      };
    if (format === 'xer')
      return {
        body: Buffer.from(writeXer(plan), 'utf8'),
        type: 'text/plain',
        fileName: `${base}.xer`,
      };
    return {
      body: await writeProgrammeXlsx(plan),
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      fileName: `${base}.xlsx`,
    };
  }

  // --- calendars ---

  async saveCalendar(
    claims: TenantClaims,
    planId: string,
    calendarId: string | null,
    input: {
      rowVersion: number;
      name: string;
      workWeek: number;
      holidays: string[];
      workingDays: string[];
    },
  ) {
    if (input.workWeek === 0 && input.workingDays.length === 0)
      throw new BadRequestException({
        code: 'no_working_days',
        message: 'A calendar needs working days.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.lock(tx, planId, input.rowVersion);
      try {
        if (calendarId) {
          const [c] = await tx`
            UPDATE sched.calendar SET name = ${input.name}, work_week = ${input.workWeek},
              holidays = ${input.holidays}::date[], working_days = ${input.workingDays}::date[]
            WHERE id = ${calendarId} AND plan_id = ${planId} RETURNING 1`;
          if (!c) throw new NotFoundException({ code: 'calendar_not_found' });
        } else
          await tx`
            INSERT INTO sched.calendar (plan_id, name, work_week, holidays, working_days)
            VALUES (${planId}, ${input.name}, ${input.workWeek}, ${input.holidays}::date[],
              ${input.workingDays}::date[])`;
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'calendar_exists',
            message: 'A calendar with this name is already there.',
          });
        throw err;
      }
      await this.recalc(tx, planId);
      await this.touch(tx, planId, claims);
    });
    return this.get(claims, planId);
  }

  // --- project schedules: baselines, resources, look-ahead ---

  private async projectPlan(db: Sql | TransactionSql, planId: string) {
    const [p] = await db<
      { kind: PlanKind; start_on: string; data_date: string | null; archived: boolean }[]
    >`
      SELECT kind, to_char(start_on, 'YYYY-MM-DD') AS start_on, to_char(data_date, 'YYYY-MM-DD') AS data_date,
        archived_at IS NOT NULL AS archived
      FROM sched.plan WHERE id = ${planId}`;
    if (!p) throw new NotFoundException({ code: 'programme_not_found' });
    if (p.kind !== 'project_schedule')
      throw new BadRequestException({
        code: 'not_for_tender_programme',
        message: "A tender's programme has no baselines, resources or look-ahead.",
      });
    return { ...p, asOf: p.data_date ?? p.start_on };
  }

  /**
   * Freezes the schedule's dates as a baseline (kept for good) and shows it against the plan if none is shown yet.
   */
  async takeBaseline(claims: TenantClaims, planId: string, name: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const p = await this.projectPlan(tx, planId);
      if (p.archived)
        throw new ConflictException({
          code: 'programme_archived',
          message: 'This schedule is archived.',
        });
      await tx`SELECT 1 FROM sched.plan WHERE id = ${planId} FOR UPDATE`;
      let b: { id: string } | undefined;
      try {
        [b] = await tx<{ id: string }[]>`
          INSERT INTO sched.baseline (plan_id, name, data_date, finish_on, activity_count, taken_by)
          SELECT id, ${name}, coalesce(data_date, start_on), finish_on, activity_count, ${claims.sub}
          FROM sched.plan WHERE id = ${planId} RETURNING id`;
      } catch (err) {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'baseline_exists',
            message: 'This schedule already has a baseline of that name.',
          });
        throw err;
      }
      await tx`
        INSERT INTO sched.baseline_activity (plan_id, baseline_id, activity_id, start_on, finish_on, duration)
        SELECT plan_id, ${b!.id}, id, early_start, early_finish, duration FROM sched.activity WHERE plan_id = ${planId}`;
      await tx`UPDATE sched.plan SET baseline_id = coalesce(baseline_id, ${b!.id}) WHERE id = ${planId}`;
      await this.touch(tx, planId, claims);
      await planEvent(tx, planId, 'baseline_taken', { name }, claims.sub);
      await audit(tx, claims.sub, 'programme.baseline', 'plan', planId, {
        baselineId: b!.id,
        name,
      });
    });
    return this.get(claims, planId);
  }

  /** The resources an activity needs per working day. */
  async assignments(claims: TenantClaims, planId: string, activityId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projectPlan(db, planId);
    return this.assignmentsOf(db, planId, activityId);
  }

  private assignmentsOf(db: Sql | TransactionSql, planId: string, activityId: string) {
    return db`
      SELECT r.id AS "resourceId", r.code, r.name, r.unit, r.kind, s.units_per_day::text AS "unitsPerDay"
      FROM sched.assignment s JOIN est.resource r ON r.id = s.resource_id
      WHERE s.plan_id = ${planId} AND s.activity_id = ${activityId} ORDER BY r.kind, r.code`;
  }

  /** Puts a resource on an activity at so many units a working day, or (null) takes it off. */
  async assign(
    claims: TenantClaims,
    planId: string,
    input: { activityId: string; resourceId: string; unitsPerDay: string | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const p = await this.projectPlan(tx, planId);
      if (p.archived)
        throw new ConflictException({
          code: 'programme_archived',
          message: 'This schedule is archived.',
        });
      const [a] = await tx<{ kind: string; code: string }[]>`
        SELECT kind, code FROM sched.activity WHERE plan_id = ${planId} AND id = ${input.activityId}`;
      if (!a) throw new NotFoundException({ code: 'activity_not_found' });
      if (input.unitsPerDay === null) {
        await tx`DELETE FROM sched.assignment WHERE plan_id = ${planId} AND activity_id = ${input.activityId}
          AND resource_id = ${input.resourceId}`;
        return;
      }
      if (a.kind !== 'task')
        throw new BadRequestException({
          code: 'not_a_task',
          message: `${a.code} is a ${a.kind}: resources go on activities with working days.`,
        });
      const [r] = await tx<
        { active: boolean }[]
      >`SELECT active FROM est.resource WHERE id = ${input.resourceId}`;
      if (!r?.active) throw new BadRequestException({ code: 'resource_not_found' });
      await tx`
        INSERT INTO sched.assignment (plan_id, activity_id, resource_id, units_per_day)
        VALUES (${planId}, ${input.activityId}, ${input.resourceId}, ${input.unitsPerDay})
        ON CONFLICT (plan_id, activity_id, resource_id) DO UPDATE SET units_per_day = EXCLUDED.units_per_day`;
    });
    return this.assignmentsOf(db, planId, input.activityId);
  }

  /**
   * The resources the schedule needs week by week (Monday to Sunday) from the data date: each assignment's units on
   * each working day of its activity still to do, on the activity's calendar.
   */
  async resourceLoad(claims: TenantClaims, planId: string, weeks: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const p = await this.projectPlan(db, planId);
    const [calendars, plan] = await Promise.all([
      this.calendars(db, planId),
      db<{ calendar_id: string }[]>`SELECT calendar_id FROM sched.plan WHERE id = ${planId}`,
    ]);
    const rows = await db<
      {
        resource_id: string;
        units: string;
        start: string;
        finish: string;
        calendar_id: string | null;
      }[]
    >`
      SELECT s.resource_id, s.units_per_day::text AS units, to_char(a.early_start, 'YYYY-MM-DD') AS start,
        to_char(a.early_finish, 'YYYY-MM-DD') AS finish, a.calendar_id
      FROM sched.assignment s JOIN sched.activity a ON a.plan_id = s.plan_id AND a.id = s.activity_id
      WHERE s.plan_id = ${planId} AND a.status <> 'finished' AND a.early_start IS NOT NULL`;
    const asOf = dayNumber(p.asOf);
    const from = asOf - weekday(asOf); // the Monday of the data date's week
    const to = from + weeks * 7; // exclusive; after it, "later"
    const cals = new Map(
      calendars.map((c) => [c.id, new WorkCalendar(toSpec(c), from - 7, weeks * 7 + 400)]),
    );
    const load = new Map<string, { byWeek: number[]; later: number }>();
    for (const r of rows) {
      const cal = cals.get(r.calendar_id ?? plan[0]!.calendar_id)!;
      const units = Number(r.units);
      const l = load.get(r.resource_id) ?? { byWeek: new Array<number>(weeks).fill(0), later: 0 };
      // What is left: from the data date (or its start, if later) to its finish.
      for (let d = Math.max(dayNumber(r.start), asOf); d <= dayNumber(r.finish); d++) {
        if (!cal.isWorking(d)) continue;
        if (d >= to) l.later += units;
        else l.byWeek[Math.floor((d - from) / 7)]! += units;
      }
      load.set(r.resource_id, l);
    }
    const resources = load.size
      ? await db<{ id: string; code: string; name: string; unit: string; kind: string }[]>`
          SELECT id, code, name, unit, kind FROM est.resource WHERE id = ANY(${[...load.keys()]}::uuid[])
          ORDER BY kind, code`
      : [];
    const round = (n: number) => Math.round(n * 100) / 100;
    return {
      from: isoDay(from),
      weeks: Array.from({ length: weeks }, (_, i) => isoDay(from + i * 7)),
      resources: resources.map((r) => {
        const l = load.get(r.id)!;
        return {
          ...r,
          byWeek: l.byWeek.map(round),
          later: round(l.later),
          total: round(l.byWeek.reduce((x, y) => x + y, 0) + l.later),
        };
      }),
    };
  }

  /** What is on or coming in the next weeks from the data date: activities not finished, by start. */
  async lookahead(claims: TenantClaims, planId: string, weeks: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const p = await this.projectPlan(db, planId);
    const [w] = await db<{ to: string }[]>`
      SELECT to_char(${p.asOf}::date + ${weeks * 7 - 1}::int, 'YYYY-MM-DD') AS to`;
    const activities = await db`
      SELECT a.id::text, a.code, a.name, a.kind, a.status, to_char(a.early_start, 'YYYY-MM-DD') AS start,
        to_char(a.early_finish, 'YYYY-MM-DD') AS finish, to_char(a.actual_start, 'YYYY-MM-DD') AS "actualStart",
        a.remaining_left AS remaining, a.total_float AS "totalFloat", a.critical, w.code AS "wbsCode",
        s.name AS summary
      FROM sched.activity a
      LEFT JOIN sched.activity s ON s.plan_id = a.plan_id AND s.id = a.parent_id
      LEFT JOIN proj.wbs w ON w.id = a.wbs_id
      WHERE a.plan_id = ${planId} AND a.kind <> 'summary' AND a.status <> 'finished'
        AND a.early_start <= ${w!.to}::date AND a.early_finish >= ${p.asOf}::date
      ORDER BY a.early_start, a.code LIMIT 5000`;
    return { from: p.asOf, to: w!.to, weeks, activities };
  }

  // --- helpers ---

  private async lock(tx: TransactionSql, planId: string, rowVersion: number) {
    const [p] = await tx<
      {
        id: string;
        kind: PlanKind;
        project_id: string | null;
        start_on: string;
        data_date: string | null;
        calendar_id: string;
        row_version: number;
        archived: boolean;
      }[]
    >`
      SELECT id, kind, project_id, to_char(start_on, 'YYYY-MM-DD') AS start_on,
        to_char(data_date, 'YYYY-MM-DD') AS data_date, calendar_id, row_version, archived_at IS NOT NULL AS archived
      FROM sched.plan WHERE id = ${planId} FOR UPDATE`;
    if (!p) throw new NotFoundException({ code: 'programme_not_found' });
    if (p.archived)
      throw new ConflictException({
        code: 'programme_archived',
        message: 'This programme is archived. Restore it to change it.',
      });
    if (p.row_version !== rowVersion)
      throw new ConflictException({
        code: 'stale_row',
        message: 'Someone else changed this programme. Reload to see their changes.',
      });
    return p;
  }

  private async recalc(tx: TransactionSql, planId: string) {
    const before = await this.read(tx, planId);
    const plan = {
      id: planId,
      start_on: before.startOn,
      calendar_id: before.calendarId,
      data_date: before.dataDate,
      kind: before.kind,
      project_id: before.projectId,
    };
    const model = new Programme(before.activities, before.links, limitOf(before.kind));
    try {
      model.apply([]);
    } catch (err) {
      toHttp(err);
    }
    await this.save(tx, plan, before, model, before.calendars);
  }

  /**
   * Schedules the edited plan and writes what changed: deleted rows, new rows (temporary ids replaced), changed
   * fields and computed dates, and links. Returns the temporary ids' new ids.
   */
  private async save(
    tx: TransactionSql,
    plan: {
      id: string;
      start_on: string;
      calendar_id: string;
      data_date: string | null;
      kind: PlanKind;
      project_id: string | null;
    },
    before: Awaited<ReturnType<ProgrammeService['read']>>,
    model: Programme,
    calendars: Calendar[],
  ) {
    let result;
    try {
      result = model.schedule(plan.start_on, plan.calendar_id, calendars, plan.data_date);
    } catch (err) {
      return toHttp(err);
    }
    const computed = new Map(result.activities.map((a) => [a.id, a]));
    const old = new Map(before.activities.map((a) => [a.id, a]));
    const now = new Map([...model.acts.values()].map((a) => [a.id, a]));

    const gone = [...old.keys()].filter((id) => !now.has(id));
    if (gone.length)
      await tx`DELETE FROM sched.activity WHERE plan_id = ${plan.id} AND id = ANY(${gone}::bigint[])`;

    // New rows: inserted without their parent, which may itself be new, then given it.
    const idMap = new Map<string, string>();
    const fresh = model.ordered().filter((a) => !old.has(a.id));
    if (fresh.length) {
      const rows = await tx<{ id: string }[]>`
        INSERT INTO sched.activity ${tx(
          fresh.map((a) => ({
            plan_id: plan.id,
            parent_id: null,
            pos: a.pos,
            kind: a.kind,
            // The real code is set with the other changes below, after codes that move away are cleared.
            code: `tmp-${a.id}`,
            name: a.name,
            duration: a.duration,
            calendar_id: a.calendarId,
            constraint_type: a.constraintType,
            constraint_date: a.constraintDate,
            notes: a.notes,
            wbs_id: a.wbsId ?? null,
            package: a.package ?? null,
            trade: a.trade ?? null,
            zone: a.zone ?? null,
          })),
        )} RETURNING id::text`;
      fresh.forEach((a, i) => idMap.set(a.id, rows[i]!.id));
    }
    const real = (id: string | null) => (id === null ? null : (idMap.get(id) ?? id));

    // Every row whose fields differ (new rows included, for their parent and dates), and those whose only change is
    // what the engine computes: a later finish moves every activity's late dates and float, so that is most rows.
    const changed: Record<string, unknown>[] = [];
    const computedOnly: Record<string, unknown>[] = [];
    for (const a of model.ordered()) {
      const c = computed.get(a.id)!;
      const o = old.get(a.id);
      // A summary's duration is its children's span, kept so lists and prints show it.
      if (a.kind === 'summary') a.duration = c.duration;
      const row = {
        id: real(a.id),
        parent_id: real(a.parentId),
        pos: a.pos,
        kind: a.kind,
        code: a.code,
        name: a.name,
        duration: a.duration,
        calendar_id: a.calendarId,
        constraint_type: a.constraintType,
        constraint_date: a.constraintDate,
        notes: a.notes,
        early_start: c.start || null,
        early_finish: c.finish || null,
        late_start: c.lateStart || null,
        late_finish: c.lateFinish || null,
        total_float: c.start ? c.totalFloat : null,
        free_float: c.start ? c.freeFloat : null,
        critical: c.critical,
        wbs_id: a.wbsId ?? null,
        package: a.package ?? null,
        trade: a.trade ?? null,
        zone: a.zone ?? null,
        actual_start: a.actualStart ?? null,
        actual_finish: a.actualFinish ?? null,
        remaining: a.remaining ?? null,
        remaining_left: c.start ? c.remaining : null,
        status: c.status,
      };
      const fieldsChanged =
        !o ||
        o.parentId !== a.parentId ||
        o.pos !== a.pos ||
        o.kind !== a.kind ||
        o.code !== a.code ||
        o.name !== a.name ||
        o.duration !== a.duration ||
        o.calendarId !== a.calendarId ||
        o.constraintType !== a.constraintType ||
        o.constraintDate !== a.constraintDate ||
        o.notes !== a.notes ||
        (o.wbsId ?? null) !== row.wbs_id ||
        (o.package ?? null) !== row.package ||
        (o.trade ?? null) !== row.trade ||
        (o.zone ?? null) !== row.zone ||
        (o.actualStart ?? null) !== row.actual_start ||
        (o.actualFinish ?? null) !== row.actual_finish ||
        (o.remaining ?? null) !== row.remaining;
      if (fieldsChanged) changed.push(row);
      else if (
        o.earlyStart !== row.early_start ||
        o.earlyFinish !== row.early_finish ||
        o.lateStart !== row.late_start ||
        o.lateFinish !== row.late_finish ||
        o.totalFloat !== row.total_float ||
        o.freeFloat !== row.free_float ||
        o.critical !== row.critical ||
        o.remainingLeft !== row.remaining_left ||
        o.status !== row.status
      )
        computedOnly.push(row);
    }
    // Codes are unique: clear the changed ones first so two rows can swap codes in one edit.
    const recoded = changed.filter((r) => old.get(String(r.id))?.code !== r.code);
    if (recoded.length)
      await tx`
        UPDATE sched.activity a SET code = 'tmp-' || a.id::text
        FROM unnest(${recoded.map((r) => r.id) as never}::bigint[]) AS x(id)
        WHERE a.plan_id = ${plan.id} AND a.id = x.id`;
    // One statement per 10,000 rows, the columns as arrays (a whole 50,000-activity plan moves when its finish does).
    const col = (rows: Record<string, unknown>[], k: string) =>
      rows.map((r) => r[k] ?? null) as never;
    for (let i = 0; i < changed.length; i += 10_000) {
      const b = changed.slice(i, i + 10_000);
      await tx`
        UPDATE sched.activity a SET parent_id = x.parent_id, pos = x.pos, kind = x.kind, code = x.code,
          name = x.name, duration = x.duration, calendar_id = x.calendar_id, constraint_type = x.constraint_type,
          constraint_date = x.constraint_date, notes = x.notes, early_start = x.early_start,
          early_finish = x.early_finish, late_start = x.late_start, late_finish = x.late_finish,
          total_float = x.total_float, free_float = x.free_float, critical = x.critical, wbs_id = x.wbs_id,
          package = x.package, trade = x.trade, zone = x.zone,
          actual_start = x.actual_start, actual_finish = x.actual_finish, remaining = x.remaining,
          remaining_left = x.remaining_left, status = x.status, row_version = a.row_version + 1
        FROM unnest(
          ${col(b, 'id')}::bigint[], ${col(b, 'parent_id')}::bigint[], ${col(b, 'pos')}::float8[],
          ${col(b, 'kind')}::text[], ${col(b, 'code')}::text[], ${col(b, 'name')}::text[],
          ${col(b, 'duration')}::int[], ${col(b, 'calendar_id')}::uuid[], ${col(b, 'constraint_type')}::text[],
          ${col(b, 'constraint_date')}::date[], ${col(b, 'notes')}::text[], ${col(b, 'early_start')}::date[],
          ${col(b, 'early_finish')}::date[], ${col(b, 'late_start')}::date[], ${col(b, 'late_finish')}::date[],
          ${col(b, 'total_float')}::int[], ${col(b, 'free_float')}::int[], ${b.map((r) => String(r.critical)) as never}::text[]::bool[],
          ${col(b, 'wbs_id')}::uuid[], ${col(b, 'actual_start')}::date[], ${col(b, 'actual_finish')}::date[],
          ${col(b, 'remaining')}::int[], ${col(b, 'remaining_left')}::int[], ${col(b, 'status')}::text[],
          ${col(b, 'package')}::text[], ${col(b, 'trade')}::text[], ${col(b, 'zone')}::text[]
        ) AS x(id, parent_id, pos, kind, code, name, duration, calendar_id, constraint_type, constraint_date, notes,
          early_start, early_finish, late_start, late_finish, total_float, free_float, critical, wbs_id,
          actual_start, actual_finish, remaining, remaining_left, status, package, trade, zone)
        WHERE a.plan_id = ${plan.id} AND a.id = x.id`;
    }

    // Computed columns only, for the rest.
    for (let i = 0; i < computedOnly.length; i += 10_000) {
      const b = computedOnly.slice(i, i + 10_000);
      await tx`
        UPDATE sched.activity a SET early_start = x.early_start, early_finish = x.early_finish,
          late_start = x.late_start, late_finish = x.late_finish, total_float = x.total_float,
          free_float = x.free_float, critical = x.critical, remaining_left = x.remaining_left, status = x.status
        FROM unnest(
          ${col(b, 'id')}::bigint[], ${col(b, 'early_start')}::date[], ${col(b, 'early_finish')}::date[],
          ${col(b, 'late_start')}::date[], ${col(b, 'late_finish')}::date[], ${col(b, 'total_float')}::int[],
          ${col(b, 'free_float')}::int[], ${b.map((r) => String(r.critical)) as never}::text[]::bool[],
          ${col(b, 'remaining_left')}::int[], ${col(b, 'status')}::text[]
        ) AS x(id, early_start, early_finish, late_start, late_finish, total_float, free_float, critical,
          remaining_left, status)
        WHERE a.plan_id = ${plan.id} AND a.id = x.id`;
    }

    // Links: removed, added, changed.
    const key = (l: Link) => `${l.pred}>${l.succ}`;
    const oldLinks = new Map(before.links.map((l) => [key(l), l]));
    const newLinks = new Map([...model.links.values()].map((l) => [key(l), l]));
    const removed = [...oldLinks.values()].filter(
      (l) => !newLinks.has(key(l)) && now.has(l.pred) && now.has(l.succ),
    );
    for (const l of removed)
      await tx`DELETE FROM sched.relation WHERE plan_id = ${plan.id} AND pred_id = ${l.pred} AND succ_id = ${l.succ}`;
    const upserts = [...newLinks.values()].filter((l) => {
      const o = oldLinks.get(key(l));
      return !o || o.type !== l.type || o.lag !== l.lag;
    });
    if (upserts.length)
      await tx`
        INSERT INTO sched.relation ${tx(
          upserts.map((l) => ({
            plan_id: plan.id,
            pred_id: real(l.pred),
            succ_id: real(l.succ),
            type: l.type,
            lag: l.lag,
          })),
        )}
        ON CONFLICT (plan_id, pred_id, succ_id) DO UPDATE SET type = EXCLUDED.type, lag = EXCLUDED.lag`;

    await tx`
      UPDATE sched.plan SET finish_on = ${result.finish}, duration = ${result.duration},
        activity_count = ${model.acts.size}, computed_at = now() WHERE id = ${plan.id}`;
    return idMap;
  }

  private async touch(tx: TransactionSql, planId: string, claims: TenantClaims) {
    await tx`UPDATE sched.plan SET updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
      WHERE id = ${planId}`;
  }
}

export { MAX_ACTIVITIES };
export type ProgrammeView = Awaited<ReturnType<ProgrammeService['get']>>;

const fileSafe = (s: string) => s.replace(/[^\w.\- ()&]+/g, '_').trim();

/** A plan with two calendars to start from: the site (Mon–Sat) and the office (Mon–Fri), with national holidays. */
async function insertPlan(
  tx: TransactionSql,
  owner: PlanOwner,
  input: { name: string; startOn: string },
  actorId: string,
) {
  const project = 'projectId' in owner ? owner.projectId : null;
  const [p] = await tx<{ id: string }[]>`
    INSERT INTO sched.plan (kind, tender_id, project_id, name, start_on, created_by, updated_by)
    VALUES (${project ? 'project_schedule' : 'tender_programme'}, ${'tenderId' in owner ? owner.tenderId : null},
      ${project}, ${input.name}, ${input.startOn}, ${actorId}, ${actorId}) RETURNING id`;
  const holidays = nationalHolidays(Number(input.startOn.slice(0, 4)), 6);
  const [site] = await tx<{ id: string }[]>`
    INSERT INTO sched.calendar (plan_id, name, work_week, holidays)
    VALUES (${p!.id}, 'Site (Mon–Sat)', ${SITE_WEEK}, ${holidays}::date[]) RETURNING id`;
  await tx`
    INSERT INTO sched.calendar (plan_id, name, work_week, holidays)
    VALUES (${p!.id}, 'Office (Mon–Fri)', ${OFFICE_WEEK}, ${holidays}::date[])`;
  await tx`UPDATE sched.plan SET calendar_id = ${site!.id}, finish_on = start_on, duration = 0,
    computed_at = now() WHERE id = ${p!.id}`;
  return p!.id;
}
