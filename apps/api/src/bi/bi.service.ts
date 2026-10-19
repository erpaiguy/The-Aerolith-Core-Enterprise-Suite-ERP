// The report builder (docs/wave6-plan.md step 3): the views a person may use, running a spec within their access,
// Excel, saved and shared reports, and schedules run by an hourly loop as the report's owner, the file kept 30 days
// and noticed in the recipients' inboxes.
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { APP_CONFIG, type AppConfig } from '../config/config.js';
import { CONTROL_DB } from '../db/db.module.js';
import { reportXlsx, type Column } from '../procurement/procurement-report-excel.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { aggName, build, SpecError, type Spec } from './query.js';
import { VIEWS } from './views.js';
import { exclusively, LOOP_LOCK } from '../common/loop-lock.js';

type Row = Record<string, unknown>;
const ON_SCREEN = 10_000;
const IN_EXCEL = 100_000;
const KEEP_DAYS = 30;
const HOUR = 3_600_000;

export interface Chart {
  kind: 'table' | 'bar' | 'line' | 'pie';
  label?: string;
  value?: string;
}

/** The next run at 07:00 IST after `from`: every day, on a weekday (1 Monday … 7 Sunday), or a day of the month. */
export function nextRun(
  s: { cadence: 'daily' | 'weekly' | 'monthly'; weekday: number | null; monthday: number | null },
  from: Date,
): Date {
  const istDay = (d: Date) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  const at = (day: string) => new Date(`${day}T07:00:00+05:30`);
  let day = istDay(from);
  for (let i = 0; i < 62; i++) {
    const t = at(day);
    const dow = ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const dom = Number(day.slice(8, 10));
    const ok =
      s.cadence === 'daily' ||
      (s.cadence === 'weekly' && dow === s.weekday) ||
      (s.cadence === 'monthly' && dom === s.monthday);
    if (ok && t > from) return t;
    day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  throw new Error('no next run');
}

@Injectable()
export class BiService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Reports');
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    @Inject(CONTROL_DB) private readonly control: Sql,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit() {
    if (!this.config.reportsWorker) return;
    this.timer = setInterval(() => void this.tick(), HOUR);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  // --- the model ---

  async views(claims: TenantClaims) {
    const out = [];
    for (const [name, v] of Object.entries(VIEWS)) {
      if (v.needs && !(await this.permissions.can(claims, v.needs))) continue;
      out.push({
        name,
        label: v.label,
        fields: Object.entries(v.fields).map(([f, d]) => ({ name: f, ...d })),
      });
    }
    return out;
  }

  /** The projects a person may see in reports: null for all (projects.all, admins). */
  private async scope(db: Sql, claims: TenantClaims): Promise<string[] | null> {
    if (await this.permissions.can(claims, 'projects.all')) return null;
    const rows = await db<{ project_id: string }[]>`
      SELECT project_id FROM proj.member WHERE user_id = ${claims.sub}`;
    return rows.map((r) => r.project_id);
  }

  private async query(claims: TenantClaims, spec: Spec, cap: number) {
    const view = VIEWS[spec.view];
    if (view?.needs && !(await this.permissions.can(claims, view.needs)))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: view.needs,
        message: `${view.label} needs the ${view.needs} permission.`,
      });
    const db = await this.tenants.forTenant(claims.ten);
    let built;
    try {
      built = build(
        { ...spec, limit: Math.min(spec.limit, cap) + 1 },
        await this.scope(db, claims),
      );
    } catch (e) {
      if (e instanceof SpecError)
        throw new BadRequestException({ code: e.code, message: e.message });
      throw e;
    }
    const rows = (await db.unsafe(built.sql, built.params as never[])) as Row[];
    const truncated = rows.length > Math.min(spec.limit, cap);
    return {
      view: built.view,
      columns: built.columns,
      rows: (truncated ? rows.slice(0, -1) : rows).map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            v instanceof Date ? v.toISOString().slice(0, 10) : v,
          ]),
        ),
      ),
      truncated,
    };
  }

  async run(claims: TenantClaims, spec: Spec) {
    const r = await this.query(claims, spec, ON_SCREEN);
    return { columns: this.headers(spec, r.columns), rows: r.rows, truncated: r.truncated };
  }

  private headers(spec: Spec, columns: string[]) {
    const v = VIEWS[spec.view]!;
    return columns.map((c) => {
      const f = v.fields[c];
      if (f) return { name: c, label: f.label, type: f.type };
      if (c === 'count') return { name: c, label: 'Count', type: 'number' as const };
      const a = spec.aggregates.find((x) => aggName(x) === c)!;
      const words = { sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest', count: 'Count' };
      const base = v.fields[a.field]!;
      return { name: c, label: `${words[a.fn]} ${base.label.toLowerCase()}`, type: base.type };
    });
  }

  async xlsx(claims: TenantClaims, spec: Spec, title: string) {
    const r = await this.query(claims, spec, IN_EXCEL);
    const headers = this.headers(spec, r.columns);
    const columns: Column<Row>[] = headers.map((h) => ({
      header: h.label,
      value: (row) => {
        const v = row[h.name];
        if (v === null || v === undefined) return null;
        return h.type === 'money' || h.type === 'number' ? Number(v) : String(v);
      },
      ...(h.type === 'money' ? { format: '#,##0.00' } : {}),
    }));
    const buffer = await reportXlsx<Row>(
      title.slice(0, 31) || 'Report',
      [title, `${r.view.label}${r.truncated ? ` · the first ${IN_EXCEL} rows` : ''}`],
      columns,
      r.rows,
    );
    return { buffer, rows: r.rows.length };
  }

  // --- saved reports ---

  private visible(claims: TenantClaims) {
    return claims.role === 'worker' ? ['everyone'] : ['managers', 'everyone'];
  }

  async list(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT r.id, r.name, r.spec, r.chart, r.shared_with AS "sharedWith", u.display_name AS owner,
        r.owner_id = ${claims.sub} AS mine, r.updated_at AS "updatedAt", r.row_version AS "rowVersion",
        (SELECT json_agg(json_build_object('id', s.id, 'cadence', s.cadence, 'weekday', s.weekday, 'monthday', s.monthday,
            'nextRunAt', s.next_run_at, 'lastRunAt', s.last_run_at, 'lastError', s.last_error))
          FROM bi.schedule s WHERE s.report_id = r.id AND s.active) AS schedules
      FROM bi.report r JOIN platform."user" u ON u.id = r.owner_id
      WHERE r.owner_id = ${claims.sub} OR ${claims.role === 'admin'} OR r.shared_with = ANY(${this.visible(claims)})
      ORDER BY r.name`;
  }

  private async own(db: Sql, claims: TenantClaims, id: string) {
    const [r] = await db<{ owner_id: string; spec: Spec; name: string }[]>`
      SELECT owner_id, spec, name FROM bi.report WHERE id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'not_found', message: 'No such report.' });
    if (r.owner_id !== claims.sub && claims.role !== 'admin')
      throw new ForbiddenException({
        code: 'not_yours',
        message: 'Only its owner changes a report.',
      });
    return r;
  }

  async save(
    claims: TenantClaims,
    id: string | null,
    input: {
      name: string;
      spec: Spec;
      chart: Chart;
      sharedWith: 'nobody' | 'managers' | 'everyone';
    },
  ) {
    // A report must run for its owner as saved.
    await this.query(claims, { ...input.spec, limit: 1 }, 1);
    const cols = (c: Chart, v: Spec) => {
      const all = [...(v.groupBy.length ? v.groupBy : v.fields), ...v.aggregates.map(aggName)];
      if (
        c.kind !== 'table' &&
        (!c.label || !c.value || !all.includes(c.label) || !all.includes(c.value))
      )
        throw new BadRequestException({
          code: 'bad_chart',
          message: 'A chart needs a label column and a value column from the result.',
        });
    };
    cols(input.chart, input.spec);
    const db = await this.tenants.forTenant(claims.ten);
    const rid = await db.begin(async (tx) => {
      if (id) {
        await this.own(tx as unknown as Sql, claims, id);
        await tx`
          UPDATE bi.report SET name = ${input.name}, spec = ${tx.json(input.spec as never)},
            chart = ${tx.json(input.chart as never)}, shared_with = ${input.sharedWith}, updated_at = now(),
            row_version = row_version + 1
          WHERE id = ${id}`;
        return id;
      }
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO bi.report (name, spec, chart, shared_with, owner_id)
        VALUES (${input.name}, ${tx.json(input.spec as never)}, ${tx.json(input.chart as never)}, ${input.sharedWith},
          ${claims.sub}) RETURNING id`;
      await audit(tx, claims.sub, 'report.save', 'report', r!.id, { name: input.name });
      return r!.id;
    });
    return { id: rid, reports: await this.list(claims) };
  }

  async remove(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.own(db, claims, id);
    await db.begin(async (tx) => {
      await tx`DELETE FROM bi.report WHERE id = ${id}`;
      await audit(tx, claims.sub, 'report.delete', 'report', id, {});
    });
    return this.list(claims);
  }

  /** A saved report, run for whoever opens it: shared reports show each person their own projects' rows. */
  async open(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await db<
      { name: string; spec: Spec; chart: Chart; owner_id: string; shared_with: string }[]
    >`
      SELECT name, spec, chart, owner_id, shared_with FROM bi.report WHERE id = ${id}`;
    if (
      !r ||
      (r.owner_id !== claims.sub &&
        claims.role !== 'admin' &&
        !this.visible(claims).includes(r.shared_with))
    )
      throw new NotFoundException({ code: 'not_found', message: 'No such report.' });
    return { name: r.name, spec: r.spec, chart: r.chart, result: await this.run(claims, r.spec) };
  }

  // --- schedules ---

  async schedule(
    claims: TenantClaims,
    reportId: string,
    input: {
      cadence: 'daily' | 'weekly' | 'monthly';
      weekday: number | null;
      monthday: number | null;
      recipients: string[];
    },
  ) {
    if (claims.role === 'worker')
      throw new ForbiddenException({ code: 'forbidden', message: 'Managers schedule reports.' });
    const db = await this.tenants.forTenant(claims.ten);
    await this.own(db, claims, reportId);
    const s = {
      cadence: input.cadence,
      weekday: input.cadence === 'weekly' ? (input.weekday ?? 1) : null,
      monthday: input.cadence === 'monthly' ? (input.monthday ?? 1) : null,
    };
    if (input.recipients.length) {
      const [{ n }] = (await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM platform."user" WHERE id = ANY(${input.recipients}::uuid[]) AND status = 'active'`) as unknown as [
        { n: number },
      ];
      if (n !== new Set(input.recipients).size)
        throw new BadRequestException({
          code: 'no_such_user',
          message: 'A recipient is not a user.',
        });
    }
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO bi.schedule (report_id, cadence, weekday, monthday, recipients, next_run_at, created_by)
        VALUES (${reportId}, ${s.cadence}, ${s.weekday}, ${s.monthday}, ${[...new Set(input.recipients)]}::uuid[],
          ${nextRun(s, new Date())}, ${claims.sub})`;
      await audit(tx, claims.sub, 'report.schedule', 'report', reportId, s);
    });
    return this.list(claims);
  }

  async unschedule(claims: TenantClaims, scheduleId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db<
      { report_id: string }[]
    >`SELECT report_id FROM bi.schedule WHERE id = ${scheduleId}`;
    if (!s) throw new NotFoundException({ code: 'not_found', message: 'No such schedule.' });
    await this.own(db, claims, s.report_id);
    await db`UPDATE bi.schedule SET active = false WHERE id = ${scheduleId}`;
    return this.list(claims);
  }

  /** An export kept for the people it was made for. */
  async export(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db<{ file_name: string; bytes: Buffer; readers: string[] }[]>`
      SELECT file_name, bytes, readers FROM bi.export WHERE id = ${id}`;
    if (!e || !e.readers.includes(claims.sub))
      throw new NotFoundException({
        code: 'not_found',
        message: 'No such export, or it has expired.',
      });
    return { fileName: e.file_name, bytes: e.bytes };
  }

  // --- the runner ---

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await exclusively(this.control, LOOP_LOCK.reports, async () => {
        const tenants = await this.control<{ tenant_id: string }[]>`
          SELECT tenant_id FROM core.tenant_db WHERE status = 'ready'`;
        for (const { tenant_id } of tenants)
          await this.runDue(tenant_id, new Date()).catch((err: unknown) =>
            this.log.warn(`Scheduled reports failed for ${tenant_id}: ${(err as Error).message}`),
          );
      });
    } finally {
      this.running = false;
    }
  }

  /** Runs every schedule due by `now` as its report's owner, then moves it on; also clears exports past 30 days. */
  async runDue(tenantId: string, now: Date) {
    const db = await this.tenants.forTenant(tenantId);
    await db`DELETE FROM bi.export WHERE made_at < ${new Date(now.getTime() - KEEP_DAYS * 86_400_000)}`;
    const due = await db<
      {
        id: string;
        report_id: string;
        cadence: 'daily' | 'weekly' | 'monthly';
        weekday: number | null;
        monthday: number | null;
        recipients: string[];
        name: string;
        spec: Spec;
        owner_id: string;
        role: TenantClaims['role'];
        status: string;
      }[]
    >`
      SELECT s.id, s.report_id, s.cadence, s.weekday, s.monthday, s.recipients, r.name, r.spec, r.owner_id, u.role, u.status
      FROM bi.schedule s JOIN bi.report r ON r.id = s.report_id JOIN platform."user" u ON u.id = r.owner_id
      WHERE s.active AND s.next_run_at <= ${now} ORDER BY s.next_run_at`;
    let made = 0;
    for (const s of due) {
      const next = nextRun(s, now);
      if (s.status !== 'active') {
        await db`UPDATE bi.schedule SET next_run_at = ${next}, last_error = 'The owner is no longer active.' WHERE id = ${s.id}`;
        continue;
      }
      const t = Math.floor(now.getTime() / 1000);
      const owner: TenantClaims = {
        v: 1,
        kind: 'tenant',
        ten: tenantId,
        sub: s.owner_id,
        role: s.role,
        sid: 'scheduled-report',
        mcp: false,
        lic: 'active',
        iat: t,
        exp: t + 60,
      };
      try {
        const day = new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
        const x = await this.xlsx(owner, s.spec, s.name);
        const readers = [...new Set([s.owner_id, ...s.recipients])];
        await db.begin(async (tx) => {
          const [e] = await tx<{ id: string }[]>`
            INSERT INTO bi.export (schedule_id, report_id, file_name, bytes, rows, readers)
            VALUES (${s.id}, ${s.report_id}, ${`${s.name} ${day}.xlsx`.replace(/[/\\]/g, '-')}, ${x.buffer}, ${x.rows},
              ${readers}::uuid[]) RETURNING id`;
          for (const u of readers)
            await tx`INSERT INTO platform.notification (user_id, kind, title, link)
              VALUES (${u}, 'report', ${`${s.name}: ${x.rows} rows, ${day}`}, ${`/reports/builder?export=${e!.id}`})`;
          await tx`UPDATE bi.schedule SET next_run_at = ${next}, last_run_at = ${now}, last_error = NULL WHERE id = ${s.id}`;
        });
        made++;
      } catch (err) {
        await db`UPDATE bi.schedule SET next_run_at = ${next}, last_error = ${(err as Error).message.slice(0, 500)} WHERE id = ${s.id}`;
      }
    }
    return made;
  }
}
