// TDS returns and certificates (docs/wave8-plan.md step 8b.3): suppliers' lower-deduction certificates (section 197);
// salary TDS (section 192) from the payroll runs, deposited by challan; the quarter's 24Q; Form 16A for a supplier from
// the 26Q data; and the 26Q and 24Q as caret-separated text in the layout of the NSDL file format.
// [Guessing] The text layout follows the published file format as far as this code knows it; the free File
// Validation Utility (FVU) is the judge, and every file goes through it before upload.
import { randomUUID } from 'node:crypto';
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
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt } from '../rates/decimal.js';
import { audit } from '../tender/tender-records.js';
import { fromDb } from './accounts-rules.js';
import { monthRange } from './gst.service.js';
import { LedgerService, type LineInput } from './ledger.service.js';
import { quarterRange, TdsReturnService } from './tds-returns.service.js';

type Db = Sql | TransactionSql;
const money = (v: bigint) => fmt(v, 2);

/** The section as the return's section code writes it. */
export const SECTION_CODE: Record<string, string> = {
  '194C': '94C',
  '194J': '94J',
  '194I': '4IB',
  '194Q': '94Q',
  '192': '92B',
};

/** dd-mm-yyyy → the file's ddmmyyyy. */
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}`;

export interface Deductor {
  name: string;
  legalName: string | null;
  tan: string | null;
  pan: string | null;
  address: string | null;
  city: string | null;
  pincode: string | null;
  stateCode: string | null;
}

@Injectable()
export class TdsStatementService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
    private readonly tds: TdsReturnService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          p === 'accounts.view'
            ? 'TDS needs the accounts permission.'
            : 'This needs the permission to post.',
      });
  }

  private async deductor(db: Db, entityId: string) {
    const [d] = await db<Deductor[]>`
      SELECT name, legal_name AS "legalName", tan, pan, address, city, pincode, state_code AS "stateCode"
      FROM platform.entity WHERE id = ${entityId}`;
    if (!d) throw new NotFoundException({ code: 'company_not_found' });
    return d;
  }

  // --- lower-deduction certificates (section 197) ---

  async certificates(claims: TenantClaims, entityId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT c.id, c.section, c.cert_no AS "certNo", c.rate::text AS rate, c.limit_amount::text AS "limit",
        to_char(c.valid_from, 'YYYY-MM-DD') AS "validFrom", to_char(c.valid_to, 'YYYY-MM-DD') AS "validTo",
        json_build_object('id', p.id, 'name', p.name, 'pan', p.pan) AS party,
        coalesce((SELECT sum(b.tds_base) FROM acc.vendor_bill b WHERE b.tds_certificate_id = c.id
          AND b.status <> 'cancelled'), 0)::text AS used
      FROM acc.tds_certificate c JOIN platform.party p ON p.id = c.party_id
      WHERE c.entity_id = ${entityId} ORDER BY p.name, c.valid_from DESC`;
  }

  async addCertificate(
    claims: TenantClaims,
    input: {
      entityId: string;
      partyId: string;
      section: string;
      certNo: string;
      rate: string;
      limit: string;
      validFrom: string;
      validTo: string;
    },
  ) {
    await this.may(claims, 'accounts.post');
    if (input.validTo < input.validFrom)
      throw new BadRequestException({
        code: 'bad_validity',
        message: 'A certificate ends on or after it starts.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db`
      INSERT INTO acc.tds_certificate (entity_id, party_id, section, cert_no, rate, limit_amount, valid_from, valid_to,
        created_by)
      VALUES (${input.entityId}, ${input.partyId}, ${input.section}, ${input.certNo}, ${input.rate}, ${input.limit},
        ${input.validFrom}, ${input.validTo}, ${claims.sub})`.catch((err: unknown) => {
      if ((err as { code?: string }).code === '23505')
        throw new ConflictException({
          code: 'certificate_exists',
          message: 'This certificate is already entered.',
        });
      return fromDb(err);
    });
    return this.certificates(claims, input.entityId);
  }

  // --- salary TDS (section 192) ---

  private salaryRuns(db: Db, entityId: string, from: string, to: string) {
    return db<
      {
        runId: string;
        month: string;
        tds: string;
        challan: { id: string; bsrCode: string; challanNo: string; depositedOn: string } | null;
      }[]
    >`
      SELECT r.id AS "runId", to_char(r.month, 'YYYY-MM') AS month,
        (SELECT coalesce(sum(l.tds), 0) FROM pay.run_line l WHERE l.run_id = r.id)::text AS tds,
        CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'bsrCode', c.bsr_code, 'challanNo',
          c.challan_no, 'depositedOn', to_char(c.deposited_on, 'YYYY-MM-DD')) END AS challan
      FROM pay.run r LEFT JOIN acc.tds_salary_challan_line s ON s.run_id = r.id
      LEFT JOIN acc.tds_challan c ON c.id = s.challan_id
      WHERE r.entity_id = ${entityId} AND r.status IN ('posted', 'paid') AND r.month BETWEEN ${from} AND ${to}
      ORDER BY r.month`;
  }

  /** A month's salary TDS deposited: TDS payable on salaries Dr, interest and fee Dr, the bank Cr. */
  async salaryChallan(
    claims: TenantClaims,
    input: {
      entityId: string;
      period: string;
      depositedOn: string;
      bsrCode: string;
      challanNo: string;
      interest: string;
      fee: string;
      bankAccountId: string;
    },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const { from } = monthRange(input.period);
    if (input.depositedOn < from)
      throw new BadRequestException({
        code: 'before_deduction',
        message: 'A challan is deposited after the month it pays for begins.',
      });
    const id = await db
      .begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'tds ' + input.entityId}))`;
        const [run] = await this.salaryRuns(tx, input.entityId, from, from);
        if (!run || run.challan || !dec(run.tds))
          throw new BadRequestException({
            code: 'nothing_to_deposit',
            message: `No salary TDS of ${input.period} is left to deposit.`,
          });
        const [bank] = await tx<{ ok: boolean }[]>`
          SELECT kind IN ('bank', 'cash') AND NOT is_group AND closed_at IS NULL AS ok FROM acc.account
          WHERE id = ${input.bankAccountId}`;
        if (!bank?.ok)
          throw new BadRequestException({ code: 'not_a_bank', message: 'Pay from a bank ledger.' });
        const tax = dec(run.tds);
        const extra = dec(input.interest) + dec(input.fee);
        const line = (
          accountId: string,
          debit: string,
          credit: string,
          note: string,
        ): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId: null,
          siteId: null,
          costCodeId: null,
          note,
        });
        const challanId = randomUUID();
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: input.entityId,
            type: 'payment',
            date: input.depositedOn,
            narration: `TDS 192 for ${input.period}: challan ${input.bsrCode}/${input.challanNo}`,
            reference: `${input.bsrCode}/${input.challanNo}`,
            lines: [
              line(
                await this.ledger.roleAccount(tx, input.entityId, 'tds_payable_salary'),
                money(tax),
                '0',
                'TDS 192',
              ),
              ...(extra
                ? [
                    line(
                      await this.ledger.roleAccount(tx, input.entityId, 'tds_interest'),
                      money(extra),
                      '0',
                      'Interest and fee',
                    ),
                  ]
                : []),
              line(input.bankAccountId, '0', money(tax + extra), 'TDS challan'),
            ],
          },
          { kind: 'tds_challan', id: challanId },
        );
        await tx`
          INSERT INTO acc.tds_challan (id, entity_id, section, period, deposited_on, bsr_code, challan_no, tax, interest, fee,
            total, bank_account_id, voucher_id, created_by)
          VALUES (${challanId}, ${input.entityId}, '192', ${input.period}, ${input.depositedOn}, ${input.bsrCode},
            ${input.challanNo}, ${money(tax)}, ${input.interest}, ${input.fee}, ${money(tax + extra)},
            ${input.bankAccountId}, ${v!.id}, ${claims.sub})`;
        await tx`INSERT INTO acc.tds_salary_challan_line (challan_id, run_id, amount)
          VALUES (${challanId}, ${run.runId}, ${money(tax)})`;
        await audit(tx, claims.sub, 'tds_challan.create', 'entity', input.entityId, {
          section: '192',
          period: input.period,
          tax: money(tax),
        });
        return challanId;
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'challan_exists',
            message: 'This challan is already entered.',
          });
        return fromDb(err);
      });
    return this.tds.challan(claims, id);
  }

  /** The quarter's 24Q: the salary challans and each employee's pay and TDS, month by month. */
  async form24q(claims: TenantClaims, q: { entityId: string; quarter: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const { from, to } = quarterRange(q.quarter);
    const deductor = await this.deductor(db, q.entityId);
    const runs = await this.salaryRuns(db, q.entityId, from, to);
    const deductees = await db<
      {
        employeeId: string;
        code: string;
        name: string;
        pan: string | null;
        month: string;
        paid: string;
        tds: string;
        runId: string;
      }[]
    >`
      SELECT e.id AS "employeeId", e.code, e.name, e.pan, to_char(r.month, 'YYYY-MM') AS month,
        l.gross::text AS paid, l.tds::text AS tds, r.id AS "runId"
      FROM pay.run_line l JOIN pay.run r ON r.id = l.run_id JOIN hr.employee e ON e.id = l.employee_id
      WHERE r.entity_id = ${q.entityId} AND r.status IN ('posted', 'paid') AND r.month BETWEEN ${from} AND ${to}
        AND l.tds > 0
      ORDER BY r.month, e.code`;
    const problems: string[] = [];
    if (!deductor.tan) problems.push("The company's TAN is missing.");
    const open = runs.filter((r) => dec(r.tds) && !r.challan).map((r) => r.month);
    if (open.length) problems.push(`Salary TDS of ${open.join(', ')} is not yet in a challan.`);
    const noPan = new Set(deductees.filter((d) => !d.pan).map((d) => d.code)).size;
    if (noPan)
      problems.push(`${noPan} employee${noPan === 1 ? ' has' : 's have'} no PAN (taxed at 20%).`);
    return {
      ...q,
      from,
      to,
      deductor,
      runs,
      deductees: deductees.map((d) => ({
        ...d,
        challan: runs.find((r) => r.runId === d.runId)?.challan ?? null,
      })),
      total: money(deductees.reduce((s, d) => s + dec(d.tds), 0n)),
      problems,
    };
  }

  // --- Form 16A ---

  /** A supplier's Form 16A for a quarter: each deduction with the challan that deposited it. */
  async form16a(claims: TenantClaims, q: { entityId: string; quarter: string; partyId: string }) {
    const r = await this.tds.form26q(claims, { entityId: q.entityId, quarter: q.quarter });
    const rows = r.deductees.filter((d) => d.partyId === q.partyId);
    if (!rows.length)
      throw new NotFoundException({
        code: 'no_deductions',
        message: 'Nothing was deducted from this supplier in the quarter.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const [party] = await db<{ name: string; address: string | null; pan: string | null }[]>`
      SELECT coalesce(legal_name, name) AS name, address, coalesce(pan, substr(gstin, 3, 10)) AS pan
      FROM platform.party WHERE id = ${q.partyId}`;
    return {
      quarter: q.quarter,
      from: r.from,
      to: r.to,
      deductor: r.deductor,
      deductee: party!,
      rows,
      paid: money(rows.reduce((s, x) => s + dec(x.paid), 0n)),
      tds: money(rows.reduce((s, x) => s + dec(x.tds), 0n)),
      deposited: money(rows.filter((x) => x.challan).reduce((s, x) => s + dec(x.tds), 0n)),
      complete: rows.every((x) => x.challan),
    };
  }

  // --- the text file for the FVU ---

  /**
   * The 26Q or 24Q as the NSDL file format lays it out: a file header (FH), a batch header (BH), and for each challan
   * its details (CD) followed by the deductions it deposited (DD); fields separated by ^, one record a line.
   */
  async fvuText(
    claims: TenantClaims,
    q: { entityId: string; quarter: string; form: '26Q' | '24Q' },
  ) {
    const { from } = quarterRange(q.quarter);
    const fy = Number(from.slice(0, 4)) - (Number(from.slice(5, 7)) < 4 ? 1 : 0);
    const qNo = q.quarter.slice(-2);
    type Ded = {
      pan: string | null;
      name: string;
      section: string;
      paid: string;
      tds: string;
      date: string;
      rate: string;
      company: boolean;
      lower: boolean;
      challan: { bsrCode: string; challanNo: string; depositedOn: string } | null;
    };
    let deductor: Deductor;
    let deds: Ded[];
    let problems: string[];
    if (q.form === '26Q') {
      const r = await this.tds.form26q(claims, { entityId: q.entityId, quarter: q.quarter });
      const db = await this.tenants.forTenant(claims.ten);
      const lower = new Set(
        (
          await db<{ id: string }[]>`
            SELECT id FROM acc.vendor_bill WHERE entity_id = ${q.entityId} AND tds_certificate_id IS NOT NULL`
        ).map((x) => x.id),
      );
      deductor = r.deductor as Deductor;
      problems = r.problems;
      deds = r.deductees.map((d) => ({
        pan: d.pan,
        name: d.party,
        section: d.section,
        paid: d.paid,
        tds: d.tds,
        date: d.date,
        rate: d.rate,
        company: !!d.pan && d.pan[3] === 'C',
        lower: lower.has(d.billId),
        challan: d.challan,
      }));
    } else {
      const r = await this.form24q(claims, { entityId: q.entityId, quarter: q.quarter });
      deductor = r.deductor;
      problems = r.problems;
      deds = r.deductees.map((d) => ({
        pan: d.pan,
        name: d.name,
        section: '192',
        paid: d.paid,
        tds: d.tds,
        date: `${d.month}-${monthRange(d.month).to.slice(8, 10)}`,
        rate: '0',
        company: false,
        lower: false,
        challan: d.challan,
      }));
    }
    if (!deductor.tan)
      throw new BadRequestException({
        code: 'tan_missing',
        message: "The company's TAN is missing.",
      });
    // Each challan with its deductions; a deduction not yet deposited stops the file.
    const pending = deds.filter((d) => !d.challan).length;
    if (pending)
      throw new BadRequestException({
        code: 'not_deposited',
        message: `${pending} deduction${pending === 1 ? ' is' : 's are'} not yet in a challan.`,
      });
    const byChallan = new Map<string, Ded[]>();
    for (const d of deds) {
      const k = `${d.challan!.bsrCode}|${d.challan!.depositedOn}|${d.challan!.challanNo}`;
      byChallan.set(k, [...(byChallan.get(k) ?? []), d]);
    }
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const lines: string[][] = [];
    let n = 0;
    const rec = (...f: (string | number)[]) => lines.push([String(++n), ...f.map(String)]);
    rec(
      'FH',
      'NS1',
      'R',
      ddmmyyyy(today),
      '1',
      'D',
      deductor.tan,
      '1',
      'Aerolith',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    );
    const total = deds.reduce((s, d) => s + dec(d.tds), 0n);
    rec(
      'BH',
      '1',
      byChallan.size,
      q.form,
      '',
      '',
      '',
      '',
      '',
      '',
      '',
      deductor.tan,
      '',
      deductor.pan ?? '',
      `${fy + 1}${String(fy + 2).slice(2)}`,
      `${fy}${String(fy + 1).slice(2)}`,
      qNo,
      (deductor.legalName ?? deductor.name).slice(0, 75),
      '',
      (deductor.address ?? '').slice(0, 25),
      '',
      '',
      '',
      '',
      (deductor.city ?? '').slice(0, 25),
      deductor.stateCode ?? '',
      deductor.pincode ?? '',
      '',
      '',
      '',
      'N',
      'O',
      '',
      money(total),
    );
    let c = 0;
    for (const [k, rows] of byChallan) {
      const [bsr, on, no] = k.split('|') as [string, string, string];
      const tax = rows.reduce((s, d) => s + dec(d.tds), 0n);
      rec(
        'CD',
        '1',
        ++c,
        rows.length,
        'N',
        '',
        '',
        '',
        '',
        '',
        no,
        '',
        '',
        bsr,
        '',
        ddmmyyyy(on),
        '',
        '',
        '',
        money(tax),
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        money(tax),
      );
      rows.forEach((d, i) =>
        rec(
          'DD',
          '1',
          c,
          i + 1,
          'O',
          '',
          d.company ? '01' : '02',
          '',
          d.pan ?? 'PANNOTAVBL',
          '',
          '',
          d.name.slice(0, 75),
          money(dec(d.tds)),
          '0.00',
          '0.00',
          money(dec(d.tds)),
          '',
          money(dec(d.tds)),
          '',
          '',
          money(dec(d.paid)),
          ddmmyyyy(d.date),
          ddmmyyyy(d.date),
          ddmmyyyy(on),
          Number(d.rate).toFixed(4),
          '',
          '',
          d.lower ? 'A' : '',
          '',
          SECTION_CODE[d.section] ?? d.section,
        ),
      );
    }
    return {
      fileName: `${deductor.tan}_${q.form}_${q.quarter}.txt`,
      text: lines.map((l) => l.join('^')).join('\r\n') + '\r\n',
      problems,
    };
  }
}
