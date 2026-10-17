// Payroll gaps (docs/wave8-plan.md step 8c.4): staff overtime approved by the day, loans and salary advances given
// from the bank and recovered in the runs, the old regime's tax declarations with their proofs, and the bonus due
// under the Payment of Bonus Act. The run itself pays the overtime, takes the instalments and counts the declarations.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { fromDb } from '../accounts/accounts-rules.js';
import { LedgerService } from '../accounts/ledger.service.js';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { bonus, declaredDeductions } from './payroll-rules.js';

@Injectable()
export class PayrollGapsService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
  ) {}

  private async must(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'payroll.run')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'payroll.run',
        message: 'Payroll needs the payroll permission.',
      });
  }

  // --- overtime ---

  async overtime(claims: TenantClaims, employeeId: string, month: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT id, to_char(day, 'YYYY-MM-DD') AS day, hours::text, reason FROM pay.overtime
      WHERE employee_id = ${employeeId} AND to_char(day, 'YYYY-MM') = ${month} ORDER BY day`;
  }

  private async monthOpen(
    db: Awaited<ReturnType<TenantConnections['forTenant']>>,
    employeeId: string,
    day: string,
  ) {
    const [run] = await db`
      SELECT 1 FROM pay.run r JOIN hr.employee e ON e.entity_id = r.entity_id
      WHERE e.id = ${employeeId} AND r.month = date_trunc('month', ${day}::date) AND r.status <> 'draft'`;
    if (run)
      throw new ConflictException({
        code: 'month_run',
        message: "That month's payroll is already submitted.",
      });
  }

  async addOvertime(
    claims: TenantClaims,
    employeeId: string,
    input: { day: string; hours: string; reason: string },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await this.monthOpen(db, employeeId, input.day);
    await db`
      INSERT INTO pay.overtime (employee_id, day, hours, reason, created_by)
      VALUES (${employeeId}, ${input.day}, ${input.hours}, ${input.reason}, ${claims.sub})`.catch(
      (err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'overtime_exists',
            message: 'Overtime is already entered for that day.',
          });
        return fromDb(err);
      },
    );
    return this.overtime(claims, employeeId, input.day.slice(0, 7));
  }

  async removeOvertime(claims: TenantClaims, id: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [o] = await db<{ employee_id: string; day: string }[]>`
      SELECT employee_id, to_char(day, 'YYYY-MM-DD') AS day FROM pay.overtime WHERE id = ${id}`;
    if (!o) throw new NotFoundException({ code: 'not_found' });
    await this.monthOpen(db, o.employee_id, o.day);
    await db`DELETE FROM pay.overtime WHERE id = ${id}`;
    return this.overtime(claims, o.employee_id, o.day.slice(0, 7));
  }

  // --- loans and advances ---

  async loans(claims: TenantClaims, employeeId: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT l.id, l.kind, l.principal::text, l.emi::text, to_char(l.first_month, 'YYYY-MM') AS "firstMonth",
        to_char(l.given_on, 'YYYY-MM-DD') AS "givenOn", l.note, v.number AS voucher,
        coalesce((SELECT sum((d->>'amount')::numeric) FROM pay.run_line x JOIN pay.run r ON r.id = x.run_id,
          jsonb_array_elements(x.deductions) d
          WHERE x.employee_id = l.employee_id AND r.status IN ('approved', 'posted', 'paid')
            AND d->>'loanId' = l.id::text), 0)::numeric(20,2)::text AS recovered
      FROM pay.loan l JOIN acc.voucher v ON v.id = l.voucher_id
      WHERE l.employee_id = ${employeeId} ORDER BY l.given_on DESC`;
  }

  /** A loan or advance given from the bank: staff advances Dr, the bank Cr; recovered by the EMI from its month. */
  async giveLoan(
    claims: TenantClaims,
    employeeId: string,
    input: {
      kind: 'loan' | 'advance';
      principal: string;
      emi: string;
      firstMonth: string;
      givenOn: string;
      bankAccountId: string;
      note: string;
    },
  ) {
    await this.must(claims);
    if (Number(input.emi) > Number(input.principal))
      throw new BadRequestException({
        code: 'emi_over_principal',
        message: 'The instalment is more than the loan.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const [e] = await tx<{ entity_id: string; name: string; code: string }[]>`
          SELECT entity_id, name, code FROM hr.employee WHERE id = ${employeeId}`;
        if (!e) throw new NotFoundException({ code: 'employee_not_found' });
        const [bank] = await tx<{ ok: boolean }[]>`
          SELECT kind IN ('bank', 'cash') AND NOT is_group AND closed_at IS NULL AS ok FROM acc.account
          WHERE id = ${input.bankAccountId}`;
        if (!bank?.ok)
          throw new BadRequestException({ code: 'not_a_bank', message: 'Pay from a bank ledger.' });
        const id = randomUUID();
        const note = `${input.kind === 'loan' ? 'Loan' : 'Salary advance'} to ${e.code} ${e.name}`;
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: e.entity_id,
            type: 'payment',
            date: input.givenOn,
            narration: input.note ? `${note}: ${input.note}` : note,
            reference: e.code,
            lines: [
              {
                accountId: await this.ledger.roleAccount(tx, e.entity_id, 'staff_advances'),
                partyId: null,
                debit: input.principal,
                credit: '0',
                projectId: null,
                siteId: null,
                costCodeId: null,
                note,
              },
              {
                accountId: input.bankAccountId,
                partyId: null,
                debit: '0',
                credit: input.principal,
                projectId: null,
                siteId: null,
                costCodeId: null,
                note,
              },
            ],
          },
          { kind: 'staff_loan', id },
        );
        await tx`
          INSERT INTO pay.loan (id, employee_id, kind, principal, emi, first_month, given_on, bank_account_id, voucher_id,
            note, created_by)
          VALUES (${id}, ${employeeId}, ${input.kind}, ${input.principal}, ${input.emi}, ${`${input.firstMonth}-01`},
            ${input.givenOn}, ${input.bankAccountId}, ${v!.id}, ${input.note}, ${claims.sub})`;
        await audit(tx, claims.sub, 'payroll.loan', 'employee', employeeId, { ...input });
      })
      .catch(fromDb);
    return this.loans(claims, employeeId);
  }

  // --- tax declarations (old regime) ---

  async declarations(claims: TenantClaims, employeeId: string, fyStart: number) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<
      {
        id: string;
        section: string;
        description: string;
        declared: string;
        proved: string | null;
        verifiedAt: string | null;
      }[]
    >`
      SELECT id, section, description, declared::text, proved::text,
        to_char(verified_at, 'YYYY-MM-DD') AS "verifiedAt"
      FROM pay.tax_declaration WHERE employee_id = ${employeeId} AND fy_start = ${fyStart}
      ORDER BY section, description`;
    return {
      employeeId,
      fyStart,
      rows,
      counted: declaredDeductions(
        rows.map((r) => ({
          section: r.section,
          declared: Number(r.declared),
          proved: r.proved === null ? null : Number(r.proved),
        })),
      ).toFixed(2),
    };
  }

  async declare(
    claims: TenantClaims,
    employeeId: string,
    input: { fyStart: number; section: string; description: string; declared: string },
  ) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db`
      INSERT INTO pay.tax_declaration (employee_id, fy_start, section, description, declared)
      VALUES (${employeeId}, ${input.fyStart}, ${input.section}, ${input.description}, ${input.declared})
      ON CONFLICT (employee_id, fy_start, section, description) DO UPDATE SET declared = EXCLUDED.declared`.catch(
      fromDb,
    );
    return this.declarations(claims, employeeId, input.fyStart);
  }

  /** Payroll records what the proof shows. */
  async verify(claims: TenantClaims, id: string, proved: string) {
    await this.must(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const [d] = await db<{ employee_id: string; fy_start: number }[]>`
      UPDATE pay.tax_declaration SET proved = ${proved}, verified_by = ${claims.sub}, verified_at = now()
      WHERE id = ${id} RETURNING employee_id, fy_start`;
    if (!d) throw new NotFoundException({ code: 'not_found' });
    return this.declarations(claims, d.employee_id, d.fy_start);
  }

  // --- bonus ---

  /** The Payment of Bonus Act for a financial year, from the runs: each employee's months, base and bonus. */
  async bonus(claims: TenantClaims, q: { entityId: string; fyStart: number; pct: number }) {
    await this.must(claims);
    if (q.pct < 8.33 || q.pct > 20)
      throw new BadRequestException({
        code: 'bad_pct',
        message: 'Bonus is 8.33% at least and 20% at most.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db<
      { employee_id: string; code: string; name: string; wages: string; days: string }[]
    >`
      SELECT l.employee_id, e.code, e.name, l.wages::text, l.payable_days::text AS days
      FROM pay.run_line l JOIN pay.run r ON r.id = l.run_id JOIN hr.employee e ON e.id = l.employee_id
      WHERE r.entity_id = ${q.entityId} AND r.status IN ('approved', 'posted', 'paid')
        AND r.month BETWEEN ${`${q.fyStart}-04-01`} AND ${`${q.fyStart + 1}-03-01`}
      ORDER BY lower(e.code), r.month`;
    const by = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) by.set(r.employee_id, [...(by.get(r.employee_id) ?? []), r]);
    const employees = [...by.values()].map((list) => {
      const b = bonus(
        list.map((r) => ({ wages: Number(r.wages), days: Number(r.days) })),
        q.pct,
      );
      return {
        employeeId: list[0]!.employee_id,
        code: list[0]!.code,
        name: list[0]!.name,
        months: list.length,
        ...b,
      };
    });
    return {
      ...q,
      employees,
      total: employees.reduce((s, e) => s + e.bonus, 0),
    };
  }
}
