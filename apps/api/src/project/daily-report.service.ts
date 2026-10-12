// Daily site reports (docs/04-features.md R6, docs/wave2b-plan.md step 7): what happened on a site on a day. Built up
// through the day from a phone (each save replaces the report's sections), submitted by the site, acknowledged by the
// project's lead; a submitted report is changed only by a correction with a reason, which puts it back to draft.
// Materials received and issued that day are read from the receipts and issue slips; photos go into the tenant's file
// store. Submitting one sets the next evening's reminder for the same site.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Sql, TransactionSql } from 'postgres';
import { indiaToday } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { DocumentsService } from '../documents/documents.service.js';
import { FileTooLargeError } from '../documents/file-store.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { ProjectService } from './project.service.js';
import { LabourService } from '../labour/labour.service.js';

type Db = Sql | TransactionSql;
export type Weather = 'clear' | 'cloudy' | 'rain' | 'heavy_rain' | 'storm';
export type Cause =
  | 'rain'
  | 'drawings'
  | 'client_decision'
  | 'materials'
  | 'labour'
  | 'equipment'
  | 'power_water'
  | 'site_access'
  | 'other';

export interface ReportInput {
  weatherAm: Weather | null;
  weatherPm: Weather | null;
  rainHours: string | null;
  safety: string;
  visitors: string;
  notes: string;
  manpower: { trade: string; partyId: string | null; headcount: number; note: string }[];
  equipment: {
    name: string;
    ownership: 'own' | 'hired';
    count: number;
    hoursWorked: string;
    hoursIdle: string;
    idleReason: string;
  }[];
  work: { boqCode: string | null; description: string; qty: string | null; unit: string }[];
  hindrances: {
    cause: Cause;
    description: string;
    hours: string;
    account: 'client' | 'contractor' | 'neutral';
  }[];
}

interface ReportRow {
  id: string;
  project_id: string;
  site_id: string;
  report_date: string;
  status: 'draft' | 'submitted' | 'acknowledged';
  row_version: number;
}

export const PHOTO_MAX = 8 * 1024 * 1024;
const MISSING_DAYS = 14;
/** Picture formats by their first bytes. */
export function imageType(head: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

@Injectable()
export class DailyReportService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly permissions: PermissionsService,
    private readonly documents: DocumentsService,
  ) {}

  // --- who may ---

  private async role(db: Db, claims: TenantClaims, projectId: string) {
    const a = await this.projects.access(db, claims, projectId);
    const writes = a.canEdit || a.role === 'lead' || a.role === 'member';
    const acknowledges =
      (a.canEdit || a.role === 'lead') && (await this.permissions.can(claims, 'dsr.acknowledge'));
    return { writes, acknowledges };
  }

  private async mustWrite(db: Db, claims: TenantClaims, projectId: string) {
    if (!(await this.role(db, claims, projectId)).writes)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team (not its viewers) writes its daily reports.",
      });
  }

  private async report(db: Db, id: string, lock = false) {
    const [r] = lock
      ? await db<ReportRow[]>`SELECT * FROM proj.daily_report WHERE id = ${id} FOR UPDATE`
      : await db<ReportRow[]>`SELECT * FROM proj.daily_report WHERE id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'report_not_found' });
    return r;
  }

  // --- making and keeping ---

  /**
   * Today's (or a past day's) report for a site, as a draft. Who worked and what plant was on site are carried over
   * from the site's last report, to change rather than type again.
   */
  async create(
    claims: TenantClaims,
    projectId: string,
    input: { siteId: string; reportDate: string },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mustWrite(db, claims, projectId);
    if (input.reportDate > indiaToday())
      throw new BadRequestException({ code: 'in_future', message: 'Not a day in the future.' });
    const [site] = await db<{ active: boolean }[]>`
      SELECT active FROM proj.site WHERE id = ${input.siteId} AND project_id = ${projectId}`;
    if (!site)
      throw new BadRequestException({
        code: 'site_not_found',
        message: "Choose one of the project's sites.",
      });
    const id = await db.begin(async (tx) => {
      const [r] = await tx<{ id: string }[]>`
        INSERT INTO proj.daily_report (project_id, site_id, report_date, created_by, updated_by)
        VALUES (${projectId}, ${input.siteId}, ${input.reportDate}, ${claims.sub}, ${claims.sub})
        ON CONFLICT (site_id, report_date) DO NOTHING RETURNING id`;
      if (!r) {
        const [existing] = await tx<{ id: string }[]>`
          SELECT id FROM proj.daily_report WHERE site_id = ${input.siteId} AND report_date = ${input.reportDate}`;
        throw new ConflictException({
          code: 'report_exists',
          id: existing!.id,
          message: 'That site already has a report for that day.',
        });
      }
      const [last] = await tx<{ id: string }[]>`
        SELECT id FROM proj.daily_report WHERE site_id = ${input.siteId} AND report_date < ${input.reportDate}
        ORDER BY report_date DESC LIMIT 1`;
      if (last) {
        await tx`INSERT INTO proj.dr_manpower (report_id, position, trade, party_id, headcount, note)
          SELECT ${r.id}, position, trade, party_id, headcount, '' FROM proj.dr_manpower WHERE report_id = ${last.id}`;
        await tx`INSERT INTO proj.dr_equipment (report_id, position, name, ownership, count)
          SELECT ${r.id}, position, name, ownership, count FROM proj.dr_equipment WHERE report_id = ${last.id}`;
      }
      return r.id;
    });
    return this.get(claims, id);
  }

  /** The report's sections, replaced as a whole on each save. */
  async update(claims: TenantClaims, reportId: string, rowVersion: number, input: ReportInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const r0 = await this.report(db, reportId);
    await this.mustWrite(db, claims, r0.project_id);
    const parties = [
      ...new Set(input.manpower.map((m) => m.partyId).filter((x): x is string => !!x)),
    ];
    if (parties.length) {
      const found = await db`SELECT id FROM platform.party WHERE id = ANY(${parties}::uuid[])`;
      if (found.length !== parties.length)
        throw new BadRequestException({ code: 'party_not_found' });
    }
    const keys = new Map<string, string>();
    for (const code of new Set(input.work.map((w) => w.boqCode).filter((x): x is string => !!x))) {
      const found = await db<{ line_key: string }[]>`
        SELECT n.line_key FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
        WHERE b.project_id = ${r0.project_id} AND b.kind = 'contract' AND b.archived_at IS NULL
          AND lower(n.code) = lower(${code})`;
      if (found.length !== 1)
        throw new BadRequestException({
          code: 'boq_item_not_found',
          message: `No single item ${code} in the project's contract BOQ.`,
        });
      keys.set(code, found[0]!.line_key);
    }
    await db.begin(async (tx) => {
      const [u] = await tx`
        UPDATE proj.daily_report SET weather_am = ${input.weatherAm}, weather_pm = ${input.weatherPm},
          rain_hours = ${input.rainHours}, safety = ${input.safety}, visitors = ${input.visitors},
          notes = ${input.notes}, updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${reportId} AND row_version = ${rowVersion} AND status = 'draft' RETURNING id`;
      if (!u) {
        const now = await this.report(tx, reportId);
        throw new ConflictException(
          now.status !== 'draft'
            ? {
                code: 'not_draft',
                message: 'It has been submitted: correct it (with a reason) to change it.',
              }
            : {
                code: 'stale_row',
                message: 'Someone else saved this report since. Reload to see their changes.',
              },
        );
      }
      await tx`DELETE FROM proj.dr_manpower WHERE report_id = ${reportId}`;
      await tx`DELETE FROM proj.dr_equipment WHERE report_id = ${reportId}`;
      await tx`DELETE FROM proj.dr_work WHERE report_id = ${reportId}`;
      await tx`DELETE FROM proj.dr_hindrance WHERE report_id = ${reportId}`;
      const rows = <T extends object>(list: T[]) =>
        list.map((x, i) => ({ report_id: reportId, position: i + 1, ...x }));
      if (input.manpower.length)
        await tx`INSERT INTO proj.dr_manpower ${tx(
          rows(
            input.manpower.map((m) => ({
              trade: m.trade,
              party_id: m.partyId,
              headcount: m.headcount,
              note: m.note,
            })),
          ),
        )}`;
      if (input.equipment.length)
        await tx`INSERT INTO proj.dr_equipment ${tx(
          rows(
            input.equipment.map((e) => ({
              name: e.name,
              ownership: e.ownership,
              count: e.count,
              hours_worked: e.hoursWorked,
              hours_idle: e.hoursIdle,
              idle_reason: e.idleReason,
            })),
          ),
        )}`;
      if (input.work.length)
        await tx`INSERT INTO proj.dr_work ${tx(
          rows(
            input.work.map((w) => ({
              line_key: w.boqCode ? keys.get(w.boqCode)! : null,
              description: w.description,
              qty: w.qty,
              unit: w.unit,
            })),
          ),
        )}`;
      if (input.hindrances.length)
        await tx`INSERT INTO proj.dr_hindrance ${tx(
          rows(
            input.hindrances.map((h) => ({
              cause: h.cause,
              description: h.description,
              hours: h.hours,
              account: h.account,
            })),
          ),
        )}`;
    });
    return this.get(claims, reportId);
  }

  /** Done for the day: the lead is asked to acknowledge it, and the next evening's reminder is set. */
  async submit(claims: TenantClaims, reportId: string, rowVersion: number) {
    const db = await this.tenants.forTenant(claims.ten);
    const r0 = await this.report(db, reportId);
    await this.mustWrite(db, claims, r0.project_id);
    await db.begin(async (tx) => {
      const [u] = await tx<{ report_date: string }[]>`
        UPDATE proj.daily_report SET status = 'submitted', submitted_at = now(), submitted_by = ${claims.sub},
          updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${reportId} AND row_version = ${rowVersion} AND status = 'draft'
        RETURNING to_char(report_date, 'YYYY-MM-DD') AS report_date`;
      if (!u)
        throw new ConflictException({
          code: 'not_submittable',
          message: 'It was changed by someone else, or is already submitted.',
        });
      await tx`INSERT INTO proj.dr_event (report_id, kind, actor_id) VALUES (${reportId}, 'submitted', ${claims.sub})`;
      await this.remindTomorrow(tx, claims, r0, u.report_date);
      await audit(tx, claims.sub, 'daily_report.submit', 'daily_report', reportId, {
        date: u.report_date,
      });
    });
    return this.get(claims, reportId);
  }

  /**
   * A reminder to whoever submitted it, at 7 pm (India) the next day, for the same site; any reminder for this site
   * still to come is replaced, so a report submitted before its evening also clears that evening's reminder.
   */
  private async remindTomorrow(
    tx: TransactionSql,
    claims: TenantClaims,
    r: ReportRow,
    reportDate: string,
  ) {
    const link = `/projects/${r.project_id}/daily-reports?site=${r.site_id}`;
    await tx`DELETE FROM platform.notification WHERE kind = 'dsr_reminder' AND link = ${link}
      AND user_id = ${claims.sub} AND due_at > now()`;
    const next = addDays(reportDate, 1);
    const due = new Date(`${next}T13:30:00Z`); // 19:00 in India
    if (due.getTime() <= Date.now()) return;
    const [site] = await tx<{ name: string }[]>`SELECT name FROM proj.site WHERE id = ${r.site_id}`;
    await tx`INSERT INTO platform.notification (user_id, kind, title, body, link, due_at)
      VALUES (${claims.sub}, 'dsr_reminder', ${`Daily report for ${site!.name}`},
        ${`The report for ${next} is not submitted yet.`}, ${link}, ${due})`;
  }

  async acknowledge(claims: TenantClaims, reportId: string, comment: string | null) {
    const db = await this.tenants.forTenant(claims.ten);
    const r0 = await this.report(db, reportId);
    const may = await this.role(db, claims, r0.project_id);
    if (!may.acknowledges)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's lead (with dsr.acknowledge) acknowledges its daily reports.",
      });
    await db.begin(async (tx) => {
      const [u] =
        await tx`UPDATE proj.daily_report SET status = 'acknowledged', acknowledged_at = now(),
          acknowledged_by = ${claims.sub}, row_version = row_version + 1
        WHERE id = ${reportId} AND status = 'submitted' RETURNING id`;
      if (!u)
        throw new ConflictException({
          code: 'not_submitted',
          message: 'Only a submitted report is acknowledged.',
        });
      await tx`INSERT INTO proj.dr_event (report_id, kind, comment, actor_id)
        VALUES (${reportId}, 'acknowledged', ${comment}, ${claims.sub})`;
      await audit(tx, claims.sub, 'daily_report.acknowledge', 'daily_report', reportId, {});
    });
    return this.get(claims, reportId);
  }

  /** Reopened to change something already submitted (or acknowledged), with why; it goes through again. */
  async correct(claims: TenantClaims, reportId: string, reason: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r0 = await this.report(db, reportId);
    await this.mustWrite(db, claims, r0.project_id);
    await db.begin(async (tx) => {
      const [u] =
        await tx`UPDATE proj.daily_report SET status = 'draft', submitted_at = NULL, submitted_by = NULL,
          acknowledged_at = NULL, acknowledged_by = NULL, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1
        WHERE id = ${reportId} AND status IN ('submitted', 'acknowledged') RETURNING id`;
      if (!u)
        throw new ConflictException({
          code: 'not_submitted',
          message: 'A draft is simply changed.',
        });
      await tx`INSERT INTO proj.dr_event (report_id, kind, comment, actor_id)
        VALUES (${reportId}, 'corrected', ${reason}, ${claims.sub})`;
      await audit(tx, claims.sub, 'daily_report.correct', 'daily_report', reportId, { reason });
    });
    return this.get(claims, reportId);
  }

  // --- photos ---

  async addPhoto(
    claims: TenantClaims,
    reportId: string,
    caption: string,
    file: { stream: Readable; truncated: () => boolean },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.report(db, reportId);
    await this.mustWrite(db, claims, r.project_id);
    if (r.status !== 'draft')
      throw new ConflictException({
        code: 'not_draft',
        message: 'Correct the report to add photos.',
      });
    const store = await this.documents.store(claims.ten);
    const tooLarge = () =>
      new BadRequestException({ code: 'too_large', message: 'A photo is at most 8 MB.' });
    const staged = await store.stage(file.stream, PHOTO_MAX).catch((e: unknown) => {
      throw e instanceof FileTooLargeError ? tooLarge() : e;
    });
    if (file.truncated()) {
      await store.discard(staged);
      throw tooLarge();
    }
    const mime = imageType(staged.head);
    if (!mime) {
      await store.discard(staged);
      throw new BadRequestException({
        code: 'not_a_photo',
        message: 'Send a JPEG, PNG or WebP picture.',
      });
    }
    const key = await store.commit(staged);
    await db.begin(async (tx) => {
      await tx`INSERT INTO proj.dr_photo (report_id, storage_key, mime, size_bytes, caption, created_by)
        VALUES (${reportId}, ${key}, ${mime}, ${staged.size}, ${caption}, ${claims.sub})`;
      await tx`UPDATE proj.daily_report SET row_version = row_version + 1, updated_at = now(),
        updated_by = ${claims.sub} WHERE id = ${reportId}`;
    });
    return this.get(claims, reportId);
  }

  async photo(claims: TenantClaims, reportId: string, photoId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.report(db, reportId);
    await this.projects.access(db, claims, r.project_id);
    const [p] = await db<{ storage_key: string; mime: string; size_bytes: number }[]>`
      SELECT storage_key, mime, size_bytes FROM proj.dr_photo
      WHERE id = ${photoId} AND report_id = ${reportId} AND removed_at IS NULL`;
    if (!p) throw new NotFoundException({ code: 'photo_not_found' });
    const store = await this.documents.store(claims.ten);
    return { stream: await store.open(p.storage_key), mime: p.mime, size: p.size_bytes };
  }

  async removePhoto(claims: TenantClaims, reportId: string, photoId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.report(db, reportId);
    await this.mustWrite(db, claims, r.project_id);
    if (r.status !== 'draft')
      throw new ConflictException({
        code: 'not_draft',
        message: 'Correct the report to remove photos.',
      });
    const [u] = await db`UPDATE proj.dr_photo SET removed_at = now()
      WHERE id = ${photoId} AND report_id = ${reportId} AND removed_at IS NULL RETURNING id`;
    if (!u) throw new NotFoundException({ code: 'photo_not_found' });
    await db`UPDATE proj.daily_report SET row_version = row_version + 1 WHERE id = ${reportId}`;
    return this.get(claims, reportId);
  }

  // --- reading ---

  async get(claims: TenantClaims, reportId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.report(db, reportId);
    const may = await this.role(db, claims, r.project_id);
    const [head] = await db`
      SELECT d.id, to_char(d.report_date, 'YYYY-MM-DD') AS "reportDate", d.status,
        d.weather_am AS "weatherAm", d.weather_pm AS "weatherPm", d.rain_hours::text AS "rainHours",
        d.safety, d.visitors, d.notes, d.row_version AS "rowVersion",
        json_build_object('id', p.id, 'number', p.number, 'name', p.name) AS project,
        json_build_object('id', s.id, 'name', s.name) AS site,
        sb.display_name AS "submittedBy", d.submitted_at AS "submittedAt",
        ab.display_name AS "acknowledgedBy", d.acknowledged_at AS "acknowledgedAt",
        ub.display_name AS "updatedBy", d.updated_at AS "updatedAt"
      FROM proj.daily_report d JOIN proj.project p ON p.id = d.project_id JOIN proj.site s ON s.id = d.site_id
      LEFT JOIN platform."user" sb ON sb.id = d.submitted_by LEFT JOIN platform."user" ab ON ab.id = d.acknowledged_by
      LEFT JOIN platform."user" ub ON ub.id = d.updated_by
      WHERE d.id = ${reportId}`;
    const [manpower, equipment, work, hindrances, photos, events, received, issued] =
      await Promise.all([
        db`SELECT m.trade, m.party_id AS "partyId", v.name AS contractor, m.headcount, m.note
        FROM proj.dr_manpower m LEFT JOIN platform.party v ON v.id = m.party_id
        WHERE m.report_id = ${reportId} ORDER BY m.position`,
        db`SELECT name, ownership, count, hours_worked::text AS "hoursWorked", hours_idle::text AS "hoursIdle",
          idle_reason AS "idleReason"
        FROM proj.dr_equipment WHERE report_id = ${reportId} ORDER BY position`,
        db`SELECT w.description, w.qty::text AS qty, w.unit, n.code AS "boqCode"
        FROM proj.dr_work w
        LEFT JOIN LATERAL (SELECT n.code FROM est.boq_node n JOIN est.boq b ON b.id = n.boq_id
          WHERE n.line_key = w.line_key AND b.project_id = ${r.project_id} AND b.kind = 'contract' LIMIT 1) n ON true
        WHERE w.report_id = ${reportId} ORDER BY w.position`,
        db`SELECT cause, description, hours::text AS hours, account
        FROM proj.dr_hindrance WHERE report_id = ${reportId} ORDER BY position`,
        db`SELECT id, caption, mime, size_bytes AS "size", created_at AS "createdAt"
        FROM proj.dr_photo WHERE report_id = ${reportId} AND removed_at IS NULL ORDER BY created_at`,
        db`SELECT e.kind, e.comment, u.display_name AS actor, e.at
        FROM proj.dr_event e LEFT JOIN platform."user" u ON u.id = e.actor_id
        WHERE e.report_id = ${reportId} ORDER BY e.id`,
        // What came that day at the site (accepted), from its receipts.
        db`SELECT g.id AS "receiptId", g.number, v.name AS vendor, l.description, l.unit,
          l.qty::text AS qty, l.accepted_qty::text AS accepted, l.rejected_qty::text AS rejected, l.inspection
        FROM proc.goods_receipt g JOIN proc.grn_line l ON l.receipt_id = g.id
        JOIN proc.purchase_order o ON o.id = g.po_id JOIN platform.party v ON v.id = o.party_id
        WHERE g.site_id = ${r.site_id} AND g.received_on = ${r.report_date} AND g.status = 'posted'
        ORDER BY g.number, l.position`,
        // What went out to work that day from the site's stores, as issued.
        db`SELECT i.id AS "issueId", i.number, w.code AS "wbsCode", x.name, x.unit, l.qty::text AS qty
        FROM proc.stock_issue i JOIN proc.store s ON s.id = i.store_id JOIN proj.wbs w ON w.id = i.wbs_id
        JOIN proc.stock_issue_line l ON l.issue_id = i.id JOIN est.resource x ON x.id = l.resource_id
        WHERE s.site_id = ${r.site_id} AND i.issued_on = ${r.report_date}
        ORDER BY i.number, l.position`,
      ]);
    // The machines' log sheets at the site that day (docs/wave3-plan.md step 10).
    const equipmentLogs = await db`
      SELECT e.code, e.name, e.ownership, l.worked::text AS worked, l.idle_hours::text AS "idleHours",
        l.idle_reason AS "idleReason", l.breakdown_hours::text AS "breakdownHours", l.operator
      FROM eqp.log l JOIN eqp.equipment e ON e.id = l.equipment_id
      WHERE l.site_id = ${r.site_id} AND l.log_date = ${r.report_date} ORDER BY e.code`;
    // The contract labour mustered at the site that day (docs/wave3-plan.md step 13).
    const muster = await LabourService.dayCounts(db, r.site_id, r.report_date);
    const draft = r.status === 'draft';
    return {
      ...head!,
      manpower,
      equipment,
      equipmentLogs,
      muster,
      work,
      hindrances,
      photos,
      events,
      received,
      issued,
      mayEdit: may.writes && draft,
      maySubmit: may.writes && draft,
      mayAcknowledge: may.acknowledges && r.status === 'submitted',
      mayCorrect: may.writes && !draft,
    };
  }

  /**
   * A project's reports newest first, and for each active site the days of the last two weeks (from the site's
   * first day on the project) with no submitted report.
   */
  async list(claims: TenantClaims, projectId: string, q: { siteId?: string | undefined }) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const reports = await db`
      SELECT d.id, to_char(d.report_date, 'YYYY-MM-DD') AS "reportDate", d.status,
        json_build_object('id', s.id, 'name', s.name) AS site,
        coalesce((SELECT sum(headcount) FROM proj.dr_manpower m WHERE m.report_id = d.id), 0)::int AS headcount,
        coalesce((SELECT sum(hours) FROM proj.dr_hindrance h WHERE h.report_id = d.id), 0)::text AS "hindranceHours",
        (SELECT count(*)::int FROM proj.dr_photo f WHERE f.report_id = d.id AND f.removed_at IS NULL) AS photos
      FROM proj.daily_report d JOIN proj.site s ON s.id = d.site_id
      WHERE d.project_id = ${projectId} ${q.siteId ? db`AND d.site_id = ${q.siteId}` : db``}
      ORDER BY d.report_date DESC, s.name LIMIT 200`;
    const today = indiaToday();
    const from = addDays(today, -(MISSING_DAYS - 1));
    const sites = await db<{ id: string; name: string; since: string }[]>`
      SELECT s.id, s.name, greatest(to_char(s.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD'),
          coalesce(to_char(p.start_on, 'YYYY-MM-DD'), '0000-01-01'), ${from}) AS since
      FROM proj.site s JOIN proj.project p ON p.id = s.project_id
      WHERE s.project_id = ${projectId} AND s.active ORDER BY s.name`;
    const done = await db<{ site_id: string; d: string }[]>`
      SELECT site_id, to_char(report_date, 'YYYY-MM-DD') AS d FROM proj.daily_report
      WHERE project_id = ${projectId} AND report_date >= ${from} AND status <> 'draft'`;
    const have = new Set(done.map((x) => `${x.site_id} ${x.d}`));
    const missing = sites
      .map((s) => {
        const days: string[] = [];
        for (let d = s.since; d <= today; d = addDays(d, 1))
          if (!have.has(`${s.id} ${d}`)) days.push(d);
        return { site: { id: s.id, name: s.name }, days };
      })
      .filter((m) => m.days.length);
    return { reports, missing, mayWrite: (await this.role(db, claims, projectId)).writes };
  }

  /**
   * By week (Monday first): man-days by trade, equipment hours worked and idle, and hindrance hours by cause and by
   * whose account. Submitted and acknowledged reports only.
   */
  async summary(claims: TenantClaims, projectId: string, q: { from: string; to: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const scope = db`d.project_id = ${projectId} AND d.status <> 'draft'
      AND d.report_date BETWEEN ${q.from} AND ${q.to}`;
    const [manpower, equipment, hindrances] = await Promise.all([
      db`SELECT to_char(date_trunc('week', d.report_date), 'YYYY-MM-DD') AS week, m.trade,
          sum(m.headcount)::int AS "manDays"
        FROM proj.daily_report d JOIN proj.dr_manpower m ON m.report_id = d.id WHERE ${scope}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      db`SELECT to_char(date_trunc('week', d.report_date), 'YYYY-MM-DD') AS week, e.name,
          sum(e.hours_worked)::text AS worked, sum(e.hours_idle)::text AS idle
        FROM proj.daily_report d JOIN proj.dr_equipment e ON e.report_id = d.id WHERE ${scope}
        GROUP BY 1, 2 ORDER BY 1, 2`,
      db`SELECT h.cause, h.account, sum(h.hours)::text AS hours, count(DISTINCT d.report_date)::int AS days
        FROM proj.daily_report d JOIN proj.dr_hindrance h ON h.report_id = d.id WHERE ${scope}
        GROUP BY 1, 2 ORDER BY sum(h.hours) DESC, 1, 2`,
    ]);
    return { from: q.from, to: q.to, manpower, equipment, hindrances };
  }
}
