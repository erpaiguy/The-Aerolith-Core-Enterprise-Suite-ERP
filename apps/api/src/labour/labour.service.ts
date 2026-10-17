// Labour contractors (docs/wave3-plan.md step 13): contractors' licences, their workers, minimum wages with effective
// dates, the daily muster by site, monthly wage sheets checked against the minimum wage and verified as paid, the
// registers an inspector asks for, and BOCW cess by project.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { Sql, TransactionSql } from 'postgres';
import { complianceReasons } from './labour-rules.js';
import { DEFAULT_RADIUS_M, distanceM } from '../hr/hr-rules.js';
import { fromDb } from '../accounts/accounts-rules.js';
import { LedgerService, type LineInput } from '../accounts/ledger.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { licenceState, wageLine, type WageLine } from './labour-rules.js';

type Db = Sql | TransactionSql;
/** BOCW cess on the cost of construction. [Likely] 1% under the Building and Other Construction Workers' Welfare Cess Act. */
const CESS_PCT = 1;
const indiaDay = (now = new Date()) =>
  new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const lastDay = (month: string) => {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export interface WorkerInput {
  name: string;
  relative: string;
  gender: 'female' | 'male' | 'other' | null;
  birthDate: string | null;
  trade: string;
  skill: 'unskilled' | 'semi_skilled' | 'skilled' | 'highly_skilled';
  dailyWage: string;
  aadhaarLast4: string | null;
  aadhaarConsentOn: string | null;
  uan: string | null;
  esiNumber: string | null;
  joinedOn: string;
}

/** A photo sent as a data URL ("data:image/jpeg;base64,…"): its bytes and type, or a refusal. */
export function decodePhoto(dataUrl: string) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m)
    throw new BadRequestException({
      code: 'bad_photo',
      message: 'The photo is not a JPEG, PNG or WebP image.',
    });
  const bytes = Buffer.from(m[2]!, 'base64');
  if (bytes.length > 600_000)
    throw new BadRequestException({
      code: 'photo_too_large',
      message: 'The photo is over 600 KB.',
    });
  return { bytes, type: m[1]! };
}

@Injectable()
export class LabourService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly ledger: LedgerService,
  ) {}

  private async must(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'labour.manage')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'labour.manage',
        message: 'Contract labour needs the labour permission.',
      });
  }

  /** The site's team (with `attendance.mark`) keeps its musters; so does whoever manages labour. */
  private async mayMuster(db: Db, claims: TenantClaims, projectId: string) {
    if (await this.permissions.can(claims, 'labour.manage')) return;
    const a = await this.projects.access(db, claims, projectId);
    if (
      (a.role !== 'lead' && a.role !== 'member' && !a.canEdit) ||
      !(await this.permissions.can(claims, 'attendance.mark'))
    )
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team marks its sites' musters.",
      });
  }

  private async site(db: Db, siteId: string) {
    const [s] = await db<
      {
        id: string;
        name: string;
        project_id: string;
        state_code: string | null;
        project: string;
        latitude: string | null;
        longitude: string | null;
        radius_m: number | null;
      }[]
    >`
      SELECT s.id, s.name, s.project_id, s.state_code, p.name AS project, s.latitude::text, s.longitude::text,
        s.radius_m FROM proj.site s
      JOIN proj.project p ON p.id = s.project_id WHERE s.id = ${siteId}`;
    if (!s) throw new NotFoundException({ code: 'site_not_found' });
    return s;
  }

  // --- contractors and workers ---

  async contractors(claims: TenantClaims) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<
      {
        partyId: string;
        name: string;
        licenceNo: string;
        licenceWorkers: number | null;
        licenceValidTo: string | null;
        bocwRegistration: string;
        workers: number;
      }[]
    >`
      SELECT c.party_id AS "partyId", p.name, c.licence_no AS "licenceNo", c.licence_workers AS "licenceWorkers",
        to_char(c.licence_valid_to, 'YYYY-MM-DD') AS "licenceValidTo", c.bocw_registration AS "bocwRegistration",
        (SELECT count(*)::int FROM lab.worker w WHERE w.party_id = c.party_id AND w.left_on IS NULL) AS workers
      FROM lab.contractor c JOIN platform.party p ON p.id = c.party_id ORDER BY lower(p.name)`;
    const today = indiaDay();
    return rows.map((r) => ({
      ...r,
      licence: licenceState(r.licenceValidTo, today),
      overLicence: r.licenceWorkers !== null && r.workers > r.licenceWorkers,
    }));
  }

  async saveContractor(
    claims: TenantClaims,
    partyId: string,
    input: {
      licenceNo: string;
      licenceWorkers: number | null;
      licenceValidTo: string | null;
      bocwRegistration: string;
    },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<
      { is_vendor: boolean }[]
    >`SELECT is_vendor FROM platform.party WHERE id = ${partyId}`;
    if (!p?.is_vendor)
      throw new BadRequestException({
        code: 'not_a_vendor',
        message: 'A labour contractor is a supplier.',
      });
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO lab.contractor (party_id, licence_no, licence_workers, licence_valid_to, bocw_registration, created_by)
        VALUES (${partyId}, ${input.licenceNo}, ${input.licenceWorkers}, ${input.licenceValidTo},
          ${input.bocwRegistration}, ${claims.sub})
        ON CONFLICT (party_id) DO UPDATE SET licence_no = EXCLUDED.licence_no,
          licence_workers = EXCLUDED.licence_workers, licence_valid_to = EXCLUDED.licence_valid_to,
          bocw_registration = EXCLUDED.bocw_registration, row_version = lab.contractor.row_version + 1`;
      await audit(tx, claims.sub, 'labour.contractor', 'party', partyId, { ...input });
    });
    return this.contractors(claims);
  }

  async workers(claims: TenantClaims, partyId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT id, name, relative, gender, to_char(birth_date, 'YYYY-MM-DD') AS "birthDate", trade, skill,
        daily_wage::text AS "dailyWage", aadhaar_last4 AS "aadhaarLast4", uan, esi_number AS "esiNumber",
        to_char(joined_on, 'YYYY-MM-DD') AS "joinedOn", to_char(left_on, 'YYYY-MM-DD') AS "leftOn",
        row_version AS "rowVersion"
      FROM lab.worker WHERE party_id = ${partyId} ORDER BY left_on IS NOT NULL, lower(name)`;
  }

  async addWorker(claims: TenantClaims, partyId: string, input: WorkerInput) {
    await this.must(claims);
    if (input.aadhaarLast4 && !input.aadhaarConsentOn)
      throw new BadRequestException({
        code: 'aadhaar_consent',
        message: "Aadhaar's last four digits are kept only with the date the worker consented.",
      });
    const db = await this.tenants.forTenant(claims.ten);
    const [c] = await db`SELECT 1 FROM lab.contractor WHERE party_id = ${partyId}`;
    if (!c) throw new NotFoundException({ code: 'contractor_not_found' });
    await db.begin(async (tx) => {
      const [w] = await tx<{ id: string }[]>`
        INSERT INTO lab.worker (party_id, name, relative, gender, birth_date, trade, skill, daily_wage, aadhaar_last4,
          aadhaar_consent_on, uan, esi_number, joined_on, created_by)
        VALUES (${partyId}, ${input.name}, ${input.relative}, ${input.gender}, ${input.birthDate}, ${input.trade},
          ${input.skill}, ${input.dailyWage}, ${input.aadhaarLast4}, ${input.aadhaarConsentOn}, ${input.uan},
          ${input.esiNumber}, ${input.joinedOn}, ${claims.sub})
        RETURNING id`;
      await audit(tx, claims.sub, 'labour.worker', 'worker', w!.id, { name: input.name });
    });
    return this.workers(claims, partyId);
  }

  /** A worker's rate, trade or skill changed, or their leaving. */
  async updateWorker(
    claims: TenantClaims,
    workerId: string,
    input: {
      dailyWage?: string | undefined;
      trade?: string | undefined;
      skill?: string | undefined;
      leftOn?: string | null | undefined;
      rowVersion: number;
    },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const partyId = await db
      .begin(async (tx) => {
        const [w] = await tx<{ party_id: string; row_version: number }[]>`
        SELECT party_id, row_version FROM lab.worker WHERE id = ${workerId} FOR UPDATE`;
        if (!w) throw new NotFoundException({ code: 'worker_not_found' });
        if (w.row_version !== input.rowVersion)
          throw new ConflictException({
            code: 'stale',
            message: 'Someone else changed this worker. Reload.',
          });
        const row: Record<string, unknown> = {};
        if (input.dailyWage !== undefined) row.daily_wage = input.dailyWage;
        if (input.trade !== undefined) row.trade = input.trade;
        if (input.skill !== undefined) row.skill = input.skill;
        if (input.leftOn !== undefined) row.left_on = input.leftOn;
        if (Object.keys(row).length)
          await tx`UPDATE lab.worker SET ${tx(row)}, row_version = row_version + 1 WHERE id = ${workerId}`;
        await audit(tx, claims.sub, 'labour.worker_update', 'worker', workerId, {
          fields: Object.keys(row),
        });
        return w.party_id;
      })
      .catch(fromDb);
    return this.workers(claims, partyId);
  }

  // --- minimum wages ---

  async minWages(claims: TenantClaims) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT id, state_code AS "stateCode", skill, zone, to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
        daily::text, note
      FROM lab.min_wage ORDER BY state_code, skill, zone, effective_from DESC`;
  }

  async addMinWage(
    claims: TenantClaims,
    input: {
      stateCode: string;
      skill: string;
      zone: string;
      effectiveFrom: string;
      daily: string;
      note: string;
    },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        await tx`INSERT INTO lab.min_wage (state_code, skill, zone, effective_from, daily, note, created_by)
          VALUES (${input.stateCode}, ${input.skill}, ${input.zone}, ${input.effectiveFrom}, ${input.daily},
            ${input.note}, ${claims.sub})`;
        await audit(tx, claims.sub, 'labour.min_wage', 'state', input.stateCode, { ...input });
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'min_wage_exists',
            message: 'That rate from that date is already in.',
          });
        throw err;
      });
    return this.minWages(claims);
  }

  /** The minimum daily wage for a skill in a state on a date: the highest of the zones in force (the safe reading). */
  private async minimum(db: Db, state: string | null, skill: string, on: string) {
    if (!state) return null;
    const [m] = await db<{ daily: string | null }[]>`
      SELECT max(daily)::text AS daily FROM lab.min_wage m
      WHERE m.state_code = ${state} AND m.skill = ${skill} AND m.effective_from = (
        SELECT max(x.effective_from) FROM lab.min_wage x WHERE x.state_code = m.state_code AND x.skill = m.skill
          AND x.zone = m.zone AND x.effective_from <= ${on})`;
    return m?.daily ? Number(m.daily) : null;
  }

  // --- the muster ---

  async muster(claims: TenantClaims, siteId: string, day: string, partyId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.site(db, siteId);
    await this.mayMuster(db, claims, s.project_id);
    const rows = await db`
      SELECT w.id AS "workerId", w.name, w.trade, w.skill, m.status, m.overtime_hours::text AS "overtimeHours",
        (SELECT x.site_id FROM lab.muster x WHERE x.worker_id = w.id AND x.day = ${day} AND x.site_id <> ${siteId})
          IS NOT NULL AS elsewhere
      FROM lab.worker w LEFT JOIN lab.muster m ON m.worker_id = w.id AND m.day = ${day} AND m.site_id = ${siteId}
      WHERE w.party_id = ${partyId} AND w.joined_on <= ${day} AND (w.left_on IS NULL OR w.left_on >= ${day})
      ORDER BY lower(w.name)`;
    const proofs = await db`
      SELECT id, to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS at, latitude::text, longitude::text,
        distance_m AS "distanceM", flag, photo IS NOT NULL AS "hasPhoto", workers
      FROM lab.muster_proof WHERE site_id = ${siteId} AND day = ${day} AND party_id = ${partyId} ORDER BY created_at`;
    return { site: { id: s.id, name: s.name, project: s.project }, day, partyId, rows, proofs };
  }

  /** A muster's photo, for those who may see the site's muster. */
  async proofPhoto(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<{ site_id: string; photo: Buffer | null; photo_type: string | null }[]>`
      SELECT site_id, photo, photo_type FROM lab.muster_proof WHERE id = ${id}`;
    if (!p?.photo) throw new NotFoundException({ code: 'no_photo' });
    const s = await this.site(db, p.site_id);
    await this.mayMuster(db, claims, s.project_id);
    return { bytes: p.photo, type: p.photo_type! };
  }

  async mark(
    claims: TenantClaims,
    siteId: string,
    input: {
      date: string;
      partyId: string;
      marks: {
        workerId: string;
        status: 'present' | 'half_day' | 'absent' | null;
        overtimeHours: string;
      }[];
      /** From a phone: where it was and a photo of the gang (docs/wave8-plan.md step 8c.2). */
      proof?:
        | {
            latitude: number | null;
            longitude: number | null;
            photo: string | null;
          }
        | undefined;
    },
  ) {
    if (input.date > indiaDay())
      throw new BadRequestException({
        code: 'future_day',
        message: 'A muster is kept on the day or after.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.site(db, siteId);
    await this.mayMuster(db, claims, s.project_id);
    await db
      .begin(async (tx) => {
        const [closed] = await tx`
          SELECT 1 FROM lab.wage_sheet WHERE party_id = ${input.partyId} AND site_id = ${siteId}
            AND month = date_trunc('month', ${input.date}::date) AND status <> 'draft'`;
        if (closed)
          throw new ConflictException({
            code: 'month_passed',
            message: "The month's wage sheet is already passed.",
          });
        for (const m of input.marks) {
          const [w] = await tx`
            SELECT 1 FROM lab.worker WHERE id = ${m.workerId} AND party_id = ${input.partyId}
              AND joined_on <= ${input.date} AND (left_on IS NULL OR left_on >= ${input.date})`;
          if (!w)
            throw new BadRequestException({
              code: 'not_a_worker',
              message: "Someone marked is not this contractor's worker that day.",
            });
          if (m.status === null) {
            await tx`DELETE FROM lab.muster WHERE site_id = ${siteId} AND day = ${input.date} AND worker_id = ${m.workerId}`;
            continue;
          }
          await tx`
            INSERT INTO lab.muster (site_id, day, worker_id, status, overtime_hours, updated_by)
            VALUES (${siteId}, ${input.date}, ${m.workerId}, ${m.status}, ${m.status === 'absent' ? 0 : m.overtimeHours},
              ${claims.sub})
            ON CONFLICT (site_id, day, worker_id) DO UPDATE SET status = EXCLUDED.status,
              overtime_hours = EXCLUDED.overtime_hours, updated_at = now(), updated_by = EXCLUDED.updated_by`;
        }
        if (input.proof) {
          const p = input.proof;
          const distance =
            p.latitude !== null && p.longitude !== null && s.latitude && s.longitude
              ? distanceM(Number(s.latitude), Number(s.longitude), p.latitude, p.longitude)
              : null;
          const flag =
            p.latitude === null
              ? 'no_location'
              : distance === null
                ? 'no_site_location'
                : distance > (s.radius_m ?? DEFAULT_RADIUS_M)
                  ? 'outside_site'
                  : null;
          const photo = p.photo ? decodePhoto(p.photo) : null;
          await tx`
            INSERT INTO lab.muster_proof (site_id, day, party_id, latitude, longitude, distance_m, flag, photo, photo_type,
              workers, created_by)
            VALUES (${siteId}, ${input.date}, ${input.partyId}, ${p.latitude}, ${p.longitude}, ${distance}, ${flag},
              ${photo?.bytes ?? null}, ${photo?.type ?? null},
              ${input.marks.filter((m) => m.status === 'present' || m.status === 'half_day').length}, ${claims.sub})`;
        }
        await audit(tx, claims.sub, 'labour.muster', 'site', siteId, {
          date: input.date,
          count: input.marks.length,
        });
      })
      .catch((err: unknown) => {
        if (
          (err as { code?: string; constraint_name?: string }).constraint_name ===
          'muster_worker_day'
        )
          throw new ConflictException({
            code: 'elsewhere',
            message: 'A worker is already on another site that day.',
          });
        throw err;
      });
    return this.muster(claims, siteId, input.date, input.partyId);
  }

  /** The day's muster at a site by contractor and trade (the daily site report shows it). */
  static async dayCounts(db: Db, siteId: string, day: string) {
    return db`
      SELECT p.name AS contractor, w.trade, count(*) FILTER (WHERE m.status = 'present')::int AS present,
        count(*) FILTER (WHERE m.status = 'half_day')::int AS "halfDays",
        coalesce(sum(m.overtime_hours), 0)::text AS "overtimeHours"
      FROM lab.muster m JOIN lab.worker w ON w.id = m.worker_id JOIN platform.party p ON p.id = w.party_id
      WHERE m.site_id = ${siteId} AND m.day = ${day} AND m.status <> 'absent'
      GROUP BY p.name, w.trade ORDER BY p.name, w.trade`;
  }

  // --- wage sheets ---

  async createSheet(
    claims: TenantClaims,
    input: { partyId: string; siteId: string; month: string },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await this.site(db, input.siteId);
    const id = await db
      .begin(async (tx) => {
        const [x] = await tx<{ id: string }[]>`
          INSERT INTO lab.wage_sheet (party_id, site_id, month, created_by)
          VALUES (${input.partyId}, ${input.siteId}, ${`${input.month}-01`}, ${claims.sub}) RETURNING id`;
        return x!.id;
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'sheet_exists',
            message: 'That month already has a wage sheet.',
          });
        if ((err as { code?: string }).code === '23503')
          throw new NotFoundException({ code: 'contractor_not_found' });
        throw err;
      });
    return this.workSheet(claims, id);
  }

  async workSheet(claims: TenantClaims, id: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [x] = await tx<{ party_id: string; site_id: string; month: string; status: string }[]>`
        SELECT party_id, site_id, to_char(month, 'YYYY-MM') AS month, status FROM lab.wage_sheet
        WHERE id = ${id} FOR UPDATE`;
      if (!x) throw new NotFoundException({ code: 'sheet_not_found' });
      if (x.status !== 'draft')
        throw new ConflictException({
          code: 'not_draft',
          message: 'The wage sheet is already passed.',
        });
      const s = await this.site(tx, x.site_id);
      const end = lastDay(x.month);
      const rows = await tx<
        {
          id: string;
          name: string;
          skill: string;
          daily_wage: string;
          present: number;
          half: number;
          ot: string;
        }[]
      >`
        SELECT w.id, w.name, w.skill, w.daily_wage::text,
          count(*) FILTER (WHERE m.status = 'present')::int AS present,
          count(*) FILTER (WHERE m.status = 'half_day')::int AS half,
          coalesce(sum(m.overtime_hours), 0)::text AS ot
        FROM lab.muster m JOIN lab.worker w ON w.id = m.worker_id
        WHERE m.site_id = ${x.site_id} AND w.party_id = ${x.party_id}
          AND m.day BETWEEN ${`${x.month}-01`} AND ${end} AND m.status <> 'absent'
        GROUP BY w.id ORDER BY lower(w.name)`;
      const lines: WageLine[] = [];
      for (const r of rows)
        lines.push(
          wageLine({
            workerId: r.id,
            name: r.name,
            skill: r.skill,
            rate: Number(r.daily_wage),
            present: r.present,
            halfDays: r.half,
            overtimeHours: Number(r.ot),
            minimum: await this.minimum(tx, s.state_code, r.skill, end),
          }),
        );
      const total = lines.reduce((t, l) => t + l.gross, 0);
      const shortfall = lines.reduce((t, l) => t + l.shortfall, 0);
      const pf = lines.reduce((t, l) => t + l.pfEmployee + l.pfEmployer, 0);
      const esi = lines.reduce((t, l) => t + l.esiEmployee + l.esiEmployer, 0);
      await tx`UPDATE lab.wage_sheet SET lines = ${tx.json(JSON.parse(JSON.stringify(lines)))}, total = ${total.toFixed(2)},
        shortfall = ${shortfall.toFixed(2)}, pf_due = ${pf.toFixed(2)}, esi_due = ${esi.toFixed(2)}, worked_at = now(),
        row_version = row_version + 1 WHERE id = ${id}`;
    });
    return this.sheet(claims, id);
  }

  async sheet(claims: TenantClaims, id: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [x] = await db`
      SELECT w.id, w.party_id AS "partyId", p.name AS contractor, w.site_id AS "siteId", s.name AS site,
        pr.name AS project, to_char(w.month, 'YYYY-MM') AS month, w.status, w.lines, w.total::text,
        w.shortfall::text, w.pf_due::text AS "pfDue", w.esi_due::text AS "esiDue",
        to_char(w.paid_on, 'YYYY-MM-DD') AS "paidOn", w.paid_reference AS "paidReference",
        w.paid_mode AS "paidMode"
      FROM lab.wage_sheet w JOIN platform.party p ON p.id = w.party_id JOIN proj.site s ON s.id = w.site_id
      JOIN proj.project pr ON pr.id = s.project_id WHERE w.id = ${id}`;
    if (!x) throw new NotFoundException({ code: 'sheet_not_found' });
    return x;
  }

  async sheets(claims: TenantClaims, partyId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT w.id, to_char(w.month, 'YYYY-MM') AS month, s.name AS site, pr.name AS project, w.status, w.total::text,
        w.shortfall::text
      FROM lab.wage_sheet w JOIN proj.site s ON s.id = w.site_id JOIN proj.project pr ON pr.id = s.project_id
      WHERE w.party_id = ${partyId} ORDER BY w.month DESC, s.name`;
  }

  /** Passed: no one below the minimum wage. */
  async pass(claims: TenantClaims, id: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [x] = await tx<{ status: string; shortfall: string; worked_at: Date | null }[]>`
        SELECT status, shortfall::text, worked_at FROM lab.wage_sheet WHERE id = ${id} FOR UPDATE`;
      if (!x) throw new NotFoundException({ code: 'sheet_not_found' });
      if (x.status !== 'draft')
        throw new ConflictException({ code: 'not_draft', message: 'Already passed.' });
      if (Number(x.shortfall) > 0)
        throw new ConflictException({
          code: 'below_minimum',
          message: `Workers are paid ₹${x.shortfall} below the minimum wage. The contractor must make it up first.`,
        });
      await tx`UPDATE lab.wage_sheet SET status = 'passed', row_version = row_version + 1 WHERE id = ${id}`;
      await audit(tx, claims.sub, 'labour.sheet_pass', 'wage_sheet', id, {});
    });
    return this.sheet(claims, id);
  }

  /** The contractor showed they paid: when, how and the reference. */
  async verify(
    claims: TenantClaims,
    id: string,
    input: { paidOn: string; reference: string; mode: string },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [x] = await tx<
        { status: string }[]
      >`SELECT status FROM lab.wage_sheet WHERE id = ${id} FOR UPDATE`;
      if (!x) throw new NotFoundException({ code: 'sheet_not_found' });
      if (x.status !== 'passed')
        throw new ConflictException({ code: 'not_passed', message: 'Pass the wage sheet first.' });
      await tx`UPDATE lab.wage_sheet SET status = 'verified', paid_on = ${input.paidOn},
        paid_reference = ${input.reference}, paid_mode = ${input.mode}, row_version = row_version + 1 WHERE id = ${id}`;
      await audit(tx, claims.sub, 'labour.sheet_verify', 'wage_sheet', id, { ...input });
    });
    return this.sheet(claims, id);
  }

  /** The contractor's months not yet verified as paid (a subcontract bill warns of them). */
  static async unverified(db: Db, partyId: string, upto: string) {
    return db<{ month: string; site: string; status: string }[]>`
      SELECT to_char(w.month, 'YYYY-MM') AS month, s.name AS site, w.status FROM lab.wage_sheet w
      JOIN proj.site s ON s.id = w.site_id
      WHERE w.party_id = ${partyId} AND w.month <= ${upto} AND w.status <> 'verified' ORDER BY w.month`;
  }

  // --- compliance as principal employer (docs/wave8-plan.md step 8c.1) ---

  /** Each month's PF and ESI due on the contractor's passed wage sheets to the date, and what their challans show. */
  static async dues(db: Db, partyId: string, upto: string) {
    return db<{ month: string; kind: 'pf' | 'esi'; due: string; paid: string }[]>`
      WITH due AS (
        SELECT month, 'pf' AS kind, sum(pf_due) AS due FROM lab.wage_sheet
        WHERE party_id = ${partyId} AND status <> 'draft' AND month <= ${upto} GROUP BY month
        UNION ALL
        SELECT month, 'esi', sum(esi_due) FROM lab.wage_sheet
        WHERE party_id = ${partyId} AND status <> 'draft' AND month <= ${upto} GROUP BY month)
      SELECT to_char(d.month, 'YYYY-MM') AS month, d.kind, d.due::text AS due,
        coalesce((SELECT sum(c.amount) FROM lab.contractor_challan c WHERE c.party_id = ${partyId}
          AND c.month = d.month AND c.kind = d.kind), 0)::numeric(20,2)::text AS paid
      FROM due d WHERE d.due > 0 ORDER BY d.month, d.kind`;
  }

  /** What holds a labour contractor's bill on a date; none for a party who is not one. */
  static async complianceReasons(db: Db, partyId: string, on: string) {
    const [c] = await db<{ valid_to: string | null }[]>`
      SELECT to_char(licence_valid_to, 'YYYY-MM-DD') AS valid_to FROM lab.contractor WHERE party_id = ${partyId}`;
    if (!c) return [];
    const below = await db<{ month: string; site: string; shortfall: string }[]>`
      SELECT to_char(w.month, 'YYYY-MM') AS month, s.name AS site, w.shortfall::text AS shortfall
      FROM lab.wage_sheet w JOIN proj.site s ON s.id = w.site_id
      WHERE w.party_id = ${partyId} AND w.month <= ${on} AND w.shortfall > 0 ORDER BY w.month`;
    // A month's contributions are due by the 15th of the next; only months before the bill's are counted.
    const before = `${on.slice(0, 7)}-01`;
    const unpaid = (await LabourService.dues(db, partyId, before)).filter(
      (d) => d.month < on.slice(0, 7) && Number(d.paid) + 0.5 < Number(d.due),
    );
    return complianceReasons({ licenceValidTo: c.valid_to, on, belowMinimum: below, unpaid });
  }

  async compliance(claims: TenantClaims, partyId: string, on: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return {
      partyId,
      on,
      dues: await LabourService.dues(db, partyId, on),
      challans: await db`
        SELECT id, to_char(month, 'YYYY-MM') AS month, kind, reference, amount::text,
          to_char(paid_on, 'YYYY-MM-DD') AS "paidOn"
        FROM lab.contractor_challan WHERE party_id = ${partyId} ORDER BY month DESC, kind`,
      holds: await LabourService.complianceReasons(db, partyId, on),
    };
  }

  /** A contractor's PF or ESI challan for a month, as they showed it. */
  async addChallan(
    claims: TenantClaims,
    partyId: string,
    input: { month: string; kind: 'pf' | 'esi'; reference: string; amount: string; paidOn: string },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db`
      INSERT INTO lab.contractor_challan (party_id, month, kind, reference, amount, paid_on, created_by)
      VALUES (${partyId}, ${`${input.month}-01`}, ${input.kind}, ${input.reference}, ${input.amount}, ${input.paidOn},
        ${claims.sub})`.catch((err: unknown) => {
      const code = (err as { code?: string }).code;
      if (code === '23505')
        throw new ConflictException({
          code: 'challan_exists',
          message: 'This challan is already entered.',
        });
      if (code === '23503')
        throw new NotFoundException({
          code: 'not_a_contractor',
          message: 'Not a labour contractor.',
        });
      throw err;
    });
    return this.compliance(claims, partyId, input.paidOn);
  }

  // --- registers ---

  /** The register of workmen, the muster roll and the register of wages for a site's month (one workbook). */
  async registers(claims: TenantClaims, id: string) {
    const x = (await this.sheet(claims, id)) as unknown as {
      partyId: string;
      siteId: string;
      contractor: string;
      site: string;
      month: string;
      lines: WageLine[];
      paidOn: string | null;
    };
    const db = await this.tenants.forTenant(claims.ten);
    const end = lastDay(x.month);
    const workers = await db<
      {
        id: string;
        name: string;
        relative: string;
        gender: string | null;
        birth_date: string | null;
        trade: string;
        joined_on: string;
        left_on: string | null;
      }[]
    >`
      SELECT id, name, relative, gender, to_char(birth_date, 'YYYY-MM-DD') AS birth_date, trade,
        to_char(joined_on, 'YYYY-MM-DD') AS joined_on, to_char(left_on, 'YYYY-MM-DD') AS left_on
      FROM lab.worker WHERE party_id = ${x.partyId} AND joined_on <= ${end}
        AND (left_on IS NULL OR left_on >= ${`${x.month}-01`}) ORDER BY lower(name)`;
    const marks = await db<{ worker_id: string; d: number; status: string }[]>`
      SELECT worker_id, extract(day FROM day)::int AS d, status FROM lab.muster
      WHERE site_id = ${x.siteId} AND day BETWEEN ${`${x.month}-01`} AND ${end}`;
    const wb = new ExcelJS.Workbook();
    const title = `${x.contractor}, ${x.site}, ${x.month}`;
    const reg = wb.addWorksheet('Register of workmen');
    reg.addRow([`Register of workmen employed by the contractor: ${title}`]);
    reg.addRow([
      'S. No.',
      'Name',
      "Father's/husband's name",
      'Sex',
      'Date of birth',
      'Nature of employment',
      'Date of commencement',
      'Date of termination',
    ]);
    workers.forEach((w, i) =>
      reg.addRow([
        i + 1,
        w.name,
        w.relative,
        w.gender ?? '',
        w.birth_date ?? '',
        w.trade,
        w.joined_on,
        w.left_on ?? '',
      ]),
    );
    const days = Number(end.slice(8, 10));
    const roll = wb.addWorksheet('Muster roll');
    roll.addRow([`Muster roll: ${title}`]);
    roll.addRow([
      'S. No.',
      'Name',
      'Sex',
      ...Array.from({ length: days }, (_, i) => i + 1),
      'Days',
    ]);
    workers.forEach((w, i) => {
      const mine = marks.filter((m) => m.worker_id === w.id);
      const cell = (d: number) => {
        const m = mine.find((x) => x.d === d);
        return m ? (m.status === 'present' ? 'P' : m.status === 'half_day' ? 'H' : 'A') : '';
      };
      const total = mine.reduce(
        (s, m) => s + (m.status === 'present' ? 1 : m.status === 'half_day' ? 0.5 : 0),
        0,
      );
      roll.addRow([
        i + 1,
        w.name,
        w.gender ?? '',
        ...Array.from({ length: days }, (_, d) => cell(d + 1)),
        total,
      ]);
    });
    const wages = wb.addWorksheet('Register of wages');
    wages.addRow([`Register of wages: ${title}`]);
    wages.addRow([
      'S. No.',
      'Name',
      'Skill',
      'Days worked',
      'Daily rate',
      'Basic wages',
      'Overtime hours',
      'Overtime',
      'Total',
      'Minimum daily wage',
      'Date of payment',
    ]);
    x.lines.forEach((l, i) =>
      wages.addRow([
        i + 1,
        l.name,
        l.skill,
        l.days,
        l.rate,
        l.wages,
        l.overtimeHours,
        l.overtime,
        l.gross,
        l.minimum ?? '',
        x.paidOn ?? '',
      ]),
    );
    return {
      fileName: `labour-registers-${x.month}.xlsx`,
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
      workers: workers.length,
    };
  }

  // --- BOCW cess ---

  /** A project's cess: 1% of the cost of construction booked so far, deducted from subcontractors, paid, still due. */
  async cess(claims: TenantClaims, projectId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [p] = await db<{ name: string }[]>`SELECT name FROM proj.project WHERE id = ${projectId}`;
    if (!p) throw new NotFoundException({ code: 'project_not_found' });
    const [cost] = await db<{ cost: string }[]>`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text AS cost FROM acc.voucher_line l
      JOIN acc.account a ON a.id = l.account_id
      WHERE l.project_id = ${projectId} AND a.nature = 'expense'`;
    const [deducted] = await db<{ v: string }[]>`
      SELECT coalesce(sum((b.figures->>'cess')::numeric), 0)::text AS v FROM acc.subcontract_bill b
      JOIN proc.purchase_order o ON o.id = b.order_id
      WHERE o.project_id = ${projectId} AND b.status = 'certified'`;
    const payments = await db`
      SELECT c.id, to_char(c.paid_on, 'YYYY-MM-DD') AS "paidOn", c.amount::text, c.reference, v.number AS voucher
      FROM lab.cess_payment c JOIN acc.voucher v ON v.id = c.voucher_id
      WHERE c.project_id = ${projectId} ORDER BY c.paid_on`;
    const due = Math.round((Number(cost!.cost) * CESS_PCT) / 100);
    const paid = payments.reduce((s, x) => s + Number(x.amount), 0);
    return {
      project: p.name,
      rate: String(CESS_PCT),
      cost: Number(cost!.cost).toFixed(2),
      due: due.toFixed(2),
      deductedFromSubcontractors: Number(deducted!.v).toFixed(2),
      paid: paid.toFixed(2),
      balance: (due - paid).toFixed(2),
      payments,
    };
  }

  /** A challan paid to the welfare board: labour cess payable Dr, the bank Cr. */
  async payCess(
    claims: TenantClaims,
    projectId: string,
    input: { paidOn: string; amount: string; reference: string; bankAccountId: string },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [p] = await tx<
          { entity_id: string }[]
        >`SELECT entity_id FROM proj.project WHERE id = ${projectId}`;
        if (!p) throw new NotFoundException({ code: 'project_not_found' });
        const [bank] = await tx<
          { kind: string }[]
        >`SELECT kind FROM acc.account WHERE id = ${input.bankAccountId}`;
        if (bank?.kind !== 'bank')
          throw new BadRequestException({
            code: 'not_bank',
            message: 'Cess is paid from a bank ledger.',
          });
        const line = (accountId: string, debit: string, credit: string): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId,
          siteId: null,
          costCodeId: null,
          note: `BOCW cess ${input.reference}`,
        });
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: p.entity_id,
            type: 'payment',
            date: input.paidOn,
            narration: `BOCW cess paid, ${input.reference}`,
            reference: input.reference,
            lines: [
              line(
                await this.ledger.roleAccount(tx, p.entity_id, 'labour_cess_payable'),
                input.amount,
                '0',
              ),
              line(input.bankAccountId, '0', input.amount),
            ],
          },
          { kind: 'bocw_cess', id: projectId },
        );
        await tx`INSERT INTO lab.cess_payment (project_id, paid_on, amount, reference, voucher_id, created_by)
          VALUES (${projectId}, ${input.paidOn}, ${input.amount}, ${input.reference}, ${v!.id}, ${claims.sub})`;
        await audit(tx, claims.sub, 'labour.cess', 'project', projectId, { ...input });
      })
      .catch(fromDb);
    return this.cess(claims, projectId);
  }
}
