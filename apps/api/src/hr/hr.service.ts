// HR (docs/wave3-plan.md step 11): designations (with the permissions they add, and as approvers), employees with
// their statutory numbers (Aadhaar only as its last four digits, with consent: the DPDP Act; PAN and bank in full only
// to whoever keeps the records), holiday calendars, sites' calendars and locations, and deployment history. Also
// what each employee's days were (where, and whether a working day): attendance, leave and the month read it.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { isPermission, PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { dayKind, eachDay, mask, type DayKind } from './hr-rules.js';

type Db = Sql | TransactionSql;
/** With no calendar at all: Monday to Saturday. */
const SIX_DAY_WEEK = 63;

export interface EmployeeInput {
  entityId: string;
  code: string;
  name: string;
  kind: 'staff' | 'worker';
  gender: 'female' | 'male' | 'other' | null;
  birthDate: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  joinedOn: string;
  leftOn: string | null;
  grade: string;
  designationId: string | null;
  department: string;
  managerId: string | null;
  userId: string | null;
  pan: string | null;
  uan: string | null;
  esiNumber: string | null;
  aadhaarLast4: string | null;
  aadhaarConsentOn: string | null;
  bankAccount: string | null;
  bankIfsc: string | null;
  bankName: string;
}
const COLUMNS: Record<keyof Omit<EmployeeInput, 'entityId'>, string> = {
  code: 'code',
  name: 'name',
  kind: 'kind',
  gender: 'gender',
  birthDate: 'birth_date',
  phone: 'phone',
  email: 'email',
  address: 'address',
  joinedOn: 'joined_on',
  leftOn: 'left_on',
  grade: 'grade',
  designationId: 'designation_id',
  department: 'department',
  managerId: 'manager_id',
  userId: 'user_id',
  pan: 'pan',
  uan: 'uan',
  esiNumber: 'esi_number',
  aadhaarLast4: 'aadhaar_last4',
  aadhaarConsentOn: 'aadhaar_consent_on',
  bankAccount: 'bank_account',
  bankIfsc: 'bank_ifsc',
  bankName: 'bank_name',
};

export interface EmployeeRow {
  id: string;
  entity_id: string;
  code: string;
  name: string;
  joined_on: string;
  left_on: string | null;
  user_id: string | null;
}

export interface DayPlan {
  projectId: string | null;
  siteId: string | null;
  kind: DayKind;
  holiday: string | null;
  /** Before joining or after leaving. */
  outOfService: boolean;
}

@Injectable()
export class HrService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  async must(claims: TenantClaims, p: 'hr.view' | 'hr.edit') {
    if (await this.permissions.can(claims, p)) return;
    if (p === 'hr.view' && (await this.permissions.can(claims, 'hr.edit'))) return;
    throw new ForbiddenException({
      code: 'forbidden',
      permission: p,
      message:
        p === 'hr.view'
          ? 'Seeing the employees needs the HR permission.'
          : 'Keeping the employee records needs the HR edit permission.',
    });
  }

  async employee(db: Db, id: string) {
    const [e] = await db<EmployeeRow[]>`
      SELECT id, entity_id, code, name, to_char(joined_on, 'YYYY-MM-DD') AS joined_on,
        to_char(left_on, 'YYYY-MM-DD') AS left_on, user_id
      FROM hr.employee WHERE id = ${id}`;
    if (!e) throw new NotFoundException({ code: 'employee_not_found' });
    return e;
  }

  /** The signed-in person's employee record, if they have one. */
  async self(db: Db, claims: TenantClaims) {
    const [e] = await db<
      { id: string }[]
    >`SELECT id FROM hr.employee WHERE user_id = ${claims.sub}`;
    return e ? this.employee(db, e.id) : null;
  }

  // --- designations ---

  async designations(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    // Everyone signed in may read the list (approval rules name them).
    return db`
      SELECT d.id, d.name, d.row_version AS "rowVersion",
        coalesce((SELECT array_agg(p.permission ORDER BY p.permission) FROM hr.designation_permission p
          WHERE p.designation_id = d.id), '{}') AS permissions,
        (SELECT count(*)::int FROM hr.employee e WHERE e.designation_id = d.id AND e.left_on IS NULL) AS holders
      FROM hr.designation d ORDER BY lower(d.name)`;
  }

  async saveDesignation(
    claims: TenantClaims,
    id: string | null,
    input: { name: string; permissions: string[]; rowVersion?: number | undefined },
  ) {
    await this.must(claims, 'hr.edit');
    const bad = input.permissions.filter((p) => !isPermission(p));
    if (bad.length)
      throw new BadRequestException({
        code: 'unknown_permission',
        message: `No such permission: ${bad.join(', ')}.`,
      });
    const db = await this.tenants.forTenant(claims.ten);
    const saved = await db
      .begin(async (tx) => {
        let did = id;
        if (did) {
          const [d] = await tx<{ row_version: number }[]>`
            SELECT row_version FROM hr.designation WHERE id = ${did} FOR UPDATE`;
          if (!d) throw new NotFoundException({ code: 'designation_not_found' });
          if (input.rowVersion !== undefined && d.row_version !== input.rowVersion)
            throw new ConflictException({
              code: 'stale',
              message: 'Someone else changed this designation. Reload.',
            });
          await tx`UPDATE hr.designation SET name = ${input.name}, row_version = row_version + 1 WHERE id = ${did}`;
          await tx`DELETE FROM hr.designation_permission WHERE designation_id = ${did}`;
        } else {
          const [d] = await tx<{ id: string }[]>`
            INSERT INTO hr.designation (name, created_by) VALUES (${input.name}, ${claims.sub}) RETURNING id`;
          did = d!.id;
        }
        for (const p of new Set(input.permissions))
          await tx`INSERT INTO hr.designation_permission (designation_id, permission) VALUES (${did}, ${p})`;
        await audit(tx, claims.sub, 'designation.save', 'designation', did, {
          name: input.name,
          permissions: input.permissions,
        });
        return did;
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'designation_exists',
            message: `There is already a designation "${input.name}".`,
          });
        throw err;
      });
    this.permissions.forget(claims.ten);
    return { id: saved, designations: await this.designations(claims) };
  }

  // --- employees ---

  private async checkEmployee(db: Db, input: Partial<EmployeeInput>, id: string | null) {
    if (input.aadhaarLast4 && !input.aadhaarConsentOn)
      throw new BadRequestException({
        code: 'aadhaar_consent',
        message: "Aadhaar's last four digits are kept only with the date the employee consented.",
      });
    if (input.managerId) {
      if (input.managerId === id)
        throw new BadRequestException({
          code: 'own_manager',
          message: 'Nobody reports to themselves.',
        });
      const [m] = await db`SELECT 1 FROM hr.employee WHERE id = ${input.managerId}`;
      if (!m)
        throw new BadRequestException({ code: 'manager_not_found', message: 'No such manager.' });
    }
    if (input.userId) {
      const [u] = await db`SELECT 1 FROM platform."user" WHERE id = ${input.userId}`;
      if (!u) throw new BadRequestException({ code: 'user_not_found', message: 'No such user.' });
    }
  }

  private conflict(err: unknown, code: string | undefined): never {
    const e = err as { code?: string; constraint_name?: string };
    if (e.code === '23505')
      throw new ConflictException(
        e.constraint_name === 'employee_user_id_key'
          ? { code: 'user_taken', message: 'That user is already another employee.' }
          : {
              code: 'employee_exists',
              message: `There is already an employee ${code ?? ''}.`.trim(),
            },
      );
    if (e.code === '23514')
      throw new BadRequestException({
        code: 'bad_employee',
        message: 'Check the PAN, UAN, ESI number, Aadhaar digits, bank account, IFSC and dates.',
      });
    throw err;
  }

  async createEmployee(claims: TenantClaims, input: EmployeeInput) {
    await this.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await this.checkEmployee(db, input, null);
    const id = await db
      .begin(async (tx) => {
        const row: Record<string, unknown> = { entity_id: input.entityId, created_by: claims.sub };
        for (const [k, c] of Object.entries(COLUMNS)) row[c] = input[k as keyof EmployeeInput];
        const [e] = await tx<{ id: string }[]>`INSERT INTO hr.employee ${tx(row)} RETURNING id`;
        await audit(tx, claims.sub, 'employee.create', 'employee', e!.id, { code: input.code });
        return e!.id;
      })
      .catch((err: unknown) => this.conflict(err, input.code));
    this.permissions.forget(claims.ten);
    return this.getEmployee(claims, id);
  }

  /** Only the fields given change; a masked number sent back unchanged is ignored. */
  async updateEmployee(
    claims: TenantClaims,
    id: string,
    input: Partial<EmployeeInput> & { rowVersion: number },
  ) {
    await this.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await this.checkEmployee(db, input, id);
    await db
      .begin(async (tx) => {
        const [e] = await tx<{ row_version: number; aadhaar_consent_on: string | null }[]>`
          SELECT row_version, aadhaar_consent_on FROM hr.employee WHERE id = ${id} FOR UPDATE`;
        if (!e) throw new NotFoundException({ code: 'employee_not_found' });
        if (e.row_version !== input.rowVersion)
          throw new ConflictException({
            code: 'stale',
            message: 'Someone else changed this employee. Reload.',
          });
        const row: Record<string, unknown> = {};
        for (const [k, c] of Object.entries(COLUMNS)) {
          const v = input[k as keyof EmployeeInput];
          if (v !== undefined) row[c] = v;
        }
        if (input.aadhaarLast4 === null) row.aadhaar_consent_on = null;
        if (!Object.keys(row).length) return;
        await tx`UPDATE hr.employee SET ${tx(row)}, updated_at = now(), updated_by = ${claims.sub},
          row_version = row_version + 1 WHERE id = ${id}`;
        // Never the numbers themselves in the log.
        await audit(tx, claims.sub, 'employee.update', 'employee', id, {
          fields: Object.keys(row),
        });
      })
      .catch((err: unknown) => this.conflict(err, input.code));
    this.permissions.forget(claims.ten);
    return this.getEmployee(claims, id);
  }

  async listEmployees(claims: TenantClaims, entityId: string, all = false) {
    await this.must(claims, 'hr.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT e.id, e.code, e.name, e.kind, d.name AS designation, e.department, e.grade,
        to_char(e.joined_on, 'YYYY-MM-DD') AS "joinedOn", to_char(e.left_on, 'YYYY-MM-DD') AS "leftOn",
        m.name AS manager, u.username,
        (SELECT json_build_object('from', to_char(x.from_date, 'YYYY-MM-DD'), 'project', p.number,
          'projectName', p.name, 'site', s.name)
          FROM hr.deployment x LEFT JOIN proj.project p ON p.id = x.project_id LEFT JOIN proj.site s ON s.id = x.site_id
          WHERE x.employee_id = e.id AND x.from_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date ORDER BY x.from_date DESC LIMIT 1) AS place
      FROM hr.employee e
      LEFT JOIN hr.designation d ON d.id = e.designation_id
      LEFT JOIN hr.employee m ON m.id = e.manager_id
      LEFT JOIN platform."user" u ON u.id = e.user_id
      WHERE e.entity_id = ${entityId} AND (${all} OR e.left_on IS NULL OR e.left_on >= (now() AT TIME ZONE 'Asia/Kolkata')::date)
      ORDER BY lower(e.code)`;
  }

  async getEmployee(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const own = (await this.self(db, claims))?.id === id;
    if (!own) await this.must(claims, 'hr.view');
    const full = own || (await this.permissions.can(claims, 'hr.edit'));
    const [e] = await db<Record<string, unknown>[]>`
      SELECT e.id, e.entity_id AS "entityId", e.code, e.name, e.kind, e.gender,
        to_char(e.birth_date, 'YYYY-MM-DD') AS "birthDate", e.phone, e.email, e.address,
        to_char(e.joined_on, 'YYYY-MM-DD') AS "joinedOn", to_char(e.left_on, 'YYYY-MM-DD') AS "leftOn", e.grade,
        e.designation_id AS "designationId", d.name AS designation, e.department, e.manager_id AS "managerId",
        m.name AS manager, e.user_id AS "userId", u.username, e.pan, e.uan, e.esi_number AS "esiNumber",
        e.aadhaar_last4 AS "aadhaarLast4", to_char(e.aadhaar_consent_on, 'YYYY-MM-DD') AS "aadhaarConsentOn",
        e.bank_account AS "bankAccount", e.bank_ifsc AS "bankIfsc", e.bank_name AS "bankName",
        e.row_version AS "rowVersion"
      FROM hr.employee e
      LEFT JOIN hr.designation d ON d.id = e.designation_id
      LEFT JOIN hr.employee m ON m.id = e.manager_id
      LEFT JOIN platform."user" u ON u.id = e.user_id
      WHERE e.id = ${id}`;
    if (!e) throw new NotFoundException({ code: 'employee_not_found' });
    if (!full) {
      e.pan = mask(e.pan as string | null);
      e.bankAccount = mask(e.bankAccount as string | null);
    }
    const deployments = await db`
      SELECT to_char(x.from_date, 'YYYY-MM-DD') AS "from", x.project_id AS "projectId", p.number AS project,
        p.name AS "projectName", x.site_id AS "siteId", s.name AS site
      FROM hr.deployment x LEFT JOIN proj.project p ON p.id = x.project_id LEFT JOIN proj.site s ON s.id = x.site_id
      WHERE x.employee_id = ${id} ORDER BY x.from_date`;
    return { ...e, masked: !full, deployments };
  }

  async deploy(
    claims: TenantClaims,
    id: string,
    input: { from: string; projectId: string | null; siteId: string | null },
  ) {
    await this.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM hr.employee WHERE id = ${id} FOR UPDATE`;
      const e = await this.employee(tx, id);
      if (input.from < e.joined_on || (e.left_on && input.from > e.left_on))
        throw new BadRequestException({
          code: 'not_in_service',
          message: `${e.name} is not with the company on ${input.from}.`,
        });
      if (input.siteId && !input.projectId)
        throw new BadRequestException({ code: 'site_needs_project', message: 'Name the project.' });
      if (input.projectId) {
        const [p] = await tx<{ entity_id: string }[]>`
          SELECT entity_id FROM proj.project WHERE id = ${input.projectId}`;
        if (!p || p.entity_id !== e.entity_id)
          throw new BadRequestException({
            code: 'other_company',
            message: "Not a project of the employee's company.",
          });
        if (input.siteId) {
          const [s] = await tx`
            SELECT 1 FROM proj.site WHERE id = ${input.siteId} AND project_id = ${input.projectId}`;
          if (!s)
            throw new BadRequestException({
              code: 'site_not_found',
              message: 'Not a site of that project.',
            });
        }
      }
      const [later] = await tx`
        SELECT 1 FROM hr.deployment WHERE employee_id = ${id} AND from_date >= ${input.from}`;
      if (later)
        throw new ConflictException({
          code: 'deployment_after',
          message: 'They are already deployed from that date or later.',
        });
      const [marked] = await tx`
        SELECT 1 FROM hr.attendance WHERE employee_id = ${id} AND day >= ${input.from}`;
      if (marked)
        throw new ConflictException({
          code: 'attendance_after',
          message: 'Attendance is already marked on or after that date.',
        });
      await tx`INSERT INTO hr.deployment (employee_id, from_date, project_id, site_id, created_by)
        VALUES (${id}, ${input.from}, ${input.projectId}, ${input.siteId}, ${claims.sub})`;
      await audit(tx, claims.sub, 'employee.deploy', 'employee', id, input);
    });
    return this.getEmployee(claims, id);
  }

  // --- calendars and sites ---

  async calendars(claims: TenantClaims, entityId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT c.id, c.name, c.work_week AS "workWeek", c.is_default AS "isDefault",
        coalesce((SELECT json_agg(json_build_object('day', to_char(h.day, 'YYYY-MM-DD'), 'name', h.name)
          ORDER BY h.day) FROM hr.holiday h WHERE h.calendar_id = c.id), '[]') AS holidays,
        coalesce((SELECT json_agg(json_build_object('siteId', s.id, 'site', s.name, 'project', p.number)
          ORDER BY p.number, s.name) FROM proj.site s JOIN proj.project p ON p.id = s.project_id
          WHERE s.calendar_id = c.id), '[]') AS sites
      FROM hr.calendar c WHERE c.entity_id = ${entityId} ORDER BY NOT c.is_default, lower(c.name)`;
  }

  async saveCalendar(
    claims: TenantClaims,
    id: string | null,
    input: { entityId: string; name: string; workWeek: number; isDefault: boolean },
  ) {
    await this.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        if (input.isDefault)
          await tx`UPDATE hr.calendar SET is_default = false WHERE entity_id = ${input.entityId} AND is_default
            AND id IS DISTINCT FROM ${id}`;
        if (id) {
          const [c] = await tx`
            UPDATE hr.calendar SET name = ${input.name}, work_week = ${input.workWeek}, is_default = ${input.isDefault}
            WHERE id = ${id} AND entity_id = ${input.entityId} RETURNING id`;
          if (!c) throw new NotFoundException({ code: 'calendar_not_found' });
        } else
          await tx`INSERT INTO hr.calendar (entity_id, name, work_week, is_default, created_by)
            VALUES (${input.entityId}, ${input.name}, ${input.workWeek}, ${input.isDefault}, ${claims.sub})`;
        await audit(tx, claims.sub, 'calendar.save', 'calendar', id ?? input.name, input);
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'calendar_exists',
            message: `There is already a calendar "${input.name}".`,
          });
        throw err;
      });
    return this.calendars(claims, input.entityId);
  }

  async setHoliday(claims: TenantClaims, calendarId: string, day: string, name: string | null) {
    await this.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    const [c] = await db<
      { entity_id: string }[]
    >`SELECT entity_id FROM hr.calendar WHERE id = ${calendarId}`;
    if (!c) throw new NotFoundException({ code: 'calendar_not_found' });
    await db.begin(async (tx) => {
      if (name)
        await tx`INSERT INTO hr.holiday (calendar_id, day, name) VALUES (${calendarId}, ${day}, ${name})
          ON CONFLICT (calendar_id, day) DO UPDATE SET name = EXCLUDED.name`;
      else await tx`DELETE FROM hr.holiday WHERE calendar_id = ${calendarId} AND day = ${day}`;
      await audit(tx, claims.sub, 'calendar.holiday', 'calendar', calendarId, { day, name });
    });
    return this.calendars(claims, c.entity_id);
  }

  /** A site's calendar and its place on the map (for the phone's attendance). */
  async setSite(
    claims: TenantClaims,
    siteId: string,
    input: {
      calendarId: string | null;
      latitude: string | null;
      longitude: string | null;
      radiusM: number | null;
    },
  ) {
    await this.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db<{ entity_id: string }[]>`
      SELECT p.entity_id FROM proj.site s JOIN proj.project p ON p.id = s.project_id WHERE s.id = ${siteId}`;
    if (!s) throw new NotFoundException({ code: 'site_not_found' });
    if (input.calendarId) {
      const [c] = await db`
        SELECT 1 FROM hr.calendar WHERE id = ${input.calendarId} AND entity_id = ${s.entity_id}`;
      if (!c)
        throw new BadRequestException({
          code: 'calendar_not_found',
          message: "Not a calendar of the project's company.",
        });
    }
    if (
      (input.latitude === null) !== (input.longitude === null) ||
      (input.radiusM && !input.latitude)
    )
      throw new BadRequestException({
        code: 'bad_location',
        message: 'Give both the latitude and the longitude (and the radius only with them).',
      });
    await db.begin(async (tx) => {
      await tx`UPDATE proj.site SET calendar_id = ${input.calendarId}, latitude = ${input.latitude},
        longitude = ${input.longitude}, radius_m = ${input.radiusM} WHERE id = ${siteId}`;
      await audit(tx, claims.sub, 'site.hr', 'site', siteId, input);
    });
    return this.site(claims, siteId);
  }

  async site(claims: TenantClaims, siteId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db`
      SELECT s.id, s.name, p.id AS "projectId", p.number AS project, p.name AS "projectName", p.entity_id AS "entityId",
        s.calendar_id AS "calendarId", c.name AS calendar, s.latitude::text AS latitude,
        s.longitude::text AS longitude, s.radius_m AS "radiusM"
      FROM proj.site s JOIN proj.project p ON p.id = s.project_id LEFT JOIN hr.calendar c ON c.id = s.calendar_id
      WHERE s.id = ${siteId}`;
    if (!s) throw new NotFoundException({ code: 'site_not_found' });
    return s;
  }

  /** Every site of a company's projects, with its calendar and location (HR's sites page). */
  async sites(claims: TenantClaims, entityId: string) {
    await this.must(claims, 'hr.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT s.id, s.name, p.id AS "projectId", p.number AS project, p.name AS "projectName",
        s.calendar_id AS "calendarId", c.name AS calendar, s.latitude::text AS latitude,
        s.longitude::text AS longitude, s.radius_m AS "radiusM"
      FROM proj.site s JOIN proj.project p ON p.id = s.project_id LEFT JOIN hr.calendar c ON c.id = s.calendar_id
      WHERE p.entity_id = ${entityId} AND s.active ORDER BY p.number, s.name`;
  }

  // --- each employee's days ---

  /**
   * Where each employee was each day from one date to another (their deployment), and whether it was a working day,
   * a holiday or a weekly off by their site's calendar (else their company's default; else Monday to Saturday).
   */
  async days(db: Db, employees: EmployeeRow[], from: string, to: string) {
    const ids = employees.map((e) => e.id);
    const deployments = await db<
      {
        employee_id: string;
        from_date: string;
        project_id: string | null;
        site_id: string | null;
      }[]
    >`
      SELECT employee_id, to_char(from_date, 'YYYY-MM-DD') AS from_date, project_id, site_id FROM hr.deployment
      WHERE employee_id = ANY(${ids}::uuid[]) AND from_date <= ${to} ORDER BY from_date`;
    const siteIds = [...new Set(deployments.map((d) => d.site_id).filter((s): s is string => !!s))];
    const sites = await db<{ id: string; calendar_id: string | null }[]>`
      SELECT id, calendar_id FROM proj.site WHERE id = ANY(${siteIds}::uuid[])`;
    const entities = [...new Set(employees.map((e) => e.entity_id))];
    const calendars = await db<
      { id: string; entity_id: string; work_week: number; is_default: boolean }[]
    >`
      SELECT id, entity_id, work_week, is_default FROM hr.calendar WHERE entity_id = ANY(${entities}::uuid[])`;
    const holidays = await db<{ calendar_id: string; day: string; name: string }[]>`
      SELECT calendar_id, to_char(day, 'YYYY-MM-DD') AS day, name FROM hr.holiday
      WHERE calendar_id = ANY(${calendars.map((c) => c.id)}::uuid[]) AND day BETWEEN ${from} AND ${to}`;
    const calOf = new Map(calendars.map((c) => [c.id, c]));
    const siteCal = new Map(sites.map((s) => [s.id, s.calendar_id]));
    const holidaySets = new Map<string, Set<string>>();
    const holidayName = new Map<string, string>();
    for (const h of holidays) {
      holidaySets.set(h.calendar_id, (holidaySets.get(h.calendar_id) ?? new Set()).add(h.day));
      holidayName.set(`${h.calendar_id}|${h.day}`, h.name);
    }
    const range = eachDay(from, to);
    const out = new Map<string, Map<string, DayPlan>>();
    for (const e of employees) {
      const mine = deployments.filter((d) => d.employee_id === e.id);
      const fallback = calendars.find((c) => c.entity_id === e.entity_id && c.is_default) ?? null;
      const plan = new Map<string, DayPlan>();
      let at = -1;
      for (const day of range) {
        while (at + 1 < mine.length && mine[at + 1]!.from_date <= day) at++;
        const place = at >= 0 ? mine[at]! : null;
        const cal = (place?.site_id && calOf.get(siteCal.get(place.site_id) ?? '')) || fallback;
        const set = cal ? (holidaySets.get(cal.id) ?? new Set<string>()) : new Set<string>();
        const kind = dayKind(day, cal?.work_week ?? SIX_DAY_WEEK, set);
        plan.set(day, {
          projectId: place?.project_id ?? null,
          siteId: place?.site_id ?? null,
          kind,
          holiday: kind === 'holiday' && cal ? (holidayName.get(`${cal.id}|${day}`) ?? null) : null,
          outOfService: day < e.joined_on || (e.left_on !== null && day > e.left_on),
        });
      }
      out.set(e.id, plan);
    }
    return out;
  }
}
