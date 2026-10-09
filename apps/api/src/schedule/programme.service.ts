// Tender programmes (docs/04-features.md E9, docs/wave1-plan.md step 11): a tender's submission programme, edited
// as a whole and recalculated on every change. The plan is read into memory (programme-model.ts), the edits are
// applied and the plan scheduled there, and only what changed is written back, in one transaction under the plan's
// row version. Everyone reads; changes need `programme.edit`.
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit, event } from '../tender/tender-records.js';
import { writeProgrammeXlsx } from './interchange/excel.js';
import { toOps, type ImportedPlan } from './interchange/imported.js';
import { readMspdi, writeMspdi } from './interchange/mspdi.js';
import { readXer, writeXer } from './interchange/xer.js';
import {
  MAX_ACTIVITIES,
  Programme,
  ProgrammeError,
  nationalHolidays,
  type Activity,
  type Calendar,
  type Link,
  type Op,
} from './programme-model.js';

const SITE_WEEK = 0b0111111; // Mon–Sat
const OFFICE_WEEK = 0b0011111; // Mon–Fri

interface PlanRow {
  id: string;
  tenderId: string;
  name: string;
  startOn: string;
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
  constructor(private readonly tenants: TenantConnections) {}

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
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO sched.plan (tender_id, name, start_on, created_by, updated_by)
        VALUES (${tenderId}, ${input.name}, ${input.startOn}, ${claims.sub}, ${claims.sub}) RETURNING id`;
      const holidays = nationalHolidays(Number(input.startOn.slice(0, 4)), 6);
      const [site] = await tx<{ id: string }[]>`
        INSERT INTO sched.calendar (plan_id, name, work_week, holidays)
        VALUES (${p!.id}, 'Site (Mon–Sat)', ${SITE_WEEK}, ${holidays}::date[]) RETURNING id`;
      await tx`
        INSERT INTO sched.calendar (plan_id, name, work_week, holidays)
        VALUES (${p!.id}, 'Office (Mon–Fri)', ${OFFICE_WEEK}, ${holidays}::date[])`;
      await tx`UPDATE sched.plan SET calendar_id = ${site!.id}, finish_on = start_on, duration = 0,
        computed_at = now() WHERE id = ${p!.id}`;
      await event(tx, tenderId, 'programme_created', { name: input.name }, claims.sub);
      return p!.id;
    });
    return this.get(claims, id);
  }

  async get(claims: TenantClaims, planId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return this.read(db, planId);
  }

  private async read(db: Sql | TransactionSql, planId: string) {
    const [plan] = await db<(PlanRow & { tender: { number: string; title: string } })[]>`
      SELECT p.id, p.tender_id AS "tenderId", p.name, to_char(p.start_on, 'YYYY-MM-DD') AS "startOn",
        p.calendar_id AS "calendarId", p.notes, to_char(p.finish_on, 'YYYY-MM-DD') AS "finishOn", p.duration,
        p.activity_count AS "activityCount", p.computed_at AS "computedAt", p.archived_at AS "archivedAt",
        p.row_version AS "rowVersion", json_build_object('number', t.number, 'title', t.title) AS tender
      FROM sched.plan p JOIN tender.tender t ON t.id = p.tender_id WHERE p.id = ${planId}`;
    if (!plan) throw new NotFoundException({ code: 'programme_not_found' });
    const [calendars, rows, links] = await Promise.all([
      this.calendars(db, planId),
      db<Omit<ActivityView, 'depth'>[]>`
        SELECT id::text, parent_id::text AS "parentId", pos, kind, code, name, duration, calendar_id AS "calendarId",
          constraint_type AS "constraintType", to_char(constraint_date, 'YYYY-MM-DD') AS "constraintDate", notes,
          to_char(early_start, 'YYYY-MM-DD') AS "earlyStart", to_char(early_finish, 'YYYY-MM-DD') AS "earlyFinish",
          to_char(late_start, 'YYYY-MM-DD') AS "lateStart", to_char(late_finish, 'YYYY-MM-DD') AS "lateFinish",
          total_float AS "totalFloat", free_float AS "freeFloat", critical
        FROM sched.activity WHERE plan_id = ${planId}`,
      this.links(db, planId),
    ]);
    const model = new Programme(rows, links);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const activities: ActivityView[] = model.ordered().map((a) => {
      const r = byId.get(a.id)!;
      return { ...r, depth: model.depth(a.id) };
    });
    return { ...plan, calendars, activities, links };
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
      const model = new Programme(before.activities, before.links);
      for (const o of ops)
        if (o.op === 'insert' || o.op === 'update')
          if (o.calendarId && !before.calendars.some((c) => c.id === o.calendarId))
            throw new BadRequestException({ code: 'calendar_not_found' });
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
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await this.lock(tx, planId, input.rowVersion);
      const cols = Object.fromEntries(
        Object.entries({
          name: input.name,
          start_on: input.startOn,
          calendar_id: input.calendarId,
          notes: input.notes,
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
      const [p] = await tx<{ tender_id: string; name: string }[]>`
        UPDATE sched.plan SET archived_at = ${archived ? tx`now()` : null}, updated_by = ${claims.sub},
          updated_at = now(), row_version = row_version + 1
        WHERE id = ${planId} RETURNING tender_id, name`;
      if (!p) throw new NotFoundException({ code: 'programme_not_found' });
      await event(
        tx,
        p.tender_id,
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
  async importFile(claims: TenantClaims, tenderId: string, file: { name: string; buffer: Buffer }) {
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
    if (parsed.activities.length > MAX_ACTIVITIES)
      throw new BadRequestException({
        code: 'too_many',
        message: `A programme holds up to ${MAX_ACTIVITIES} activities; this file has ${parsed.activities.length}.`,
      });
    const db = await this.tenants.forTenant(claims.ten);
    const warnings = [...parsed.warnings];
    const planId = await db.begin(async (tx) => {
      const [t] = await tx`SELECT 1 FROM tender.tender WHERE id = ${tenderId}`;
      if (!t) throw new NotFoundException({ code: 'tender_not_found' });
      const [p] = await tx<{ id: string }[]>`
        INSERT INTO sched.plan (tender_id, name, start_on, notes, created_by, updated_by)
        VALUES (${tenderId}, ${parsed.name}, ${parsed.startOn},
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
      const model = new Programme([], []);
      try {
        model.apply(built.ops);
      } catch (err) {
        toHttp(err);
      }
      await this.save(
        tx,
        { id: p!.id, start_on: parsed.startOn, calendar_id: defaultId },
        before,
        model,
        before.calendars,
      );
      await event(
        tx,
        tenderId,
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
    const base = fileSafe(`${plan.tender.number} ${plan.name}`);
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

  // --- helpers ---

  private async lock(tx: TransactionSql, planId: string, rowVersion: number) {
    const [p] = await tx<
      {
        id: string;
        start_on: string;
        calendar_id: string;
        row_version: number;
        archived: boolean;
      }[]
    >`
      SELECT id, to_char(start_on, 'YYYY-MM-DD') AS start_on, calendar_id, row_version, archived_at IS NOT NULL AS archived
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
    const plan = { id: planId, start_on: before.startOn, calendar_id: before.calendarId };
    const model = new Programme(before.activities, before.links);
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
    plan: { id: string; start_on: string; calendar_id: string },
    before: Awaited<ReturnType<ProgrammeService['read']>>,
    model: Programme,
    calendars: Calendar[],
  ) {
    let result;
    try {
      result = model.schedule(plan.start_on, plan.calendar_id, calendars);
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
          })),
        )} RETURNING id::text`;
      fresh.forEach((a, i) => idMap.set(a.id, rows[i]!.id));
    }
    const real = (id: string | null) => (id === null ? null : (idMap.get(id) ?? id));

    // Every row whose fields or computed dates differ (new rows included, for their parent and dates).
    const changed: Record<string, unknown>[] = [];
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
      };
      if (
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
        o.earlyStart !== row.early_start ||
        o.earlyFinish !== row.early_finish ||
        o.lateStart !== row.late_start ||
        o.lateFinish !== row.late_finish ||
        o.totalFloat !== row.total_float ||
        o.freeFloat !== row.free_float ||
        o.critical !== row.critical
      )
        changed.push(row);
    }
    // Codes are unique: clear the changed ones first so two rows can swap codes in one edit.
    if (changed.length) {
      for (let i = 0; i < changed.length; i += 5000) {
        const batch = changed.slice(i, i + 5000);
        await tx`
          UPDATE sched.activity a SET code = 'tmp-' || a.id::text
          FROM jsonb_to_recordset(${tx.json(batch as never)}) AS x(id bigint, code text)
          WHERE a.plan_id = ${plan.id} AND a.id = x.id AND a.code <> x.code`;
      }
      for (let i = 0; i < changed.length; i += 5000) {
        const batch = changed.slice(i, i + 5000);
        await tx`
          UPDATE sched.activity a SET parent_id = x.parent_id, pos = x.pos, kind = x.kind, code = x.code,
            name = x.name, duration = x.duration, calendar_id = x.calendar_id, constraint_type = x.constraint_type,
            constraint_date = x.constraint_date, notes = x.notes, early_start = x.early_start,
            early_finish = x.early_finish, late_start = x.late_start, late_finish = x.late_finish,
            total_float = x.total_float, free_float = x.free_float, critical = x.critical,
            row_version = a.row_version + 1
          FROM jsonb_to_recordset(${tx.json(batch as never)}) AS x(id bigint, parent_id bigint, pos float8, kind text,
            code text, name text, duration int, calendar_id uuid, constraint_type text, constraint_date date,
            notes text, early_start date, early_finish date, late_start date, late_finish date, total_float int,
            free_float int, critical boolean)
          WHERE a.plan_id = ${plan.id} AND a.id = x.id`;
      }
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
