// Payroll (docs/wave3-plan.md step 12a): the compliance rules (data with effective dates), pay components, each
// employee's salary from a date, and the monthly run: earnings by the payable days of step 11, PF, ESI, professional
// tax, labour welfare fund and TDS on salary by the rules in force on the month's last day; approved through the
// approval rules; posted with the cost split by project; paid from a bank ledger with the bank's file.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import { fromDb } from '../accounts/accounts-rules.js';
import { LedgerService, type LineInput } from '../accounts/ledger.service.js';
import { ApprovalService, type Outcome } from '../approvals/approval.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { AttendanceService } from '../hr/attendance.service.js';
import { HrService } from '../hr/hr.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import {
  esi,
  esiCovered,
  esiPeriodStart,
  financialYearStart,
  lwf,
  monthlyTds,
  monthsLeftInYear,
  pf,
  professionalTax,
  round2,
  wagesOf,
  type EsiRule,
  type LwfRule,
  type PfRule,
  type PtRule,
  type TaxRule,
  type WagesRule,
  declaredDeductions,
  instalment,
  overtimePay,
} from './payroll-rules.js';

type Db = Sql | TransactionSql;
export const PAYROLL_RUN = 'payroll_run';
export type RuleKind = 'wages' | 'pf' | 'esi' | 'pt' | 'lwf' | 'income_tax';
const lastDay = (month: string) => {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const r = (v: number) => Math.round(v + 1e-9);
const money = (v: number) => v.toFixed(2);

interface Component {
  id: string;
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  in_wages: boolean;
  taxable: boolean;
  prorated: boolean;
}
interface Salary {
  id: string;
  employee_id: string;
  from_date: string;
  pf_mode: 'none' | 'ceiling' | 'actual';
  esi: boolean;
  regime: 'new' | 'old';
  old_deductions: string;
}
export interface SalaryInput {
  from: string;
  pfMode: 'none' | 'ceiling' | 'actual';
  esi: boolean;
  regime: 'new' | 'old';
  oldDeductions: string;
  lines: { componentId: string; amount: string | null; percentOfBasic: string | null }[];
}
interface RunRow {
  id: string;
  entity_id: string;
  month: string;
  status: 'draft' | 'pending' | 'approved' | 'posted' | 'paid';
  voucher_id: string | null;
  payment_voucher_id: string | null;
}
export interface Earning {
  code: string;
  name: string;
  full: number;
  amount: number;
  oneOff: boolean;
  inWages: boolean;
  taxable: boolean;
}

@Injectable()
export class PayrollService implements OnModuleInit {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly approvals: ApprovalService,
    private readonly ledger: LedgerService,
    private readonly hr: HrService,
    private readonly attendance: AttendanceService,
  ) {}

  onModuleInit() {
    this.approvals.register(PAYROLL_RUN, {
      label: 'Payroll run',
      projectScoped: false,
      link: (id) => `/payroll/runs/${id}`,
      decided: (tx, id, outcome) => this.decided(tx, id, outcome),
      summary: (db, id) => this.totals(db, id),
      canSee: (_db, claims) => this.permissions.can(claims, 'payroll.run'),
    });
  }

  private async must(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'payroll.run')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'payroll.run',
        message: 'Payroll needs the payroll permission.',
      });
  }

  private async decided(tx: TransactionSql, id: string, outcome: Outcome) {
    await tx`UPDATE pay.run SET status = ${outcome === 'approved' ? 'approved' : 'draft'},
      row_version = row_version + 1 WHERE id = ${id} AND status = 'pending'`;
  }

  // --- the rules ---

  async rules(claims: TenantClaims) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT id, kind, state_code AS "stateCode", to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom", data, note
      FROM pay.rule ORDER BY kind, state_code NULLS FIRST, effective_from DESC`;
  }

  /** A new version of a rule from a date; earlier versions stay for the months they governed. */
  async addRule(
    claims: TenantClaims,
    input: {
      kind: RuleKind;
      stateCode: string | null;
      effectiveFrom: string;
      data: object;
      note: string;
    },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [posted] = await tx`
          SELECT 1 FROM pay.run WHERE status IN ('approved', 'posted', 'paid')
            AND (month + interval '1 month' - interval '1 day')::date >= ${input.effectiveFrom} LIMIT 1`;
        if (posted)
          throw new ConflictException({
            code: 'months_paid',
            message:
              'A month from that date is already approved; the rule would not match what was paid.',
          });
        const [x] = await tx<{ id: string }[]>`
          INSERT INTO pay.rule (kind, state_code, effective_from, data, note, created_by)
          VALUES (${input.kind}, ${input.stateCode}, ${input.effectiveFrom}, ${tx.json(JSON.parse(JSON.stringify(input.data)))},
            ${input.note}, ${claims.sub})
          RETURNING id`;
        await audit(tx, claims.sub, 'payroll.rule', 'rule', x!.id, { ...input });
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'rule_exists',
            message: 'There is already a version of that rule from that date.',
          });
        throw err;
      });
    return this.rules(claims);
  }

  private async rule<T>(
    db: Db,
    kind: RuleKind,
    state: string | null,
    on: string,
  ): Promise<T | null> {
    const [x] = await db<{ data: T }[]>`
      SELECT data FROM pay.rule WHERE kind = ${kind} AND state_code IS NOT DISTINCT FROM ${state}
        AND effective_from <= ${on} ORDER BY effective_from DESC LIMIT 1`;
    return x?.data ?? null;
  }

  // --- components and salaries ---

  async components(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT id, code, name, kind, in_wages AS "inWages", taxable, prorated, active FROM pay.component
      ORDER BY pos, code`;
  }

  async addComponent(
    claims: TenantClaims,
    input: {
      code: string;
      name: string;
      kind: 'earning' | 'deduction';
      inWages: boolean;
      taxable: boolean;
      prorated: boolean;
    },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        await tx`INSERT INTO pay.component (code, name, kind, in_wages, taxable, prorated, pos)
          VALUES (${input.code}, ${input.name}, ${input.kind}, ${input.kind === 'earning' && input.inWages},
            ${input.taxable}, ${input.prorated}, (SELECT coalesce(max(pos), 0) + 10 FROM pay.component))`;
        await audit(tx, claims.sub, 'payroll.component', 'component', input.code, { ...input });
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'component_exists',
            message: `There is already ${input.code}.`,
          });
        throw err;
      });
    return this.components(claims);
  }

  async salaries(claims: TenantClaims, employeeId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await this.hr.employee(db, employeeId);
    return db`
      SELECT s.id, to_char(s.from_date, 'YYYY-MM-DD') AS "from", s.pf_mode AS "pfMode", s.esi, s.regime,
        s.old_deductions::text AS "oldDeductions",
        (SELECT json_agg(json_build_object('componentId', c.id, 'code', c.code, 'name', c.name,
          'amount', l.amount::text, 'percentOfBasic', l.percent_of_basic::text) ORDER BY c.pos)
          FROM pay.salary_line l JOIN pay.component c ON c.id = l.component_id WHERE l.salary_id = s.id) AS lines
      FROM pay.salary s WHERE s.employee_id = ${employeeId} ORDER BY s.from_date DESC`;
  }

  async setSalary(claims: TenantClaims, employeeId: string, input: SalaryInput) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const e = await this.hr.employee(db, employeeId);
    if (input.from < e.joined_on)
      throw new BadRequestException({
        code: 'before_joining',
        message: `${e.name} joined on ${e.joined_on}.`,
      });
    const components = await db<Component[]>`SELECT * FROM pay.component`;
    const basic = components.find((c) => c.code === 'BASIC');
    for (const l of input.lines) {
      const c = components.find((x) => x.id === l.componentId);
      if (!c || c.kind !== 'earning')
        throw new BadRequestException({
          code: 'not_an_earning',
          message: 'A salary is made of earnings.',
        });
      if (
        l.percentOfBasic &&
        (c.id === basic?.id || !input.lines.some((x) => x.componentId === basic?.id))
      )
        throw new BadRequestException({
          code: 'percent_of_basic',
          message: 'A percentage of basic needs a basic amount.',
        });
    }
    await db
      .begin(async (tx) => {
        const [paid] = await tx`
          SELECT 1 FROM pay.run_line l JOIN pay.run r ON r.id = l.run_id
          WHERE l.employee_id = ${employeeId} AND r.status <> 'draft'
            AND (r.month + interval '1 month' - interval '1 day')::date >= ${input.from} LIMIT 1`;
        if (paid)
          throw new ConflictException({
            code: 'months_paid',
            message: 'A month from that date is already approved; pay the difference as arrears.',
          });
        const [s] = await tx<{ id: string }[]>`
          INSERT INTO pay.salary (employee_id, from_date, pf_mode, esi, regime, old_deductions, created_by)
          VALUES (${employeeId}, ${input.from}, ${input.pfMode}, ${input.esi}, ${input.regime},
            ${input.oldDeductions}, ${claims.sub})
          RETURNING id`;
        for (const l of input.lines)
          await tx`INSERT INTO pay.salary_line (salary_id, component_id, amount, percent_of_basic)
            VALUES (${s!.id}, ${l.componentId}, ${l.amount}, ${l.percentOfBasic})`;
        await audit(tx, claims.sub, 'payroll.salary', 'employee', employeeId, { from: input.from });
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'salary_exists',
            message: 'There is already a salary from that date.',
          });
        throw err;
      });
    return this.salaries(claims, employeeId);
  }

  // --- salary revisions in bulk (docs/wave7-plan.md step 7c.7) ---

  /** Everyone in service on the day, with the salary in force then and its monthly gross. */
  async incrementSheet(claims: TenantClaims, entityId: string, from: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const people = await db<
      { id: string; code: string; name: string; designation: string | null }[]
    >`
      SELECT e.id, e.code, e.name, d.name AS designation FROM hr.employee e
      LEFT JOIN hr.designation d ON d.id = e.designation_id
      WHERE e.entity_id = ${entityId} AND e.joined_on <= ${from} AND (e.left_on IS NULL OR e.left_on >= ${from})
      ORDER BY e.code`;
    const rows = [];
    for (const p of people) {
      const s = await this.salaryOn(db, p.id, from);
      rows.push({
        employee: p,
        salary: s
          ? { from: s.salary.from_date, gross: String(s.lines.reduce((n, l) => n + l.full, 0)) }
          : null,
      });
    }
    return { entityId, from, rows };
  }

  /**
   * The sheet applied together: for each person given a percentage, a new salary from the day, each fixed amount
   * raised by it (to the rupee) and each share of basic kept, so it follows the new basic. All or none.
   */
  async applyIncrements(
    claims: TenantClaims,
    entityId: string,
    from: string,
    rows: { employeeId: string; pct: string }[],
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const raise = rows.filter((x) => Number(x.pct) > 0);
    if (!raise.length)
      throw new BadRequestException({
        code: 'nothing_to_apply',
        message: 'Give someone an increment.',
      });
    await db.begin(async (tx) => {
      for (const x of raise) {
        const [e] = await tx<{ name: string }[]>`
            SELECT name FROM hr.employee WHERE id = ${x.employeeId} AND entity_id = ${entityId}`;
        if (!e) throw new BadRequestException({ code: 'not_in_company' });
        const cur = await this.salaryOn(tx, x.employeeId, from);
        if (!cur)
          throw new BadRequestException({
            code: 'no_salary',
            message: `${e.name} has no salary to revise.`,
          });
        if (cur.salary.from_date === from)
          throw new ConflictException({
            code: 'salary_exists',
            message: `${e.name} already has a salary from that date.`,
          });
        const [paid] = await tx`
            SELECT 1 FROM pay.run_line l JOIN pay.run r ON r.id = l.run_id
            WHERE l.employee_id = ${x.employeeId} AND r.status <> 'draft'
              AND (r.month + interval '1 month' - interval '1 day')::date >= ${from} LIMIT 1`;
        if (paid)
          throw new ConflictException({
            code: 'months_paid',
            message: `A month from that date is already approved for ${e.name}; pay the difference as arrears.`,
          });
        const [ns] = await tx<{ id: string }[]>`
            INSERT INTO pay.salary (employee_id, from_date, pf_mode, esi, regime, old_deductions, created_by)
            VALUES (${x.employeeId}, ${from}, ${cur.salary.pf_mode}, ${cur.salary.esi}, ${cur.salary.regime},
              ${cur.salary.old_deductions}, ${claims.sub})
            RETURNING id`;
        for (const l of cur.lines) {
          const amount =
            l.component.amount === null
              ? null
              : String(Math.round(Number(l.component.amount) * (1 + Number(x.pct) / 100)));
          await tx`INSERT INTO pay.salary_line (salary_id, component_id, amount, percent_of_basic)
              VALUES (${ns!.id}, ${l.component.id}, ${amount}, ${l.component.percent_of_basic})`;
        }
        await audit(tx, claims.sub, 'payroll.increment', 'employee', x.employeeId, {
          from,
          pct: x.pct,
        });
      }
    });
    return this.incrementSheet(claims, entityId, from);
  }

  /** The salary in force on a date, with each component's full monthly amount. */
  private async salaryOn(db: Db, employeeId: string, on: string) {
    const [s] = await db<Salary[]>`
      SELECT id, employee_id, to_char(from_date, 'YYYY-MM-DD') AS from_date, pf_mode, esi, regime,
        old_deductions::text AS old_deductions
      FROM pay.salary WHERE employee_id = ${employeeId} AND from_date <= ${on} ORDER BY from_date DESC LIMIT 1`;
    if (!s) return null;
    const lines = await db<
      (Component & { amount: string | null; percent_of_basic: string | null })[]
    >`
      SELECT c.*, l.amount::text AS amount, l.percent_of_basic::text AS percent_of_basic
      FROM pay.salary_line l JOIN pay.component c ON c.id = l.component_id WHERE l.salary_id = ${s.id}
      ORDER BY c.pos`;
    const basic = Number(lines.find((l) => l.code === 'BASIC')?.amount ?? 0);
    return {
      salary: s,
      lines: lines.map((l) => ({
        component: l,
        full: l.amount !== null ? Number(l.amount) : r((basic * Number(l.percent_of_basic)) / 100),
      })),
    };
  }

  // --- the run ---

  private async run(db: Db, id: string) {
    const [x] = await db<RunRow[]>`
      SELECT id, entity_id, to_char(month, 'YYYY-MM') AS month, status, voucher_id, payment_voucher_id
      FROM pay.run WHERE id = ${id}`;
    if (!x) throw new NotFoundException({ code: 'run_not_found' });
    return x;
  }

  async create(claims: TenantClaims, entityId: string, month: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        const [x] = await tx<{ id: string }[]>`
          INSERT INTO pay.run (entity_id, month, created_by) VALUES (${entityId}, ${`${month}-01`}, ${claims.sub})
          RETURNING id`;
        await audit(tx, claims.sub, 'payroll.run', 'run', x!.id, { month });
        return x!.id;
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'run_exists',
            message: `${month} already has a run.`,
          });
        throw err;
      });
    await this.work(claims, id);
    return this.get(claims, id);
  }

  async list(claims: TenantClaims, entityId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT r.id, to_char(r.month, 'YYYY-MM') AS month, r.status, count(l.employee_id)::int AS employees,
        coalesce(sum(l.gross), 0)::text AS gross, coalesce(sum(l.net), 0)::text AS net
      FROM pay.run r LEFT JOIN pay.run_line l ON l.run_id = r.id
      WHERE r.entity_id = ${entityId} GROUP BY r.id ORDER BY r.month DESC`;
  }

  async addAdjustment(
    claims: TenantClaims,
    runId: string,
    input: { employeeId: string; componentId: string; amount: string; note: string },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const x = await this.run(tx, runId);
      if (x.status !== 'draft') throw this.notDraft();
      const [c] = await tx<
        Component[]
      >`SELECT * FROM pay.component WHERE id = ${input.componentId}`;
      if (!c)
        throw new BadRequestException({
          code: 'component_not_found',
          message: 'No such component.',
        });
      await tx`INSERT INTO pay.adjustment (run_id, employee_id, component_id, amount, note, created_by)
        VALUES (${runId}, ${input.employeeId}, ${input.componentId}, ${input.amount}, ${input.note}, ${claims.sub})`;
    });
    await this.work(claims, runId);
    return this.get(claims, runId);
  }

  async removeAdjustment(claims: TenantClaims, runId: string, adjustmentId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const x = await this.run(tx, runId);
      if (x.status !== 'draft') throw this.notDraft();
      await tx`DELETE FROM pay.adjustment WHERE id = ${adjustmentId} AND run_id = ${runId}`;
    });
    await this.work(claims, runId);
    return this.get(claims, runId);
  }

  private notDraft() {
    return new ConflictException({ code: 'not_draft', message: 'The run is no longer a draft.' });
  }

  /** Works (or works again) every employee's month in a draft run. */
  async work(claims: TenantClaims, runId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [locked] = await tx<RunRow[]>`SELECT id FROM pay.run WHERE id = ${runId} FOR UPDATE`;
      if (!locked) throw new NotFoundException({ code: 'run_not_found' });
      const x = await this.run(tx, runId);
      if (x.status !== 'draft') throw this.notDraft();
      const month = x.month;
      const end = lastDay(month);
      const monthNo = Number(month.slice(5, 7));
      const days = Number(end.slice(8, 10));
      const attendance = await this.attendance.monthDays(tx, x.entity_id, month);
      const [entity] = await tx<{ state_code: string | null }[]>`
        SELECT state_code FROM platform.entity WHERE id = ${x.entity_id}`;
      const wagesRule = await this.rule<WagesRule>(tx, 'wages', null, end);
      const pfRule = await this.rule<PfRule>(tx, 'pf', null, end);
      const esiRule = await this.rule<EsiRule>(tx, 'esi', null, end);
      const taxRule = await this.rule<TaxRule>(tx, 'income_tax', null, end);
      if (!pfRule || !esiRule || !taxRule)
        throw new ConflictException({
          code: 'no_rule',
          message: `PF, ESI and income tax need rules in force on ${end}.`,
        });
      const adjustments = await tx<
        (Component & { employee_id: string; amount: string; note: string })[]
      >`
        SELECT c.*, a.employee_id, a.amount::text AS amount, a.note FROM pay.adjustment a
        JOIN pay.component c ON c.id = a.component_id WHERE a.run_id = ${runId}`;
      const fyStart = `${financialYearStart(month)}-01`;
      await tx`DELETE FROM pay.run_line WHERE run_id = ${runId}`;
      const people = await tx<{ id: string; gender: string | null }[]>`
        SELECT id, gender FROM hr.employee WHERE id = ANY(${attendance.rows.map((a) => a.employeeId)}::uuid[])`;
      const plans = await this.hr.days(
        tx,
        await tx`SELECT id, entity_id, code, name, to_char(joined_on, 'YYYY-MM-DD') AS joined_on,
          to_char(left_on, 'YYYY-MM-DD') AS left_on, user_id FROM hr.employee
          WHERE id = ANY(${attendance.rows.map((a) => a.employeeId)}::uuid[])`,
        `${month}-01`,
        end,
      );
      for (const a of attendance.rows) {
        const sal = await this.salaryOn(tx, a.employeeId, end);
        if (!sal) continue;
        const payable = Number(a.payable);
        const share = payable / days;
        const earnings: Earning[] = sal.lines.map((l) => ({
          code: l.component.code,
          name: l.component.name,
          full: l.full,
          amount: l.component.prorated ? r(l.full * share) : l.full,
          oneOff: false,
          inWages: l.component.in_wages,
          taxable: l.component.taxable,
        }));
        const mine = adjustments.filter((j) => j.employee_id === a.employeeId);
        for (const j of mine.filter((j) => j.kind === 'earning'))
          earnings.push({
            code: j.code,
            name: j.note ? `${j.name}: ${j.note}` : j.name,
            full: Number(j.amount),
            amount: Number(j.amount),
            oneOff: true,
            inWages: j.in_wages,
            taxable: j.taxable,
          });
        // Overtime approved for the month (docs/wave8-plan.md step 8c.4), at twice the hourly rate on wages.
        const [ot] = await tx<{ hours: string }[]>`
          SELECT coalesce(sum(hours), 0)::text AS hours FROM pay.overtime
          WHERE employee_id = ${a.employeeId} AND day BETWEEN ${`${month}-01`} AND ${end}`;
        if (Number(ot!.hours) > 0) {
          const monthlyWages = sal.lines
            .filter((l) => l.component.in_wages)
            .reduce((t, l) => t + l.full, 0);
          const amount = overtimePay(monthlyWages, days, Number(ot!.hours));
          earnings.push({
            code: 'OT',
            name: `Overtime, ${Number(ot!.hours)} hours`,
            full: amount,
            amount,
            oneOff: true,
            inWages: false,
            taxable: true,
          });
        }
        const deductions: { code: string; name: string; amount: number; loanId?: string }[] = mine
          .filter((j) => j.kind === 'deduction')
          .map((j) => ({
            code: j.code,
            name: j.note ? `${j.name}: ${j.note}` : j.name,
            amount: Number(j.amount),
          }));
        // Loans and advances: this month's instalment of each, until it is recovered.
        const loans = await tx<{ id: string; kind: string; emi: string; left: string }[]>`
          SELECT l.id, l.kind, l.emi::text AS emi,
            (l.principal - coalesce((SELECT sum((d->>'amount')::numeric) FROM pay.run_line x
              JOIN pay.run r ON r.id = x.run_id, jsonb_array_elements(x.deductions) d
              WHERE x.employee_id = l.employee_id AND r.id <> ${runId} AND r.status IN ('approved', 'posted', 'paid')
                AND d->>'loanId' = l.id::text), 0))::text AS left
          FROM pay.loan l WHERE l.employee_id = ${a.employeeId} AND l.first_month <= ${`${month}-01`}
          ORDER BY l.given_on`;
        for (const l of loans) {
          const amount = instalment(Number(l.emi), Number(l.left));
          if (amount > 0)
            deductions.push({
              code: 'LOAN',
              name: l.kind === 'loan' ? 'Loan instalment' : 'Salary advance recovered',
              amount,
              loanId: l.id,
            });
        }
        const gross = earnings.reduce((s, e) => s + e.amount, 0);
        const regular = earnings.filter((e) => !e.oneOff);
        const wages = wagesRule
          ? wagesOf(
              regular.map((e) => ({ amount: e.amount, inWages: e.inWages })),
              wagesRule,
            )
          : regular.filter((e) => e.inWages).reduce((s, e) => s + e.amount, 0);
        const pfOut =
          sal.salary.pf_mode === 'none' ? null : pf(wages, pfRule, sal.salary.pf_mode === 'actual');
        // ESI: covered for the whole contribution period if the full month's gross was within the ceiling at its
        // start (or on joining, if later).
        const periodStart = `${esiPeriodStart(month)}-01`;
        const atStart = await this.salaryOn(tx, a.employeeId, periodStart);
        const judged = atStart ?? sal;
        const covered =
          sal.salary.esi &&
          esiCovered(
            judged.lines.reduce((s, l) => s + l.full, 0),
            esiRule,
          );
        const esiOut = covered ? esi(gross, esiRule) : { employee: 0, employer: 0 };
        // Professional tax and the labour welfare fund by the state of the place of work on the month's last day.
        const place = plans.get(a.employeeId)?.get(end);
        const [site] = place?.siteId
          ? await tx<
              { state_code: string | null }[]
            >`SELECT state_code FROM proj.site WHERE id = ${place.siteId}`
          : [];
        const state = site?.state_code ?? entity?.state_code ?? null;
        const ptRule = state ? await this.rule<PtRule>(tx, 'pt', state, end) : null;
        const lwfRule = state ? await this.rule<LwfRule>(tx, 'lwf', state, end) : null;
        const gender = people.find((p) => p.id === a.employeeId)?.gender ?? null;
        const pt = ptRule ? professionalTax(gross, gender, monthNo, ptRule) : 0;
        const lwfOut = lwf(monthNo, lwfRule);
        // TDS on salary.
        const [prior] = await tx<{ taxable: string; tds: string }[]>`
          SELECT coalesce(sum(l.taxable), 0)::text AS taxable, coalesce(sum(l.tds), 0)::text AS tds
          FROM pay.run_line l JOIN pay.run r ON r.id = l.run_id
          WHERE l.employee_id = ${a.employeeId} AND r.status IN ('approved', 'posted', 'paid')
            AND r.month >= ${fyStart} AND r.month < ${`${month}-01`}`;
        const regime = taxRule[sal.salary.regime];
        // Old regime: the year's declarations (proofs once verified), or the salary's figure where none is made.
        const decl = await tx<{ section: string; declared: string; proved: string | null }[]>`
          SELECT section, declared::text, proved::text FROM pay.tax_declaration
          WHERE employee_id = ${a.employeeId} AND fy_start = ${Number(fyStart.slice(0, 4))}`;
        const oldDeductions = decl.length
          ? declaredDeductions(
              decl.map((d) => ({
                section: d.section,
                declared: Number(d.declared),
                proved: d.proved === null ? null : Number(d.proved),
              })),
            )
          : Number(sal.salary.old_deductions);
        const taxableRegular = regular.filter((e) => e.taxable).reduce((s, e) => s + e.amount, 0);
        const taxableFull = regular.filter((e) => e.taxable).reduce((s, e) => s + e.full, 0);
        const oneOff = earnings
          .filter((e) => e.oneOff && e.taxable)
          .reduce((s, e) => s + e.amount, 0);
        const tax = monthlyTds({
          regime,
          paidSoFar: Number(prior!.taxable),
          regular: taxableRegular,
          regularFull: taxableFull,
          oneOff,
          monthsLeft: monthsLeftInYear(month),
          tdsSoFar: Number(prior!.tds),
          deductions: sal.salary.regime === 'old' ? oldDeductions : 0,
        });
        const net =
          gross -
          (pfOut?.employee ?? 0) -
          esiOut.employee -
          pt -
          lwfOut.employee -
          tax.tds -
          deductions.reduce((s, d) => s + d.amount, 0);
        // The cost by project: the days at each place in the month.
        const split = new Map<string | null, number>();
        for (const d of plans.get(a.employeeId)?.values() ?? [])
          if (!d.outOfService) split.set(d.projectId, (split.get(d.projectId) ?? 0) + 1);
        await tx`
          INSERT INTO pay.run_line (run_id, employee_id, days, payable_days, earnings, deductions, gross, wages, pf,
            esi_employee, esi_employer, pt, lwf_employee, lwf_employer, tds, taxable, net, split, tax)
          VALUES (${runId}, ${a.employeeId}, ${days}, ${payable}, ${tx.json(JSON.parse(JSON.stringify(earnings)))},
            ${tx.json(deductions)}, ${money(gross)}, ${money(wages)}, ${tx.json(pfOut ?? {})}, ${esiOut.employee},
            ${esiOut.employer}, ${pt}, ${lwfOut.employee}, ${lwfOut.employer}, ${tax.tds},
            ${money(taxableRegular + oneOff)}, ${money(round2(net))},
            ${tx.json([...split.entries()].map(([projectId, n]) => ({ projectId, days: n })))},
            ${tx.json({ regime: sal.salary.regime, projected: tax.projected, yearTax: tax.yearTax })})`;
      }
      await tx`UPDATE pay.run SET worked_at = now(), row_version = row_version + 1 WHERE id = ${runId}`;
    });
  }

  private async totals(db: Db, runId: string) {
    const [t] = await db`
      SELECT to_char(r.month, 'YYYY-MM') AS month, r.status, count(l.employee_id)::int AS employees,
        coalesce(sum(l.gross), 0)::text AS gross, coalesce(sum(l.net), 0)::text AS net,
        coalesce(sum((l.pf->>'employee')::numeric), 0)::numeric(20,2)::text AS "pfEmployee",
        coalesce(sum((l.pf->>'eps')::numeric + (l.pf->>'employerEpf')::numeric), 0)::numeric(20,2)::text AS "pfEmployer",
        coalesce(sum((l.pf->>'edli')::numeric + (l.pf->>'admin')::numeric), 0)::numeric(20,2)::text AS "pfCharges",
        coalesce(sum(l.esi_employee), 0)::text AS "esiEmployee", coalesce(sum(l.esi_employer), 0)::text AS "esiEmployer",
        coalesce(sum(l.pt), 0)::text AS pt, coalesce(sum(l.lwf_employee), 0)::text AS "lwfEmployee",
        coalesce(sum(l.lwf_employer), 0)::text AS "lwfEmployer", coalesce(sum(l.tds), 0)::text AS tds,
        coalesce(sum((SELECT coalesce(sum((d->>'amount')::numeric), 0) FROM jsonb_array_elements(l.deductions) d)),
          0)::numeric(20,2)::text AS "otherDeductions"
      FROM pay.run r LEFT JOIN pay.run_line l ON l.run_id = r.id WHERE r.id = ${runId} GROUP BY r.id`;
    return t ?? null;
  }

  async get(claims: TenantClaims, runId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const x = await this.run(db, runId);
    const lines = await db`
      SELECT l.employee_id AS "employeeId", e.code, e.name, l.days::text AS days, l.payable_days::text AS "payableDays",
        l.earnings, l.deductions, l.gross::text AS gross, l.wages::text AS wages, l.pf,
        l.esi_employee::text AS "esiEmployee", l.esi_employer::text AS "esiEmployer", l.pt::text AS pt,
        l.lwf_employee::text AS "lwfEmployee", l.lwf_employer::text AS "lwfEmployer", l.tds::text AS tds,
        l.taxable::text AS taxable, l.net::text AS net, l.split, l.tax
      FROM pay.run_line l JOIN hr.employee e ON e.id = l.employee_id WHERE l.run_id = ${runId} ORDER BY lower(e.code)`;
    const adjustments = await db`
      SELECT a.id, a.employee_id AS "employeeId", c.code, c.name, c.kind, a.amount::text AS amount, a.note
      FROM pay.adjustment a JOIN pay.component c ON c.id = a.component_id WHERE a.run_id = ${runId}`;
    const missing = await db`
      SELECT e.id, e.code, e.name FROM hr.employee e
      WHERE e.entity_id = ${x.entity_id} AND e.joined_on <= ${lastDay(x.month)}
        AND (e.left_on IS NULL OR e.left_on >= ${`${x.month}-01`})
        AND NOT EXISTS (SELECT 1 FROM pay.run_line l WHERE l.run_id = ${runId} AND l.employee_id = e.id)
      ORDER BY lower(e.code)`;
    const [vouchers] = await db`
      SELECT (SELECT number FROM acc.voucher WHERE id = ${x.voucher_id}) AS voucher,
        (SELECT number FROM acc.voucher WHERE id = ${x.payment_voucher_id}) AS payment`;
    return {
      id: x.id,
      entityId: x.entity_id,
      month: x.month,
      status: x.status,
      totals: await this.totals(db, runId),
      lines,
      adjustments,
      withoutSalary: missing,
      voucherId: x.voucher_id,
      voucher: vouchers?.voucher ?? null,
      paymentVoucherId: x.payment_voucher_id,
      payment: vouchers?.payment ?? null,
      approval: await this.approvals.latestFor(db, claims, PAYROLL_RUN, runId),
    };
  }

  async submit(claims: TenantClaims, runId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [locked] = await tx`SELECT 1 FROM pay.run WHERE id = ${runId} FOR UPDATE`;
      if (!locked) throw new NotFoundException({ code: 'run_not_found' });
      const x = await this.run(tx, runId);
      if (x.status !== 'draft') throw this.notDraft();
      const t = (await this.totals(tx, runId)) as { gross: string; employees: number };
      if (!t.employees)
        throw new BadRequestException({
          code: 'empty_run',
          message: 'Nobody in the run has a salary.',
        });
      await tx`UPDATE pay.run SET status = 'pending', row_version = row_version + 1 WHERE id = ${runId}`;
      const res = await this.approvals.submit(tx, claims, {
        docType: PAYROLL_RUN,
        docId: runId,
        projectId: null,
        title: `Payroll, ${x.month}`,
        amount: t.gross,
      });
      if (res.status === 'approved') await this.decided(tx, runId, 'approved');
      await audit(tx, claims.sub, 'payroll.submit', 'run', runId, {});
    });
    return this.get(claims, runId);
  }

  /** The month's voucher: the cost by project; what is owed to the staff and to the authorities. */
  async post(claims: TenantClaims, runId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [locked] = await tx`SELECT 1 FROM pay.run WHERE id = ${runId} FOR UPDATE`;
        if (!locked) throw new NotFoundException({ code: 'run_not_found' });
        const x = await this.run(tx, runId);
        if (x.status !== 'approved')
          throw new ConflictException({
            code: 'not_approved',
            message: 'Only an approved run is posted.',
          });
        const lines = await tx<
          {
            gross: string;
            pf: {
              employee?: number;
              eps?: number;
              employerEpf?: number;
              edli?: number;
              admin?: number;
            };
            esi_employee: string;
            esi_employer: string;
            pt: string;
            lwf_employee: string;
            lwf_employer: string;
            tds: string;
            net: string;
            deductions: { amount: number }[];
            split: { projectId: string | null; days: number }[];
          }[]
        >`SELECT gross::text, pf, esi_employee::text, esi_employer::text, pt::text, lwf_employee::text,
            lwf_employer::text, tds::text, net::text, deductions, split
          FROM pay.run_line WHERE run_id = ${runId}`;
        const cents = (v: number) => Math.round(v * 100);
        const byProject = () => new Map<string | null, number>();
        const salaries = byProject();
        const contributions = byProject();
        let [net, pfDue, esiDue, ptDue, lwfDue, tdsDue, other] = [0, 0, 0, 0, 0, 0, 0];
        for (const l of lines) {
          const employer =
            (l.pf.eps ?? 0) +
            (l.pf.employerEpf ?? 0) +
            (l.pf.edli ?? 0) +
            (l.pf.admin ?? 0) +
            Number(l.esi_employer) +
            Number(l.lwf_employer);
          // Each cost to the projects by days, the last share taking what rounding leaves.
          const spread = (target: Map<string | null, number>, amount: number) => {
            const c = cents(amount);
            const total = l.split.reduce((s, x) => s + x.days, 0) || 1;
            let given = 0;
            l.split.forEach((x, i) => {
              const part = i === l.split.length - 1 ? c - given : Math.round((c * x.days) / total);
              given += part;
              target.set(x.projectId, (target.get(x.projectId) ?? 0) + part);
            });
          };
          spread(salaries, Number(l.gross));
          spread(contributions, employer);
          net += cents(Number(l.net));
          pfDue += cents(
            (l.pf.employee ?? 0) +
              (l.pf.eps ?? 0) +
              (l.pf.employerEpf ?? 0) +
              (l.pf.edli ?? 0) +
              (l.pf.admin ?? 0),
          );
          esiDue += cents(Number(l.esi_employee) + Number(l.esi_employer));
          ptDue += cents(Number(l.pt));
          lwfDue += cents(Number(l.lwf_employee) + Number(l.lwf_employer));
          tdsDue += cents(Number(l.tds));
          other += cents(l.deductions.reduce((s, d) => s + d.amount, 0));
        }
        const acct = (role: Parameters<LedgerService['roleAccount']>[2]) =>
          this.ledger.roleAccount(tx, x.entity_id, role);
        const line = (
          accountId: string,
          debit: number,
          credit: number,
          projectId: string | null,
        ): LineInput => ({
          accountId,
          partyId: null,
          debit: (debit / 100).toFixed(2),
          credit: (credit / 100).toFixed(2),
          projectId,
          siteId: null,
          costCodeId: null,
          note: `Payroll ${x.month}`,
        });
        const [salAcc, contribAcc, payableAcc, pfAcc, esiAcc, ptAcc, lwfAcc, tdsAcc] = [
          await acct('salaries'),
          await acct('pf_esi_contribution'),
          await acct('salaries_payable'),
          await acct('pf_payable'),
          await acct('esi_payable'),
          await acct('pt_payable'),
          await acct('lwf_payable'),
          await acct('tds_payable_salary'),
        ];
        const out: LineInput[] = [
          ...[...salaries.entries()]
            .filter(([, v]) => v > 0)
            .map(([p, v]) => line(salAcc, v, 0, p)),
          ...[...contributions.entries()]
            .filter(([, v]) => v > 0)
            .map(([p, v]) => line(contribAcc, v, 0, p)),
        ];
        // Deductions typed into the run (an advance recovered, say) reduce the staff advances.
        const advances = other > 0 ? await acct('staff_advances') : payableAcc;
        for (const [acc, v] of [
          [payableAcc, net],
          [advances, other],
          [pfAcc, pfDue],
          [esiAcc, esiDue],
          [ptAcc, ptDue],
          [lwfAcc, lwfDue],
          [tdsAcc, tdsDue],
        ] as const)
          if (v > 0) out.push(line(acc, 0, v, null));
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: x.entity_id,
            type: 'journal',
            date: lastDay(x.month),
            narration: `Payroll for ${x.month}`,
            reference: `Payroll ${x.month}`,
            lines: out,
          },
          { kind: 'payroll_run', id: runId },
        );
        await tx`UPDATE pay.run SET status = 'posted', voucher_id = ${v!.id}, row_version = row_version + 1
          WHERE id = ${runId}`;
        await audit(tx, claims.sub, 'payroll.post', 'run', runId, {});
      })
      .catch(fromDb);
    return this.get(claims, runId);
  }

  /** Net pay paid from a bank ledger (the bank's file is the run's CSV). */
  async pay(claims: TenantClaims, runId: string, input: { bankAccountId: string; date: string }) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [locked] = await tx`SELECT 1 FROM pay.run WHERE id = ${runId} FOR UPDATE`;
        if (!locked) throw new NotFoundException({ code: 'run_not_found' });
        const x = await this.run(tx, runId);
        if (x.status !== 'posted')
          throw new ConflictException({
            code: 'not_posted',
            message: 'Post the run before paying it.',
          });
        const [bank] = await tx<
          { kind: string }[]
        >`SELECT kind FROM acc.account WHERE id = ${input.bankAccountId}`;
        if (bank?.kind !== 'bank')
          throw new BadRequestException({
            code: 'not_bank',
            message: 'Salaries are paid from a bank ledger.',
          });
        const [t] = await tx<{ net: string }[]>`
          SELECT sum(net)::text AS net FROM pay.run_line WHERE run_id = ${runId}`;
        const payable = await this.ledger.roleAccount(tx, x.entity_id, 'salaries_payable');
        const line = (accountId: string, debit: string, credit: string): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId: null,
          siteId: null,
          costCodeId: null,
          note: `Salaries ${x.month}`,
        });
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: x.entity_id,
            type: 'payment',
            date: input.date,
            narration: `Salaries for ${x.month}`,
            reference: `Payroll ${x.month}`,
            lines: [line(payable, t!.net, '0'), line(input.bankAccountId, '0', t!.net)],
          },
          { kind: 'payroll_payment', id: runId },
        );
        await tx`UPDATE pay.run SET status = 'paid', payment_voucher_id = ${v!.id}, row_version = row_version + 1
          WHERE id = ${runId}`;
        await audit(tx, claims.sub, 'payroll.pay', 'run', runId, input);
      })
      .catch(fromDb);
    return this.get(claims, runId);
  }

  /** The bank's file: one row per employee paid, with their account and IFSC. */
  async bankFile(claims: TenantClaims, runId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const x = await this.run(db, runId);
    if (x.status === 'draft' || x.status === 'pending')
      throw new ConflictException({
        code: 'not_approved',
        message: 'The run is not approved yet.',
      });
    const rows = await db<
      { code: string; name: string; account: string | null; ifsc: string | null; net: string }[]
    >`
      SELECT e.code, e.name, e.bank_account AS account, e.bank_ifsc AS ifsc, l.net::text AS net
      FROM pay.run_line l JOIN hr.employee e ON e.id = l.employee_id
      WHERE l.run_id = ${runId} AND l.net > 0 ORDER BY lower(e.code)`;
    const missing = rows.filter((r) => !r.account || !r.ifsc).map((r) => r.code);
    if (missing.length)
      throw new ConflictException({
        code: 'no_bank_details',
        message: `No bank account or IFSC for ${missing.join(', ')}.`,
      });
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = [
      'Employee code,Name,Account number,IFSC,Amount,Narration',
      ...rows.map((r) =>
        [r.code, r.name, r.account!, r.ifsc!, r.net, `Salary ${x.month}`].map(cell).join(','),
      ),
    ].join('\r\n');
    return { fileName: `salaries-${x.month}.csv`, csv: `${csv}\r\n` };
  }

  /** One employee's payslip: theirs to see, or the payroll's. */
  async payslip(claims: TenantClaims, runId: string, employeeId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const own = (await this.hr.self(db, claims))?.id === employeeId;
    if (!own) await this.must(claims);
    const x = await this.run(db, runId);
    if (own && x.status === 'draft') throw new NotFoundException({ code: 'payslip_not_found' });
    const [l] = await db`
      SELECT e.code, e.name, d.name AS designation, e.department, e.pan, e.uan, e.esi_number AS "esiNumber",
        e.bank_account AS "bankAccount", to_char(e.joined_on, 'YYYY-MM-DD') AS "joinedOn",
        l.days::text AS days, l.payable_days::text AS "payableDays", l.earnings, l.deductions,
        l.gross::text AS gross, l.pf, l.esi_employee::text AS "esiEmployee", l.pt::text AS pt,
        l.lwf_employee::text AS "lwfEmployee", l.tds::text AS tds, l.net::text AS net, l.tax,
        en.name AS company
      FROM pay.run_line l JOIN hr.employee e ON e.id = l.employee_id
      LEFT JOIN hr.designation d ON d.id = e.designation_id
      JOIN platform.entity en ON en.id = e.entity_id
      WHERE l.run_id = ${runId} AND l.employee_id = ${employeeId}`;
    if (!l) throw new NotFoundException({ code: 'payslip_not_found' });
    return { month: x.month, status: x.status, ...l };
  }

  /** The signed-in employee's payslips. */
  async mine(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    const e = await this.hr.self(db, claims);
    if (!e) return [];
    return db`
      SELECT r.id AS "runId", to_char(r.month, 'YYYY-MM') AS month, l.net::text AS net
      FROM pay.run_line l JOIN pay.run r ON r.id = l.run_id
      WHERE l.employee_id = ${e.id} AND r.status <> 'draft' AND r.status <> 'pending' ORDER BY r.month DESC`;
  }
}
