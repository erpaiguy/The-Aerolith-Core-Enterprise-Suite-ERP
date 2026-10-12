// Attendance (docs/wave3-plan.md step 11): a site's register marked by its project's team, a biometric device's export
// imported, the phone marking its holder in and out with its location, and the month: each employee's days (present,
// half, leave, holidays, weekly offs, absent) and payable days, the input payroll (step 12) needs.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { DEFAULT_RADIUS_M, distanceM, eachDay, FULL_DAY_HOURS, punchDays } from './hr-rules.js';
import { HrService, type EmployeeRow } from './hr.service.js';
import { LeaveService } from './leave.service.js';

type Db = Sql | TransactionSql;
type Status = 'present' | 'half_day' | 'absent' | 'on_duty';
/** India's date now. */
const indiaDay = (now = new Date()) =>
  new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
const at = (day: string, time: string | null) => (time ? `${day}T${time}:00+05:30` : null);
const lastDay = (month: string) => {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const half = (v: number) => (Math.round(v * 2) / 2).toFixed(1);

export interface Mark {
  employeeId: string;
  status: Status | null;
  inTime: string | null;
  outTime: string | null;
  note: string;
}

const EMPLOYEE_COLUMNS = (db: Db) => db`
  id, entity_id, code, name, to_char(joined_on, 'YYYY-MM-DD') AS joined_on, to_char(left_on, 'YYYY-MM-DD') AS left_on,
  user_id`;

@Injectable()
export class AttendanceService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly hr: HrService,
    private readonly leave: LeaveService,
  ) {}

  /** Who may mark a site's register: its project's lead or member with `attendance.mark`, or HR. */
  private async mayMark(db: Db, claims: TenantClaims, projectId: string) {
    if (await this.permissions.can(claims, 'hr.edit')) return;
    const a = await this.projects.access(db, claims, projectId);
    if (a.role !== 'lead' && a.role !== 'member' && !a.canEdit)
      throw new ForbiddenException({
        code: 'forbidden',
        message: "Only the project's team marks its sites' attendance.",
      });
    if (!(await this.permissions.can(claims, 'attendance.mark')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'attendance.mark',
        message: 'Marking attendance needs the attendance permission.',
      });
  }

  private async siteRow(db: Db, siteId: string) {
    const [s] = await db<{ id: string; name: string; project_id: string; entity_id: string }[]>`
      SELECT s.id, s.name, s.project_id, p.entity_id FROM proj.site s JOIN proj.project p ON p.id = s.project_id
      WHERE s.id = ${siteId}`;
    if (!s) throw new NotFoundException({ code: 'site_not_found' });
    return s;
  }

  /** The employees deployed at a site on a day. */
  private async deployedAt(db: Db, siteId: string, day: string) {
    return db<EmployeeRow[]>`
      SELECT ${EMPLOYEE_COLUMNS(db)} FROM hr.employee e
      WHERE e.joined_on <= ${day} AND (e.left_on IS NULL OR e.left_on >= ${day})
        AND (SELECT d.site_id FROM hr.deployment d WHERE d.employee_id = e.id AND d.from_date <= ${day}
          ORDER BY d.from_date DESC LIMIT 1) = ${siteId}
      ORDER BY lower(e.code)`;
  }

  // --- a site's register ---

  async register(claims: TenantClaims, siteId: string, day: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.siteRow(db, siteId);
    if (!(await this.permissions.can(claims, 'hr.view')))
      await this.mayMark(db, claims, s.project_id);
    const people = await this.deployedAt(db, siteId, day);
    const ids = people.map((p) => p.id);
    const plans = await this.hr.days(db, people, day, day);
    const leave = await this.leave.leaveOn(db, ids, day, day);
    const marks = await db<
      {
        employee_id: string;
        status: Status;
        in_at: string | null;
        out_at: string | null;
        source: string;
        flag: string | null;
        note: string;
      }[]
    >`
      SELECT employee_id, status, to_char(in_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS in_at,
        to_char(out_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS out_at, source, flag, note
      FROM hr.attendance WHERE employee_id = ANY(${ids}::uuid[]) AND day = ${day}`;
    return {
      site: { id: s.id, name: s.name, projectId: s.project_id },
      day,
      kind: plans.get(people[0]?.id ?? '')?.get(day)?.kind ?? null,
      rows: people.map((p) => {
        const m = marks.find((x) => x.employee_id === p.id);
        const l = leave.find((x) => x.employee_id === p.id);
        const plan = plans.get(p.id)!.get(day)!;
        return {
          employeeId: p.id,
          code: p.code,
          name: p.name,
          day: plan.kind,
          holiday: plan.holiday,
          leave: l ? `${l.code}${l.half_day ? ' (half)' : ''}` : null,
          status: m?.status ?? null,
          inTime: m?.in_at ?? null,
          outTime: m?.out_at ?? null,
          source: m?.source ?? null,
          flag: m?.flag ?? null,
          note: m?.note ?? '',
        };
      }),
    };
  }

  /** Checks a day's mark against the employee's leave: never present on a full day's approved leave. */
  private async checkLeave(db: Db, employee: EmployeeRow, day: string, status: Status) {
    if (status === 'absent') return;
    const [l] = await this.leave.leaveOn(db, [employee.id], day, day);
    if (l && (!l.half_day || status !== 'half_day'))
      throw new ConflictException({
        code: 'on_leave',
        message: `${employee.name} is on approved leave (${l.code}) on ${day}.`,
      });
  }

  async mark(claims: TenantClaims, siteId: string, day: string, marks: Mark[]) {
    if (day > indiaDay())
      throw new BadRequestException({
        code: 'future_day',
        message: 'Attendance is marked on the day or after.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const s = await this.siteRow(db, siteId);
    await this.mayMark(db, claims, s.project_id);
    await db.begin(async (tx) => {
      const people = await this.deployedAt(tx, siteId, day);
      for (const m of marks) {
        const e = people.find((p) => p.id === m.employeeId);
        if (!e)
          throw new BadRequestException({
            code: 'not_deployed',
            message: `Someone marked is not deployed at ${s.name} on ${day}.`,
          });
        if (m.status === null) {
          await tx`DELETE FROM hr.attendance WHERE employee_id = ${e.id} AND day = ${day}`;
          continue;
        }
        await this.checkLeave(tx, e, day, m.status);
        if (m.inTime && m.outTime && m.outTime < m.inTime)
          throw new BadRequestException({
            code: 'out_before_in',
            message: `${e.name}: out before in.`,
          });
        await tx`
          INSERT INTO hr.attendance (employee_id, day, status, in_at, out_at, project_id, site_id, source, note,
            updated_by)
          VALUES (${e.id}, ${day}, ${m.status}, ${at(day, m.inTime)}, ${at(day, m.outTime)}, ${s.project_id},
            ${siteId}, 'register', ${m.note}, ${claims.sub})
          ON CONFLICT (employee_id, day) DO UPDATE SET status = EXCLUDED.status, in_at = EXCLUDED.in_at,
            out_at = EXCLUDED.out_at, project_id = EXCLUDED.project_id, site_id = EXCLUDED.site_id,
            source = 'register', flag = NULL, latitude = NULL, longitude = NULL, distance_m = NULL,
            note = EXCLUDED.note, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      }
      await audit(tx, claims.sub, 'attendance.register', 'site', siteId, {
        day,
        count: marks.length,
      });
    });
    return this.register(claims, siteId, day);
  }

  // --- a biometric device's export ---

  /**
   * Each employee's day from the punches: first in, last out; four hours or more present, less a half day, one
   * punch present but flagged. Days already marked on the register or the phone, days of approved leave, unknown
   * codes and days out of service are left alone and reported.
   */
  async importPunches(claims: TenantClaims, entityId: string, rows: string[][]) {
    await this.hr.must(claims, 'hr.edit');
    const { days, skipped } = punchDays(rows);
    if (!days.length)
      throw new BadRequestException({ code: 'bad_attendance_file', message: 'No punches found.' });
    const today = indiaDay();
    const db = await this.tenants.forTenant(claims.ten);
    return db.begin(async (tx) => {
      const codes = [...new Set(days.map((d) => d.code.toLowerCase()))];
      const people = await tx<EmployeeRow[]>`
        SELECT ${EMPLOYEE_COLUMNS(tx)} FROM hr.employee
        WHERE entity_id = ${entityId} AND lower(code) = ANY(${codes}::text[])`;
      const byCode = new Map(people.map((p) => [p.code.toLowerCase(), p]));
      const from = days.reduce((m, d) => (d.day < m ? d.day : m), days[0]!.day);
      const to = days.reduce((m, d) => (d.day > m ? d.day : m), days[0]!.day);
      const plans = await this.hr.days(tx, people, from, to);
      const leave = await this.leave.leaveOn(
        tx,
        people.map((p) => p.id),
        from,
        to,
      );
      const existing = await tx<{ employee_id: string; day: string; source: string }[]>`
        SELECT employee_id, to_char(day, 'YYYY-MM-DD') AS day, source FROM hr.attendance
        WHERE employee_id = ANY(${people.map((p) => p.id)}::uuid[]) AND day BETWEEN ${from} AND ${to}`;
      let imported = 0;
      const problems: { code: string; day: string; reason: string }[] = [];
      for (const d of days) {
        const e = byCode.get(d.code.toLowerCase());
        if (!e) {
          problems.push({ code: d.code, day: d.day, reason: 'No such employee' });
          continue;
        }
        const plan = plans.get(e.id)!.get(d.day)!;
        const reason =
          d.day > today
            ? 'A day still to come'
            : plan.outOfService
              ? 'Not in service that day'
              : existing.some(
                    (x) => x.employee_id === e.id && x.day === d.day && x.source !== 'biometric',
                  )
                ? 'Already marked on the register or the phone'
                : leave.some(
                      (l) =>
                        l.employee_id === e.id &&
                        l.from_date <= d.day &&
                        l.to_date >= d.day &&
                        !(l.half_day && d.status === 'half_day'),
                    )
                  ? 'On approved leave'
                  : null;
        if (reason) {
          problems.push({ code: d.code, day: d.day, reason });
          continue;
        }
        await tx`
          INSERT INTO hr.attendance (employee_id, day, status, in_at, out_at, project_id, site_id, source, flag,
            updated_by)
          VALUES (${e.id}, ${d.day}, ${d.status}, ${at(d.day, d.first)}, ${d.punches > 1 ? at(d.day, d.last) : null},
            ${plan.projectId}, ${plan.siteId}, 'biometric', ${d.flag}, ${claims.sub})
          ON CONFLICT (employee_id, day) DO UPDATE SET status = EXCLUDED.status, in_at = EXCLUDED.in_at,
            out_at = EXCLUDED.out_at, project_id = EXCLUDED.project_id, site_id = EXCLUDED.site_id,
            flag = EXCLUDED.flag, updated_at = now(), updated_by = EXCLUDED.updated_by`;
        imported++;
      }
      await audit(tx, claims.sub, 'attendance.import', 'entity', entityId, {
        imported,
        problems: problems.length,
      });
      return { imported, problems, unreadRows: skipped };
    });
  }

  // --- the phone ---

  async me(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const e = await this.hr.self(db, claims);
    if (!e) return { employee: null };
    const day = indiaDay();
    const plan = (await this.hr.days(db, [e], day, day)).get(e.id)!.get(day)!;
    const [site] = plan.siteId
      ? await db<{ name: string; project: string; located: boolean }[]>`
          SELECT s.name, p.number AS project, s.latitude IS NOT NULL AS located
          FROM proj.site s JOIN proj.project p ON p.id = s.project_id WHERE s.id = ${plan.siteId}`
      : [];
    const [m] = await db`
      SELECT status, to_char(in_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS "inTime",
        to_char(out_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS "outTime", source, flag, distance_m AS "distanceM"
      FROM hr.attendance WHERE employee_id = ${e.id} AND day = ${day}`;
    const recent = await db`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, status, to_char(in_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS "inTime",
        to_char(out_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS "outTime", source, flag
      FROM hr.attendance WHERE employee_id = ${e.id} AND day < ${day} ORDER BY day DESC LIMIT 7`;
    return {
      employee: { id: e.id, code: e.code, name: e.name },
      day,
      kind: plan.kind,
      site: site ?? null,
      today: m ?? null,
      recent,
    };
  }

  /** The phone marks its holder in or out with where it is; away from the site the mark stands but is flagged. */
  async punch(
    claims: TenantClaims,
    input: { action: 'in' | 'out'; latitude: number; longitude: number },
    now = new Date(),
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    const e = await this.hr.self(db, claims);
    if (!e)
      throw new BadRequestException({
        code: 'not_an_employee',
        message: 'You have no employee record to mark attendance for.',
      });
    const day = indiaDay(now);
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM hr.employee WHERE id = ${e.id} FOR UPDATE`;
      const plan = (await this.hr.days(tx, [e], day, day)).get(e.id)!.get(day)!;
      if (plan.outOfService)
        throw new BadRequestException({
          code: 'not_in_service',
          message: 'You are not in service today.',
        });
      const [site] = plan.siteId
        ? await tx<
            { latitude: string | null; longitude: string | null; radius_m: number | null }[]
          >`
            SELECT latitude::text, longitude::text, radius_m FROM proj.site WHERE id = ${plan.siteId}`
        : [];
      const distance =
        site?.latitude && site.longitude
          ? distanceM(
              Number(site.latitude),
              Number(site.longitude),
              input.latitude,
              input.longitude,
            )
          : null;
      const flag =
        distance === null
          ? 'no_site_location'
          : distance > (site?.radius_m ?? DEFAULT_RADIUS_M)
            ? 'outside_site'
            : null;
      const [m] = await tx<
        {
          status: Status;
          in_at: Date | null;
          out_at: Date | null;
          source: string;
          flag: string | null;
        }[]
      >`
        SELECT status, in_at, out_at, source, flag FROM hr.attendance WHERE employee_id = ${e.id} AND day = ${day}
        FOR UPDATE`;
      if (input.action === 'in') {
        if (m)
          throw new ConflictException({
            code: 'already_marked',
            message: 'You are already marked today.',
          });
        await this.checkLeave(tx, e, day, 'present');
        await tx`
          INSERT INTO hr.attendance (employee_id, day, status, in_at, project_id, site_id, source, flag, latitude,
            longitude, distance_m, updated_by)
          VALUES (${e.id}, ${day}, 'present', ${now}, ${plan.projectId}, ${plan.siteId}, 'phone', ${flag},
            ${input.latitude}, ${input.longitude}, ${distance}, ${claims.sub})`;
      } else {
        if (!m || m.source !== 'phone' || !m.in_at)
          throw new ConflictException({ code: 'not_in', message: 'Mark in first.' });
        if (m.out_at)
          throw new ConflictException({ code: 'already_out', message: 'You are already out.' });
        const hours = (now.getTime() - new Date(m.in_at).getTime()) / 3_600_000;
        const status: Status = hours >= FULL_DAY_HOURS ? 'present' : 'half_day';
        await tx`
          UPDATE hr.attendance SET out_at = ${now}, status = ${status}, flag = coalesce(flag, ${flag}),
            updated_at = now(), updated_by = ${claims.sub}
          WHERE employee_id = ${e.id} AND day = ${day}`;
      }
    });
    return this.me(claims);
  }

  // --- the month ---

  /**
   * Each employee's month, day by day: P present (or on duty), H half day, L leave (paid) or U (unpaid), HO holiday,
   * WO weekly off, A absent, blank before joining, after leaving or still to come; and the counts. Payable days are
   * present, on duty, paid leave, holidays and weekly offs, with a half day counting a half; an unpaid or absent half
   * day does not.
   */
  async month(claims: TenantClaims, entityId: string, month: string) {
    await this.hr.must(claims, 'hr.view');
    return this.monthDays(await this.tenants.forTenant(claims.ten), entityId, month);
  }

  /** The month's days without a permission check (payroll reads them). */
  async monthDays(db: Db, entityId: string, month: string) {
    const from = `${month}-01`;
    const to = lastDay(month);
    const today = indiaDay();
    const people = await db<EmployeeRow[]>`
      SELECT ${EMPLOYEE_COLUMNS(db)} FROM hr.employee
      WHERE entity_id = ${entityId} AND joined_on <= ${to} AND (left_on IS NULL OR left_on >= ${from})
      ORDER BY lower(code)`;
    const ids = people.map((p) => p.id);
    const plans = await this.hr.days(db, people, from, to);
    const leave = await this.leave.leaveOn(db, ids, from, to);
    const marks = await db<
      { employee_id: string; day: string; status: Status; flag: string | null }[]
    >`
      SELECT employee_id, to_char(day, 'YYYY-MM-DD') AS day, status, flag FROM hr.attendance
      WHERE employee_id = ANY(${ids}::uuid[]) AND day BETWEEN ${from} AND ${to}`;
    const markOf = new Map(marks.map((m) => [`${m.employee_id}|${m.day}`, m]));
    const days = eachDay(from, to);
    return {
      month,
      days,
      rows: people.map((p) => {
        const plan = plans.get(p.id)!;
        const n = {
          present: 0,
          onDuty: 0,
          half: 0,
          paidLeave: 0,
          unpaidLeave: 0,
          holidays: 0,
          weeklyOffs: 0,
          absent: 0,
          payable: 0,
          inService: 0,
          flagged: 0,
        };
        const codes = days.map((day) => {
          const d = plan.get(day)!;
          if (d.outOfService || day > today) return '';
          n.inService++;
          const m = markOf.get(`${p.id}|${day}`);
          if (m?.flag) n.flagged++;
          if (m && m.status !== 'absent') {
            if (m.status === 'half_day') {
              // Half present; the other half is the half day's leave, or absent.
              n.half++;
              n.payable += 0.5;
              const l = leave.find(
                (x) => x.employee_id === p.id && x.from_date <= day && x.to_date >= day,
              );
              if (l?.paid) {
                n.paidLeave += 0.5;
                n.payable += 0.5;
              } else if (l) n.unpaidLeave += 0.5;
              else n.absent += 0.5;
              return 'H';
            }
            if (m.status === 'on_duty') n.onDuty++;
            else n.present++;
            n.payable += 1;
            return 'P';
          }
          if (d.kind === 'holiday' || d.kind === 'week_off') {
            if (d.kind === 'holiday') n.holidays++;
            else n.weeklyOffs++;
            n.payable += 1;
            return d.kind === 'holiday' ? 'HO' : 'WO';
          }
          const l = leave.find(
            (x) => x.employee_id === p.id && x.from_date <= day && x.to_date >= day,
          );
          if (l) {
            const share = l.half_day ? 0.5 : 1;
            if (l.paid) {
              n.paidLeave += share;
              n.payable += share;
            } else n.unpaidLeave += share;
            n.absent += 1 - share;
            return l.paid ? 'L' : 'U';
          }
          n.absent++;
          return 'A';
        });
        return {
          employeeId: p.id,
          code: p.code,
          name: p.name,
          codes,
          present: String(n.present),
          onDuty: String(n.onDuty),
          halfDays: String(n.half),
          paidLeave: half(n.paidLeave),
          unpaidLeave: half(n.unpaidLeave),
          holidays: String(n.holidays),
          weeklyOffs: String(n.weeklyOffs),
          absent: half(n.absent),
          payable: half(n.payable),
          daysInService: String(n.inService),
          flagged: n.flagged,
        };
      }),
    };
  }
}
