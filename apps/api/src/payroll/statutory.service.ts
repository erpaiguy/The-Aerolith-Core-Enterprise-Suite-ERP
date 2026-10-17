// Payroll's statutory returns and the full and final settlement (docs/wave3-plan.md step 12b): the PF ECR file and
// the ESI contribution data from an approved run, each employee's year for Form 16 (Form 130 under the Income-tax
// Act, 2025) with the TDS by quarter, and the settlement when someone leaves (gratuity, leave encashment, notice),
// posted and paid.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import type { Sql, TransactionSql } from 'postgres';
import { fromDb } from '../accounts/accounts-rules.js';
import { LedgerService, type LineInput } from '../accounts/ledger.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { HrService } from '../hr/hr.service.js';
import { LeaveService } from '../hr/leave.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { wagesOf, type WagesRule } from './payroll-rules.js';
import { ecrLine, encashment, gratuity, noticePay, type GratuityRule } from './statutory.js';

type Db = Sql | TransactionSql;

interface Pf {
  epfWages?: number;
  epsWages?: number;
  edliWages?: number;
  employee?: number;
  eps?: number;
  employerEpf?: number;
}

@Injectable()
export class StatutoryService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
    private readonly hr: HrService,
    private readonly leave: LeaveService,
  ) {}

  private async must(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'payroll.run')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'payroll.run',
        message: 'Payroll needs the payroll permission.',
      });
  }

  private async approvedRun(db: Db, runId: string) {
    const [r] = await db<{ month: string; status: string; entity_id: string }[]>`
      SELECT to_char(month, 'YYYY-MM') AS month, status, entity_id FROM pay.run WHERE id = ${runId}`;
    if (!r) throw new NotFoundException({ code: 'run_not_found' });
    if (r.status === 'draft' || r.status === 'pending')
      throw new ConflictException({
        code: 'not_approved',
        message: 'The run is not approved yet.',
      });
    return r;
  }

  /** The EPFO's ECR text file for the run's month: a line for each member, and who could not be filed and why. */
  async ecr(claims: TenantClaims, runId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const run = await this.approvedRun(db, runId);
    const rows = await db<
      {
        code: string;
        name: string;
        uan: string | null;
        gross: string;
        days: string;
        payable_days: string;
        pf: Pf;
      }[]
    >`
      SELECT e.code, e.name, e.uan, l.gross::text, l.days::text, l.payable_days::text, l.pf
      FROM pay.run_line l JOIN hr.employee e ON e.id = l.employee_id
      WHERE l.run_id = ${runId} AND l.pf <> '{}'::jsonb ORDER BY lower(e.code)`;
    const missing = rows.filter((r) => !r.uan).map((r) => r.code);
    const lines = rows
      .filter((r) => r.uan)
      .map((r) =>
        ecrLine({
          uan: r.uan!,
          name: r.name,
          gross: Number(r.gross),
          epfWages: r.pf.epfWages ?? 0,
          epsWages: r.pf.epsWages ?? 0,
          edliWages: r.pf.edliWages ?? 0,
          employee: r.pf.employee ?? 0,
          eps: r.pf.eps ?? 0,
          employerEpf: r.pf.employerEpf ?? 0,
          ncpDays: Math.round(Number(r.days) - Number(r.payable_days)),
        }),
      );
    return {
      fileName: `ECR-${run.month}.txt`,
      text: lines.length ? `${lines.join('\n')}\n` : '',
      members: lines.length,
      withoutUan: missing,
    };
  }

  /** The ESIC's monthly contribution upload: IP number, name, days paid, wages, reason (0 when days were paid). */
  async esi(claims: TenantClaims, runId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const run = await this.approvedRun(db, runId);
    const rows = await db<
      {
        code: string;
        name: string;
        esi_number: string | null;
        payable_days: string;
        gross: string;
        esi_employee: string;
        esi_employer: string;
      }[]
    >`
      SELECT e.code, e.name, e.esi_number, l.payable_days::text, l.gross::text, l.esi_employee::text,
        l.esi_employer::text
      FROM pay.run_line l JOIN hr.employee e ON e.id = l.employee_id
      WHERE l.run_id = ${runId} AND (l.esi_employee > 0 OR l.esi_employer > 0) ORDER BY lower(e.code)`;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('MC');
    ws.addRow([
      'IP Number',
      'IP Name',
      'No of Days for which wages paid',
      'Total Monthly Wages',
      'Reason Code',
      'Last Working Day',
    ]);
    for (const r of rows)
      ws.addRow([
        r.esi_number ?? '',
        r.name,
        Math.floor(Number(r.payable_days)),
        Math.round(Number(r.gross)),
        Number(r.payable_days) > 0 ? 0 : 1,
        '',
      ]);
    return {
      fileName: `ESI-${run.month}.xlsx`,
      buffer: Buffer.from(await wb.xlsx.writeBuffer()),
      rows: rows.map((r) => ({
        code: r.code,
        name: r.name,
        ipNumber: r.esi_number,
        days: Math.floor(Number(r.payable_days)),
        wages: Math.round(Number(r.gross)),
        employee: r.esi_employee,
        employer: r.esi_employer,
      })),
    };
  }

  /**
   * Each employee's financial year for Form 16 (Form 130): gross pay, the standard deduction, declared deductions under
   * the old regime, the taxable income, and TDS by quarter, from the approved runs.
   */
  async yearForm(claims: TenantClaims, entityId: string, fyStartYear: number) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const from = `${fyStartYear}-04-01`;
    const to = `${fyStartYear + 1}-03-01`;
    const rows = await db<
      {
        employee_id: string;
        code: string;
        name: string;
        pan: string | null;
        month: string;
        gross: string;
        taxable: string;
        tds: string;
        tax: { regime?: string };
      }[]
    >`
      SELECT l.employee_id, e.code, e.name, e.pan, to_char(r.month, 'YYYY-MM') AS month, l.gross::text,
        l.taxable::text, l.tds::text, l.tax
      FROM pay.run_line l JOIN pay.run r ON r.id = l.run_id JOIN hr.employee e ON e.id = l.employee_id
      WHERE r.entity_id = ${entityId} AND r.status IN ('approved', 'posted', 'paid') AND r.month BETWEEN ${from} AND ${to}
      ORDER BY lower(e.code), r.month`;
    const [taxRule] = await db<
      { data: { new: { standardDeduction: number }; old: { standardDeduction: number } } }[]
    >`
      SELECT data FROM pay.rule WHERE kind = 'income_tax' AND effective_from <= ${`${fyStartYear + 1}-03-31`}
      ORDER BY effective_from DESC LIMIT 1`;
    const quarter = (month: string) => {
      const m = Number(month.slice(5, 7));
      return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 ? 'Q3' : 'Q4';
    };
    const by = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) by.set(r.employee_id, [...(by.get(r.employee_id) ?? []), r]);
    const out = [];
    for (const [employeeId, list] of by) {
      const regime = (list[list.length - 1]!.tax.regime ?? 'new') as 'new' | 'old';
      const [sal] = await db<{ old_deductions: string }[]>`
        SELECT old_deductions::text FROM pay.salary WHERE employee_id = ${employeeId} AND from_date <= ${`${fyStartYear + 1}-03-31`}
        ORDER BY from_date DESC LIMIT 1`;
      const gross = list.reduce((s, r) => s + Number(r.taxable), 0);
      const standard = taxRule ? taxRule.data[regime].standardDeduction : 0;
      const declared = regime === 'old' ? Number(sal?.old_deductions ?? 0) : 0;
      const tds = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
      for (const r of list) tds[quarter(r.month)] += Number(r.tds);
      out.push({
        employeeId,
        code: list[0]!.code,
        name: list[0]!.name,
        pan: list[0]!.pan,
        regime,
        months: list.length,
        grossSalary: gross.toFixed(2),
        standardDeduction: standard.toFixed(2),
        declaredDeductions: declared.toFixed(2),
        taxableIncome: Math.max(0, gross - standard - declared).toFixed(2),
        tdsByQuarter: Object.fromEntries(Object.entries(tds).map(([q, v]) => [q, v.toFixed(2)])),
        tds: Object.values(tds)
          .reduce((s, v) => s + v, 0)
          .toFixed(2),
      });
    }
    return {
      financialYear: `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, '0')}`,
      employees: out,
    };
  }

  // --- statutory payments and returns (docs/wave8-plan.md step 8c.3) ---

  /** What a run owes under each head, as its voucher credited it, and the challans that paid it. */
  private async dues(db: Db, runId: string) {
    const [d] = await db<{ pf: string; esi: string; pt: string; lwf: string }[]>`
      SELECT
        coalesce(sum(coalesce((pf->>'employee')::numeric, 0) + coalesce((pf->>'eps')::numeric, 0)
          + coalesce((pf->>'employerEpf')::numeric, 0) + coalesce((pf->>'edli')::numeric, 0)
          + coalesce((pf->>'admin')::numeric, 0)), 0)::numeric(20,2)::text AS pf,
        coalesce(sum(esi_employee + esi_employer), 0)::numeric(20,2)::text AS esi,
        coalesce(sum(pt), 0)::numeric(20,2)::text AS pt,
        coalesce(sum(lwf_employee + lwf_employer), 0)::numeric(20,2)::text AS lwf
      FROM pay.run_line WHERE run_id = ${runId}`;
    const paid = await db<{ kind: 'pf' | 'esi' | 'pt' | 'lwf'; amount: string }[]>`
      SELECT kind, sum(amount)::numeric(20,2)::text AS amount FROM pay.statutory_challan WHERE run_id = ${runId}
      GROUP BY kind`;
    const challans = await db`
      SELECT c.id, c.kind, c.reference, c.amount::text, to_char(c.paid_on, 'YYYY-MM-DD') AS "paidOn", v.number AS voucher
      FROM pay.statutory_challan c JOIN acc.voucher v ON v.id = c.voucher_id WHERE c.run_id = ${runId}
      ORDER BY c.paid_on, c.kind`;
    return {
      heads: (['pf', 'esi', 'pt', 'lwf'] as const).map((k) => {
        const p = paid.find((x) => x.kind === k)?.amount ?? '0.00';
        return { kind: k, due: d![k], paid: p, left: (Number(d![k]) - Number(p)).toFixed(2) };
      }),
      challans,
    };
  }

  async statutory(claims: TenantClaims, runId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.approvedRun(db, runId);
    return { runId, month: r.month, ...(await this.dues(db, runId)) };
  }

  /** A challan for one head of a run: its payable Dr, the bank Cr. */
  async payStatutory(
    claims: TenantClaims,
    runId: string,
    input: {
      kind: 'pf' | 'esi' | 'pt' | 'lwf';
      reference: string;
      amount: string;
      paidOn: string;
      bankAccountId: string;
    },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [r] = await tx<{ month: string; status: string; entity_id: string }[]>`
          SELECT to_char(month, 'YYYY-MM') AS month, status, entity_id FROM pay.run WHERE id = ${runId} FOR UPDATE`;
        if (!r) throw new NotFoundException({ code: 'run_not_found' });
        if (!['posted', 'paid'].includes(r.status))
          throw new ConflictException({
            code: 'not_posted',
            message: 'Post the run before paying its dues.',
          });
        const [dup] = await tx`
          SELECT 1 FROM pay.statutory_challan WHERE kind = ${input.kind} AND reference = ${input.reference}`;
        if (dup)
          throw new ConflictException({
            code: 'challan_exists',
            message: 'This challan is already entered.',
          });
        const head = (await this.dues(tx, runId)).heads.find((h) => h.kind === input.kind)!;
        if (Number(input.amount) > Number(head.left) + 0.005)
          throw new BadRequestException({
            code: 'over_due',
            message: `₹${head.left} of ${input.kind.toUpperCase()} is left to pay for ${r.month}.`,
          });
        const [bank] = await tx<{ ok: boolean }[]>`
          SELECT kind IN ('bank', 'cash') AND NOT is_group AND closed_at IS NULL AS ok FROM acc.account
          WHERE id = ${input.bankAccountId}`;
        if (!bank?.ok)
          throw new BadRequestException({ code: 'not_a_bank', message: 'Pay from a bank ledger.' });
        const role = (
          { pf: 'pf_payable', esi: 'esi_payable', pt: 'pt_payable', lwf: 'lwf_payable' } as const
        )[input.kind];
        const line = (accountId: string, debit: string, credit: string): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId: null,
          siteId: null,
          costCodeId: null,
          note: `${input.kind.toUpperCase()} ${r.month}`,
        });
        const id = randomUUID();
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: r.entity_id,
            type: 'payment',
            date: input.paidOn,
            narration: `${input.kind.toUpperCase()} for ${r.month}: ${input.reference}`,
            reference: input.reference,
            lines: [
              line(await this.ledger.roleAccount(tx, r.entity_id, role), input.amount, '0'),
              line(input.bankAccountId, '0', input.amount),
            ],
          },
          { kind: 'statutory_challan', id },
        );
        await tx`
          INSERT INTO pay.statutory_challan (id, run_id, kind, reference, amount, paid_on, bank_account_id, voucher_id,
            created_by)
          VALUES (${id}, ${runId}, ${input.kind}, ${input.reference}, ${input.amount}, ${input.paidOn},
            ${input.bankAccountId}, ${v!.id}, ${claims.sub})`;
        await audit(tx, claims.sub, 'payroll.statutory_challan', 'pay_run', runId, { ...input });
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'challan_exists',
            message: 'This challan is already entered.',
          });
        return fromDb(err);
      });
    return this.statutory(claims, runId);
  }

  /**
   * The Maharashtra professional tax return (Form III) for a month: employees by the tax each bore, and the total.
   * [Guessing] The slabs are whatever the run's rules deducted; the return form is the state's to confirm.
   */
  async ptReturn(claims: TenantClaims, runId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const r = await this.approvedRun(db, runId);
    const slabs = await db<{ rate: string; employees: number; gross: string; tax: string }[]>`
      SELECT l.pt::numeric(20,2)::text AS rate, count(*)::int AS employees,
        sum(l.gross)::numeric(20,2)::text AS gross, sum(l.pt)::numeric(20,2)::text AS tax
      FROM pay.run_line l WHERE l.run_id = ${runId} GROUP BY l.pt ORDER BY l.pt`;
    const [e] = await db<{ name: string; legal_name: string | null }[]>`
      SELECT name, legal_name FROM platform.entity WHERE id = ${r.entity_id}`;
    return {
      month: r.month,
      employer: e!.legal_name ?? e!.name,
      slabs,
      employees: slabs.reduce((t, x) => t + x.employees, 0),
      tax: slabs.reduce((t, x) => t + Number(x.tax), 0).toFixed(2),
      paid: (await this.dues(db, runId)).heads.find((h) => h.kind === 'pt')!.paid,
    };
  }

  /**
   * Form 16 Part B (Form 130 under the Income-tax Act, 2025) and Form 12BA for an employee's year: the salary, the
   * deductions, the tax deducted by quarter with the challans that deposited it. No perquisites are paid through
   * payroll, so 12BA states none.
   */
  async form16(claims: TenantClaims, entityId: string, fyStartYear: number, employeeId: string) {
    const year = await this.yearForm(claims, entityId, fyStartYear);
    const emp = year.employees.find((x) => x.employeeId === employeeId);
    if (!emp)
      throw new NotFoundException({
        code: 'no_salary',
        message: 'This employee had no salary in the year.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db<
      {
        name: string;
        legal_name: string | null;
        tan: string | null;
        pan: string | null;
        address: string | null;
      }[]
    >`SELECT name, legal_name, tan, pan, address FROM platform.entity WHERE id = ${entityId}`;
    const challans = await db`
      SELECT to_char(r.month, 'YYYY-MM') AS month, l.tds::text AS tds, c.bsr_code AS "bsrCode", c.challan_no AS "challanNo",
        to_char(c.deposited_on, 'YYYY-MM-DD') AS "depositedOn"
      FROM pay.run_line l JOIN pay.run r ON r.id = l.run_id
      LEFT JOIN acc.tds_salary_challan_line s ON s.run_id = r.id LEFT JOIN acc.tds_challan c ON c.id = s.challan_id
      WHERE l.employee_id = ${employeeId} AND r.entity_id = ${entityId} AND l.tds > 0
        AND r.month BETWEEN ${`${fyStartYear}-04-01`} AND ${`${fyStartYear + 1}-03-01`}
      ORDER BY r.month`;
    return {
      financialYear: year.financialYear,
      employer: { name: e!.legal_name ?? e!.name, tan: e!.tan, pan: e!.pan, address: e!.address },
      employee: emp,
      challans,
      perquisites: [],
    };
  }

  // --- full and final ---

  /**
   * Works out (or works again, while a draft) a leaver's settlement: gratuity on the last salary's wages and years
   * counted, earned leave encashed, notice paid or recovered. The leaving date is the employee record's.
   */
  async settle(
    claims: TenantClaims,
    employeeId: string,
    input: { reason: string; noticeDays: string; leaveTypeCode: string | null },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM hr.employee WHERE id = ${employeeId} FOR UPDATE`;
      const e = await this.hr.employee(tx, employeeId);
      if (!e.left_on)
        throw new BadRequestException({
          code: 'not_leaving',
          message: `Record ${e.name}'s leaving date first.`,
        });
      const [existing] = await tx<{ status: string }[]>`
        SELECT status FROM pay.settlement WHERE employee_id = ${employeeId}`;
      if (existing && existing.status !== 'draft')
        throw new ConflictException({
          code: 'settled',
          message: 'The settlement is already posted.',
        });
      const [sal] = await tx<{ id: string }[]>`
        SELECT id FROM pay.salary WHERE employee_id = ${employeeId} AND from_date <= ${e.left_on}
        ORDER BY from_date DESC LIMIT 1`;
      if (!sal)
        throw new BadRequestException({ code: 'no_salary', message: `${e.name} has no salary.` });
      const lines = await tx<
        {
          amount: string | null;
          percent_of_basic: string | null;
          code: string;
          in_wages: boolean;
        }[]
      >`
        SELECT l.amount::text, l.percent_of_basic::text, c.code, c.in_wages FROM pay.salary_line l
        JOIN pay.component c ON c.id = l.component_id WHERE l.salary_id = ${sal.id}`;
      const basic = Number(lines.find((l) => l.code === 'BASIC')?.amount ?? 0);
      const pay = lines.map((l) => ({
        amount:
          l.amount !== null
            ? Number(l.amount)
            : Math.round((basic * Number(l.percent_of_basic)) / 100),
        inWages: l.in_wages,
      }));
      const monthlyGross = pay.reduce((s, l) => s + l.amount, 0);
      const [wagesRule] = await tx<{ data: WagesRule }[]>`
        SELECT data FROM pay.rule WHERE kind = 'wages' AND effective_from <= ${e.left_on}
        ORDER BY effective_from DESC LIMIT 1`;
      // Gratuity and encashment are on wages: basic and dearness (and the excess under the 50% rule).
      const wages = wagesRule
        ? wagesOf(pay, wagesRule.data)
        : pay.filter((l) => l.inWages).reduce((s, l) => s + l.amount, 0);
      const [rule] = await tx<{ data: GratuityRule }[]>`
        SELECT data FROM pay.rule WHERE kind = 'gratuity' AND effective_from <= ${e.left_on}
        ORDER BY effective_from DESC LIMIT 1`;
      const [ft] = await tx<
        { fixed_term: boolean }[]
      >`SELECT fixed_term FROM hr.employee WHERE id = ${employeeId}`;
      const g = rule
        ? gratuity({
            wages,
            joinedOn: e.joined_on,
            lastDay: e.left_on,
            fixedTerm: ft!.fixed_term,
            rule: rule.data,
          })
        : { years: 0, amount: 0 };
      let leaveDays = 0;
      if (input.leaveTypeCode) {
        const year = Number(e.left_on.slice(0, 4));
        const balances = await this.leave.balances(tx, e, year, e.left_on);
        const b = balances.find((x) => x.code === input.leaveTypeCode);
        if (!b)
          throw new BadRequestException({
            code: 'leave_type_not_found',
            message: 'No such leave type.',
          });
        leaveDays = Math.max(0, Number(b.available ?? 0));
      }
      const enc = encashment(leaveDays, wages);
      const notice = noticePay(Number(input.noticeDays), monthlyGross);
      const total = g.amount + enc + notice;
      await tx`
        INSERT INTO pay.settlement (employee_id, last_day, reason, wages, monthly_gross, years, gratuity, leave_days,
          encashment, notice_days, notice_amount, total, created_by)
        VALUES (${employeeId}, ${e.left_on}, ${input.reason}, ${wages}, ${monthlyGross}, ${g.years}, ${g.amount},
          ${leaveDays}, ${enc}, ${input.noticeDays}, ${notice}, ${total}, ${claims.sub})
        ON CONFLICT (employee_id) DO UPDATE SET last_day = EXCLUDED.last_day, reason = EXCLUDED.reason,
          wages = EXCLUDED.wages, monthly_gross = EXCLUDED.monthly_gross, years = EXCLUDED.years,
          gratuity = EXCLUDED.gratuity, leave_days = EXCLUDED.leave_days, encashment = EXCLUDED.encashment,
          notice_days = EXCLUDED.notice_days, notice_amount = EXCLUDED.notice_amount, total = EXCLUDED.total,
          row_version = pay.settlement.row_version + 1`;
      await audit(tx, claims.sub, 'payroll.settle', 'employee', employeeId, { ...input, total });
    });
    return this.settlement(claims, employeeId);
  }

  async settlement(claims: TenantClaims, employeeId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [s] = await db`
      SELECT s.id, s.employee_id AS "employeeId", to_char(s.last_day, 'YYYY-MM-DD') AS "lastDay", s.reason,
        s.wages::text, s.monthly_gross::text AS "monthlyGross", s.years, s.gratuity::text,
        s.leave_days::text AS "leaveDays", s.encashment::text, s.notice_days::text AS "noticeDays",
        s.notice_amount::text AS "noticeAmount", s.total::text, s.status,
        (SELECT number FROM acc.voucher WHERE id = s.voucher_id) AS voucher,
        (SELECT number FROM acc.voucher WHERE id = s.payment_voucher_id) AS payment
      FROM pay.settlement s WHERE s.employee_id = ${employeeId}`;
    return s ?? null;
  }

  /** Posted on the last day: the cost (to the project the employee last worked on) owed to them. */
  async postSettlement(claims: TenantClaims, employeeId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [s] = await tx<{ id: string; status: string; total: string; last_day: string }[]>`
          SELECT id, status, total::text, to_char(last_day, 'YYYY-MM-DD') AS last_day FROM pay.settlement
          WHERE employee_id = ${employeeId} FOR UPDATE`;
        if (!s) throw new NotFoundException({ code: 'settlement_not_found' });
        if (s.status !== 'draft')
          throw new ConflictException({ code: 'settled', message: 'Already posted.' });
        if (Number(s.total) <= 0)
          throw new ConflictException({
            code: 'nothing_owed',
            message: "Nothing is owed; recover the notice from the last month's pay instead.",
          });
        const e = await this.hr.employee(tx, employeeId);
        const [place] = await tx<{ project_id: string | null }[]>`
          SELECT project_id FROM hr.deployment WHERE employee_id = ${employeeId} AND from_date <= ${s.last_day}
          ORDER BY from_date DESC LIMIT 1`;
        const line = (
          accountId: string,
          debit: string,
          credit: string,
          projectId: string | null,
        ): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId,
          siteId: null,
          costCodeId: null,
          note: `Full and final, ${e.code}`,
        });
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: e.entity_id,
            type: 'journal',
            date: s.last_day,
            narration: `Full and final settlement of ${e.name}`,
            reference: `F&F ${e.code}`,
            lines: [
              line(
                await this.ledger.roleAccount(tx, e.entity_id, 'salaries'),
                s.total,
                '0',
                place?.project_id ?? null,
              ),
              line(
                await this.ledger.roleAccount(tx, e.entity_id, 'salaries_payable'),
                '0',
                s.total,
                null,
              ),
            ],
          },
          { kind: 'payroll_settlement', id: s.id },
        );
        await tx`UPDATE pay.settlement SET status = 'posted', voucher_id = ${v!.id}, row_version = row_version + 1
          WHERE id = ${s.id}`;
        await audit(tx, claims.sub, 'payroll.settlement_post', 'employee', employeeId, {});
      })
      .catch(fromDb);
    return this.settlement(claims, employeeId);
  }
}
