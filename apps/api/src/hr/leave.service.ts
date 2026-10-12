// Leave (docs/wave3-plan.md step 11): types, a year's balances (opening, accrued, taken, pending), applications that
// count only the employee's working days and go through the approval rules, and a year closed by carrying the capped
// balance forward.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { ApprovalService, type Outcome } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { accrued } from './hr-rules.js';
import { HrService, type EmployeeRow } from './hr.service.js';

type Db = Sql | TransactionSql;
export const LEAVE = 'leave_application';
const one = (v: number) => (Math.round(v * 10) / 10).toFixed(1);

interface TypeRow {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  days_per_year: string;
  accrual: 'annual' | 'monthly';
  carry_forward_max: string;
  active: boolean;
}
export interface LeaveTypeInput {
  code: string;
  name: string;
  paid: boolean;
  daysPerYear: string;
  accrual: 'annual' | 'monthly';
  carryForwardMax: string;
  active: boolean;
}
export interface ApplyInput {
  employeeId: string | null;
  leaveTypeId: string;
  from: string;
  to: string;
  halfDay: boolean;
  reason: string;
}

@Injectable()
export class LeaveService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly approvals: ApprovalService,
    private readonly hr: HrService,
  ) {}

  onModuleInit() {
    this.approvals.register(LEAVE, {
      label: 'Leave application',
      projectScoped: false,
      link: (id) => `/hr/leave/${id}`,
      decided: (tx, id, outcome) => this.decided(tx, id, outcome),
      summary: (db, id) => this.summary(db, id),
      canSee: async (db, claims, id) => {
        if (await this.permissions.can(claims, 'hr.view')) return true;
        const [a] = await db`
          SELECT 1 FROM hr.leave_application a JOIN hr.employee e ON e.id = a.employee_id
          WHERE a.id = ${id} AND (e.user_id = ${claims.sub} OR a.applied_by = ${claims.sub})`;
        return Boolean(a);
      },
    });
  }

  private async decided(tx: TransactionSql, id: string, outcome: Outcome) {
    await tx`UPDATE hr.leave_application SET status = ${outcome}, decided_at = now(), row_version = row_version + 1
      WHERE id = ${id} AND status = 'pending'`;
  }

  private async summary(db: Db, id: string) {
    const [a] = await db`
      SELECT a.id, e.code AS "employeeCode", e.name AS employee, t.name AS "leaveType", t.paid,
        to_char(a.from_date, 'YYYY-MM-DD') AS "from", to_char(a.to_date, 'YYYY-MM-DD') AS "to", a.half_day AS "halfDay",
        a.days::text AS days, a.reason, a.status
      FROM hr.leave_application a JOIN hr.employee e ON e.id = a.employee_id
      JOIN hr.leave_type t ON t.id = a.leave_type_id WHERE a.id = ${id}`;
    return a ?? null;
  }

  // --- types ---

  async types(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT id, code, name, paid, days_per_year::text AS "daysPerYear", accrual,
        carry_forward_max::text AS "carryForwardMax", active
      FROM hr.leave_type ORDER BY NOT active, code`;
  }

  async saveType(claims: TenantClaims, id: string | null, input: LeaveTypeInput) {
    await this.hr.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        if (id) {
          const [t] = await tx`
            UPDATE hr.leave_type SET code = ${input.code}, name = ${input.name}, paid = ${input.paid},
              days_per_year = ${input.daysPerYear}, accrual = ${input.accrual},
              carry_forward_max = ${input.carryForwardMax}, active = ${input.active}
            WHERE id = ${id} RETURNING id`;
          if (!t) throw new NotFoundException({ code: 'leave_type_not_found' });
        } else
          await tx`
            INSERT INTO hr.leave_type (code, name, paid, days_per_year, accrual, carry_forward_max, active, created_by)
            VALUES (${input.code}, ${input.name}, ${input.paid}, ${input.daysPerYear}, ${input.accrual},
              ${input.carryForwardMax}, ${input.active}, ${claims.sub})`;
        await audit(tx, claims.sub, 'leave_type.save', 'leave_type', id ?? input.code, {
          ...input,
        });
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'leave_type_exists',
            message: `There is already a leave type ${input.code}.`,
          });
        throw err;
      });
    return this.types(claims);
  }

  private async type(db: Db, id: string) {
    const [t] = await db<TypeRow[]>`
      SELECT id, code, name, paid, days_per_year::text AS days_per_year, accrual,
        carry_forward_max::text AS carry_forward_max, active
      FROM hr.leave_type WHERE id = ${id}`;
    if (!t) throw new NotFoundException({ code: 'leave_type_not_found' });
    return t;
  }

  async setOpening(
    claims: TenantClaims,
    employeeId: string,
    input: { year: number; leaveTypeId: string; days: string },
  ) {
    await this.hr.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await this.hr.employee(db, employeeId);
    await this.type(db, input.leaveTypeId);
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO hr.leave_opening (employee_id, leave_type_id, year, days, carried, updated_by)
        VALUES (${employeeId}, ${input.leaveTypeId}, ${input.year}, ${input.days}, false, ${claims.sub})
        ON CONFLICT (employee_id, leave_type_id, year) DO UPDATE SET days = EXCLUDED.days, carried = false,
          updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await audit(tx, claims.sub, 'leave.opening', 'employee', employeeId, input);
    });
    return this.employeeLeave(claims, employeeId, input.year);
  }

  // --- balances ---

  /** Each type's year for the employee: opening, accrued up to a date, taken (approved), pending and available. */
  async balances(db: Db, e: EmployeeRow, year: number, asOf: string, except: string | null = null) {
    const types = await db<TypeRow[]>`
      SELECT id, code, name, paid, days_per_year::text AS days_per_year, accrual,
        carry_forward_max::text AS carry_forward_max, active
      FROM hr.leave_type ORDER BY code`;
    const openings = await db<{ leave_type_id: string; days: string; carried: boolean }[]>`
      SELECT leave_type_id, days::text AS days, carried FROM hr.leave_opening
      WHERE employee_id = ${e.id} AND year = ${year}`;
    const used = await db<{ leave_type_id: string; status: string; days: string }[]>`
      SELECT leave_type_id, status, sum(days)::text AS days FROM hr.leave_application
      WHERE employee_id = ${e.id} AND extract(year FROM from_date) = ${year} AND status IN ('pending', 'approved')
        AND id IS DISTINCT FROM ${except}
      GROUP BY leave_type_id, status`;
    return types
      .filter((t) => t.active || used.some((u) => u.leave_type_id === t.id))
      .map((t) => {
        const opening = Number(openings.find((o) => o.leave_type_id === t.id)?.days ?? 0);
        const got = t.paid
          ? accrued({ daysPerYear: t.days_per_year, accrual: t.accrual }, year, e.joined_on, asOf)
          : 0;
        const taken = Number(
          used.find((u) => u.leave_type_id === t.id && u.status === 'approved')?.days ?? 0,
        );
        const pending = Number(
          used.find((u) => u.leave_type_id === t.id && u.status === 'pending')?.days ?? 0,
        );
        return {
          leaveTypeId: t.id,
          code: t.code,
          name: t.name,
          paid: t.paid,
          opening: one(opening),
          carried: openings.find((o) => o.leave_type_id === t.id)?.carried ?? false,
          accrued: one(got),
          taken: one(taken),
          pending: one(pending),
          available: t.paid ? one(opening + got - taken - pending) : null,
        };
      });
  }

  private async mayReadEmployee(db: Db, claims: TenantClaims, employeeId: string) {
    if ((await this.hr.self(db, claims))?.id === employeeId) return;
    await this.hr.must(claims, 'hr.view');
  }

  /** Balances accrued up to a date (by default today, or the year's end for another year). */
  async employeeLeave(claims: TenantClaims, employeeId: string, year: number, on?: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.mayReadEmployee(db, claims, employeeId);
    const e = await this.hr.employee(db, employeeId);
    const today = new Date().toISOString().slice(0, 10);
    const asOf = on ?? (today.slice(0, 4) === String(year) ? today : `${year}-12-31`);
    const applications = await db`
      SELECT a.id, t.code, t.name AS "leaveType", to_char(a.from_date, 'YYYY-MM-DD') AS "from",
        to_char(a.to_date, 'YYYY-MM-DD') AS "to", a.half_day AS "halfDay", a.days::text AS days, a.reason, a.status
      FROM hr.leave_application a JOIN hr.leave_type t ON t.id = a.leave_type_id
      WHERE a.employee_id = ${employeeId} AND extract(year FROM a.from_date) = ${year}
      ORDER BY a.from_date DESC, a.created_at DESC`;
    return {
      employee: { id: e.id, code: e.code, name: e.name },
      year,
      asOf,
      balances: await this.balances(db, e, year, asOf),
      applications,
    };
  }

  // --- applications ---

  /** Approved (or pending) leave of these employees overlapping the dates. */
  async leaveOn(db: Db, employeeIds: string[], from: string, to: string, statuses = ['approved']) {
    return db<
      {
        id: string;
        employee_id: string;
        from_date: string;
        to_date: string;
        half_day: boolean;
        paid: boolean;
        code: string;
        status: string;
      }[]
    >`
      SELECT a.id, a.employee_id, to_char(a.from_date, 'YYYY-MM-DD') AS from_date,
        to_char(a.to_date, 'YYYY-MM-DD') AS to_date, a.half_day, t.paid, t.code, a.status
      FROM hr.leave_application a JOIN hr.leave_type t ON t.id = a.leave_type_id
      WHERE a.employee_id = ANY(${employeeIds}::uuid[]) AND a.status = ANY(${statuses}::text[])
        AND a.from_date <= ${to} AND a.to_date >= ${from}`;
  }

  async apply(claims: TenantClaims, input: ApplyInput) {
    const db = await this.tenants.forTenant(claims.ten);
    const self = await this.hr.self(db, claims);
    const employeeId = input.employeeId ?? self?.id;
    if (!employeeId)
      throw new BadRequestException({
        code: 'not_an_employee',
        message: 'You have no employee record to apply for.',
      });
    if (employeeId !== self?.id) await this.hr.must(claims, 'hr.edit');
    if (input.halfDay && input.from !== input.to)
      throw new BadRequestException({
        code: 'half_day_one_day',
        message: 'A half day is one day.',
      });
    if (input.from.slice(0, 4) !== input.to.slice(0, 4))
      throw new BadRequestException({
        code: 'across_years',
        message: 'Apply separately for each year.',
      });
    const id = await db.begin(async (tx) => {
      await tx`SELECT 1 FROM hr.employee WHERE id = ${employeeId} FOR UPDATE`;
      const e = await this.hr.employee(tx, employeeId);
      const t = await this.type(tx, input.leaveTypeId);
      if (!t.active)
        throw new BadRequestException({
          code: 'leave_type_inactive',
          message: `${t.name} is no longer given.`,
        });
      const plan = (await this.hr.days(tx, [e], input.from, input.to)).get(e.id)!;
      if ([...plan.values()].some((d) => d.outOfService))
        throw new BadRequestException({
          code: 'not_in_service',
          message: `${e.name} is not with the company on all of those days.`,
        });
      const working = [...plan.entries()].filter(([, d]) => d.kind === 'work').map(([day]) => day);
      if (!working.length)
        throw new BadRequestException({
          code: 'no_working_days',
          message: 'Those are all holidays or weekly offs.',
        });
      const days = input.halfDay ? 0.5 : working.length;
      const [overlap] = await this.leaveOn(tx, [e.id], input.from, input.to, [
        'pending',
        'approved',
      ]);
      if (overlap)
        throw new ConflictException({
          code: 'leave_overlaps',
          message: `There is already leave from ${overlap.from_date} to ${overlap.to_date}.`,
        });
      const attended = await tx<{ day: string; status: string }[]>`
        SELECT to_char(day, 'YYYY-MM-DD') AS day, status FROM hr.attendance
        WHERE employee_id = ${e.id} AND day = ANY(${working}::date[]) AND status <> 'absent'
        ORDER BY day`;
      const clash = attended.find((a) => !(input.halfDay && a.status === 'half_day'));
      if (clash)
        throw new ConflictException({
          code: 'attended',
          message: `${e.name} is marked ${clash.status.replace('_', ' ')} on ${clash.day}.`,
        });
      if (t.paid) {
        const [b] = (await this.balances(tx, e, Number(input.from.slice(0, 4)), input.to)).filter(
          (x) => x.leaveTypeId === t.id,
        );
        if (Number(b?.available ?? 0) < days)
          throw new ConflictException({
            code: 'not_enough_leave',
            message: `${t.name}: ${b?.available ?? '0.0'} days available by ${input.to}, ${one(days)} asked.`,
          });
      }
      const [a] = await tx<{ id: string }[]>`
        INSERT INTO hr.leave_application (employee_id, leave_type_id, from_date, to_date, half_day, days, reason,
          applied_by)
        VALUES (${e.id}, ${t.id}, ${input.from}, ${input.to}, ${input.halfDay}, ${days}, ${input.reason},
          ${claims.sub})
        RETURNING id`;
      const res = await this.approvals.submit(tx, claims, {
        docType: LEAVE,
        docId: a!.id,
        projectId: null,
        title: `${e.name}: ${t.name}, ${input.from}${input.to !== input.from ? ` to ${input.to}` : ''}`,
        amount: '0',
      });
      if (res.status === 'approved') await this.decided(tx, a!.id, 'approved');
      await audit(tx, claims.sub, 'leave.apply', 'leave_application', a!.id, { ...input, days });
      return a!.id;
    });
    return this.application(claims, id);
  }

  async application(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [a] = await db<{ employee_id: string; applied_by: string }[]>`
      SELECT employee_id, applied_by FROM hr.leave_application WHERE id = ${id}`;
    if (!a) throw new NotFoundException({ code: 'leave_not_found' });
    const own =
      (await this.hr.self(db, claims))?.id === a.employee_id || a.applied_by === claims.sub;
    if (!own) await this.hr.must(claims, 'hr.view');
    const s = (await this.summary(db, id)) as Record<string, unknown>;
    const mayEdit = await this.permissions.can(claims, 'hr.edit');
    return {
      ...s,
      approval: await this.approvals.latestFor(db, claims, LEAVE, id),
      mayWithdraw: s.status === 'pending' && own,
      mayCancel: s.status === 'approved' && mayEdit,
    };
  }

  async withdraw(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [a] = await tx<{ status: string; applied_by: string; user_id: string | null }[]>`
        SELECT a.status, a.applied_by, e.user_id FROM hr.leave_application a
        JOIN hr.employee e ON e.id = a.employee_id WHERE a.id = ${id} FOR UPDATE OF a`;
      if (!a) throw new NotFoundException({ code: 'leave_not_found' });
      if (a.applied_by !== claims.sub && a.user_id !== claims.sub)
        throw new ForbiddenException({
          code: 'forbidden',
          message: 'Only the applicant withdraws it.',
        });
      if (a.status !== 'pending')
        throw new ConflictException({ code: 'not_pending', message: 'It is no longer waiting.' });
      await this.approvals.withdrawFor(tx, claims, LEAVE, id);
      await this.decided(tx, id, 'withdrawn');
      await audit(tx, claims.sub, 'leave.withdraw', 'leave_application', id, {});
    });
    return this.application(claims, id);
  }

  /** Approved leave called off (the employee came to work after all): HR only. */
  async cancel(claims: TenantClaims, id: string) {
    await this.hr.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [a] = await tx`
        UPDATE hr.leave_application SET status = 'cancelled', row_version = row_version + 1
        WHERE id = ${id} AND status = 'approved' RETURNING id`;
      if (!a)
        throw new ConflictException({
          code: 'not_approved',
          message: 'Only approved leave is cancelled.',
        });
      await audit(tx, claims.sub, 'leave.cancel', 'leave_application', id, {});
    });
    return this.application(claims, id);
  }

  async list(claims: TenantClaims, entityId: string, status: string | null) {
    await this.hr.must(claims, 'hr.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT a.id, e.id AS "employeeId", e.code AS "employeeCode", e.name AS employee, t.code, t.name AS "leaveType",
        to_char(a.from_date, 'YYYY-MM-DD') AS "from", to_char(a.to_date, 'YYYY-MM-DD') AS "to", a.half_day AS "halfDay",
        a.days::text AS days, a.reason, a.status
      FROM hr.leave_application a JOIN hr.employee e ON e.id = a.employee_id
      JOIN hr.leave_type t ON t.id = a.leave_type_id
      WHERE e.entity_id = ${entityId} AND (${status}::text IS NULL OR a.status = ${status})
      ORDER BY a.from_date DESC, e.code LIMIT 500`;
  }

  /**
   * Closes a leave year: each paid type's closing balance (opening + accrued − taken), at most its carry-forward cap,
   * becomes next year's opening, for everyone still in service on 31 December. Openings typed by hand stay.
   */
  async carryForward(claims: TenantClaims, entityId: string, year: number) {
    await this.hr.must(claims, 'hr.edit');
    const db = await this.tenants.forTenant(claims.ten);
    const end = `${year}-12-31`;
    return db.begin(async (tx) => {
      const employees = await tx<EmployeeRow[]>`
        SELECT id, entity_id, code, name, to_char(joined_on, 'YYYY-MM-DD') AS joined_on,
          to_char(left_on, 'YYYY-MM-DD') AS left_on, user_id
        FROM hr.employee WHERE entity_id = ${entityId} AND joined_on <= ${end}
          AND (left_on IS NULL OR left_on > ${end})
        ORDER BY code`;
      const caps = await tx<{ id: string; carry_forward_max: string }[]>`
        SELECT id, carry_forward_max::text AS carry_forward_max FROM hr.leave_type
        WHERE paid AND carry_forward_max > 0`;
      const out: { code: string; leave: string; closing: string; carried: string }[] = [];
      for (const e of employees) {
        const balances = await this.balances(tx, e, year, end);
        for (const cap of caps) {
          const b = balances.find((x) => x.leaveTypeId === cap.id);
          if (!b) continue;
          const closing = Number(b.opening) + Number(b.accrued) - Number(b.taken);
          const carried = Math.min(Math.max(closing, 0), Number(cap.carry_forward_max));
          await tx`
            INSERT INTO hr.leave_opening (employee_id, leave_type_id, year, days, carried, updated_by)
            VALUES (${e.id}, ${cap.id}, ${year + 1}, ${carried}, true, ${claims.sub})
            ON CONFLICT (employee_id, leave_type_id, year) DO UPDATE SET days = EXCLUDED.days,
              updated_at = now(), updated_by = EXCLUDED.updated_by
            WHERE hr.leave_opening.carried`;
          out.push({ code: e.code, leave: b.code, closing: one(closing), carried: one(carried) });
        }
      }
      await audit(tx, claims.sub, 'leave.carry_forward', 'entity', entityId, { year });
      return { year, rows: out };
    });
  }
}
