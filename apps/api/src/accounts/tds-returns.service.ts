// TDS deposited and returned (docs/wave3-plan.md step 6b): the deductions from suppliers' bills; challans depositing
// them (each deduction once), posted against TDS payable; the quarter's 26Q data; and what the clients deducted from
// their payments matched against their 26AS or AIS figures.
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
import { fromDb, isRole } from './accounts-rules.js';
import { monthRange } from './gst.service.js';
import { LedgerService, type LineInput } from './ledger.service.js';

type Db = Sql | TransactionSql;
const money = (v: bigint) => fmt(v, 2);

/** A quarter of a financial year, "2026-27-Q2": its first and last days. */
export function quarterRange(quarter: string) {
  const m = /^(\d{4})-(\d{2})-Q([1-4])$/.exec(quarter);
  if (!m) throw new BadRequestException({ code: 'bad_quarter', message: 'A quarter: 2026-27-Q2.' });
  const y = Number(m[1]);
  const q = Number(m[3]);
  const [from, to] =
    q === 4
      ? [`${y + 1}-01-01`, `${y + 1}-03-31`]
      : [
          monthRange(`${y}-${String(q * 3 + 1).padStart(2, '0')}`).from,
          monthRange(`${y}-${String(q * 3 + 3).padStart(2, '0')}`).to,
        ];
  return { from, to };
}

export interface Deduction {
  billId: string;
  party: string;
  partyId: string;
  pan: string | null;
  section: string;
  date: string;
  billNo: string;
  paid: string;
  base: string;
  rate: string;
  tds: string;
  challan: { id: string; bsrCode: string; challanNo: string; depositedOn: string } | null;
}

@Injectable()
export class TdsReturnService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
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

  private rows(db: Db, entityId: string, from: string, to: string, section?: string) {
    return db<Deduction[]>`
      SELECT b.id AS "billId", p.name AS party, p.id AS "partyId", coalesce(p.pan, substr(p.gstin, 3, 10)) AS pan,
        b.tds_section AS section, to_char(b.bill_date, 'YYYY-MM-DD') AS date, b.bill_no AS "billNo",
        b.taxable::text AS paid, b.tds_base::text AS base, b.tds_rate::text AS rate, b.tds::text AS tds,
        CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'bsrCode', c.bsr_code, 'challanNo',
          c.challan_no, 'depositedOn', to_char(c.deposited_on, 'YYYY-MM-DD')) END AS challan
      FROM acc.vendor_bill b JOIN platform.party p ON p.id = b.party_id
      LEFT JOIN acc.tds_challan_line l ON l.bill_id = b.id LEFT JOIN acc.tds_challan c ON c.id = l.challan_id
      WHERE b.entity_id = ${entityId} AND b.status = 'posted' AND b.tds > 0
        AND b.bill_date BETWEEN ${from} AND ${to} ${section ? db`AND b.tds_section = ${section}` : db``}
      ORDER BY b.bill_date, p.name, b.bill_no`;
  }

  /** The deductions of a period, deposited or not. */
  async deductions(
    claims: TenantClaims,
    q: { entityId: string; from: string; to: string; section?: string },
  ) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await this.rows(db, q.entityId, q.from, q.to, q.section);
    const due = rows.filter((r) => !r.challan).reduce((s, r) => s + dec(r.tds), 0n);
    return { ...q, rows, undeposited: money(due) };
  }

  /**
   * A challan for a month's TDS under a section: the deductions of that month not yet deposited (all of them, or
   * those named), posted as TDS payable Dr, interest and fees Dr, the bank Cr.
   */
  async createChallan(
    claims: TenantClaims,
    input: {
      entityId: string;
      section: string;
      period: string;
      depositedOn: string;
      bsrCode: string;
      challanNo: string;
      interest: string;
      fee: string;
      bankAccountId: string;
      billIds: string[] | null;
    },
  ) {
    await this.may(claims, 'accounts.post');
    const role = `tds_payable_${input.section.toLowerCase()}`;
    if (!isRole(role))
      throw new BadRequestException({
        code: 'unknown_section',
        message: `No section ${input.section}.`,
      });
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'tds ' + input.entityId}))`;
        const { from, to } = monthRange(input.period);
        if (input.depositedOn < from)
          throw new BadRequestException({
            code: 'before_deduction',
            message: 'A challan is deposited after the month it pays for begins.',
          });
        const open = (await this.rows(tx, input.entityId, from, to, input.section)).filter(
          (r) => !r.challan,
        );
        const chosen = input.billIds ? open.filter((r) => input.billIds!.includes(r.billId)) : open;
        if (input.billIds && chosen.length !== input.billIds.length)
          throw new BadRequestException({
            code: 'not_open',
            message: 'A deduction named is not of this month and section, or is already deposited.',
          });
        if (!chosen.length)
          throw new BadRequestException({
            code: 'nothing_to_deposit',
            message: `No ${input.section} deductions of ${input.period} are left to deposit.`,
          });
        const [bank] = await tx<{ ok: boolean }[]>`
          SELECT kind IN ('bank', 'cash') AND NOT is_group AND closed_at IS NULL AS ok FROM acc.account
          WHERE id = ${input.bankAccountId}`;
        if (!bank?.ok)
          throw new BadRequestException({ code: 'not_a_bank', message: 'Pay from a bank ledger.' });
        const tax = chosen.reduce((s, r) => s + dec(r.tds), 0n);
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
            narration: `TDS ${input.section} for ${input.period}: challan ${input.bsrCode}/${input.challanNo}`,
            reference: `${input.bsrCode}/${input.challanNo}`,
            lines: [
              line(
                await this.ledger.roleAccount(tx, input.entityId, role),
                money(tax),
                '0',
                `TDS ${input.section}`,
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
        const [c] = await tx<{ id: string }[]>`
          INSERT INTO acc.tds_challan (id, entity_id, section, period, deposited_on, bsr_code, challan_no, tax, interest, fee,
            total, bank_account_id, voucher_id, created_by)
          VALUES (${challanId}, ${input.entityId}, ${input.section}, ${input.period}, ${input.depositedOn}, ${input.bsrCode},
            ${input.challanNo}, ${money(tax)}, ${input.interest}, ${input.fee}, ${money(tax + extra)},
            ${input.bankAccountId}, ${v!.id}, ${claims.sub})
          RETURNING id`;
        for (const r of chosen)
          await tx`INSERT INTO acc.tds_challan_line (challan_id, bill_id, amount) VALUES (${c!.id}, ${r.billId}, ${r.tds})`;
        await audit(tx, claims.sub, 'tds_challan.create', 'entity', input.entityId, {
          section: input.section,
          period: input.period,
          tax: money(tax),
        });
        return c!.id;
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'challan_exists',
            message: 'This challan is already entered.',
          });
        return fromDb(err);
      });
    return this.challan(claims, id);
  }

  async challan(claims: TenantClaims, id: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const [c] = await db`
      SELECT c.id, c.section, c.period, to_char(c.deposited_on, 'YYYY-MM-DD') AS "depositedOn", c.bsr_code AS "bsrCode",
        c.challan_no AS "challanNo", c.tax::text AS tax, c.interest::text AS interest, c.fee::text AS fee,
        c.total::text AS total, json_build_object('id', v.id, 'number', v.number) AS voucher,
        coalesce((SELECT json_agg(json_build_object('billId', b.id, 'party', p.name, 'billNo', b.bill_no,
          'amount', l.amount::text) ORDER BY b.bill_date, p.name) FROM acc.tds_challan_line l
          JOIN acc.vendor_bill b ON b.id = l.bill_id JOIN platform.party p ON p.id = b.party_id
          WHERE l.challan_id = c.id), '[]') AS lines
      FROM acc.tds_challan c JOIN acc.voucher v ON v.id = c.voucher_id WHERE c.id = ${id}`;
    if (!c) throw new NotFoundException({ code: 'challan_not_found' });
    return c;
  }

  async challans(claims: TenantClaims, q: { entityId: string; from: string; to: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT c.id, c.section, c.period, to_char(c.deposited_on, 'YYYY-MM-DD') AS "depositedOn", c.bsr_code AS "bsrCode",
        c.challan_no AS "challanNo", c.tax::text AS tax, c.interest::text AS interest, c.fee::text AS fee,
        c.total::text AS total
      FROM acc.tds_challan c WHERE c.entity_id = ${q.entityId} AND c.deposited_on BETWEEN ${q.from} AND ${q.to}
      ORDER BY c.deposited_on, c.section`;
  }

  /** The quarter's 26Q: the deductor, the challans, each deduction with its challan. */
  async form26q(claims: TenantClaims, q: { entityId: string; quarter: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const { from, to } = quarterRange(q.quarter);
    const [deductor] = await db<
      {
        name: string;
        legalName: string;
        tan: string | null;
        pan: string | null;
        address: string;
        city: string;
        pincode: string | null;
      }[]
    >`
      SELECT name, legal_name AS "legalName", tan, pan, address, city, pincode FROM platform.entity WHERE id = ${q.entityId}`;
    if (!deductor) throw new NotFoundException({ code: 'company_not_found' });
    const rows = await this.rows(db, q.entityId, from, to);
    const challans = await db<{ id: string }[]>`
      SELECT DISTINCT c.id, c.section, to_char(c.deposited_on, 'YYYY-MM-DD') AS "depositedOn", c.bsr_code AS "bsrCode",
        c.challan_no AS "challanNo", c.tax::text AS tax, c.interest::text AS interest, c.fee::text AS fee,
        c.total::text AS total
      FROM acc.tds_challan c JOIN acc.tds_challan_line l ON l.challan_id = c.id JOIN acc.vendor_bill b ON b.id = l.bill_id
      WHERE c.entity_id = ${q.entityId} AND b.bill_date BETWEEN ${from} AND ${to}
      ORDER BY "depositedOn", "bsrCode", "challanNo"`;
    const problems: string[] = [];
    if (!deductor.tan) problems.push("The company's TAN is missing.");
    const undeposited = rows.filter((r) => !r.challan).length;
    if (undeposited)
      problems.push(
        `${undeposited} deduction${undeposited === 1 ? ' is' : 's are'} not yet in a challan.`,
      );
    const noPan = rows.filter((r) => !r.pan).length;
    if (noPan)
      problems.push(
        `${noPan} deductee${noPan === 1 ? ' has' : 's have'} no PAN (taxed at the higher rate).`,
      );
    return {
      ...q,
      from,
      to,
      deductor,
      challans,
      deductees: rows,
      total: money(rows.reduce((s, r) => s + dec(r.tds), 0n)),
      problems,
    };
  }

  // --- TDS deducted by clients ---

  async uploadCredits(
    claims: TenantClaims,
    input: {
      entityId: string;
      quarter: string;
      fileName: string;
      rows: { tan: string; deductor: string; amount: string; tds: string }[];
    },
  ) {
    await this.may(claims, 'accounts.post');
    quarterRange(input.quarter);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`DELETE FROM acc.tds_credit_upload WHERE entity_id = ${input.entityId} AND quarter = ${input.quarter}`;
      const [u] = await tx<{ id: string }[]>`
        INSERT INTO acc.tds_credit_upload (entity_id, quarter, file_name, uploaded_by)
        VALUES (${input.entityId}, ${input.quarter}, ${input.fileName.slice(0, 200)}, ${claims.sub}) RETURNING id`;
      for (const [i, r] of input.rows.entries())
        await tx`INSERT INTO acc.tds_credit_line (upload_id, position, tan, deductor, amount, tds)
          VALUES (${u!.id}, ${i + 1}, ${r.tan}, ${r.deductor}, ${r.amount}, ${r.tds})`;
      await audit(tx, claims.sub, 'tds_credit.upload', 'entity', input.entityId, {
        quarter: input.quarter,
        rows: input.rows.length,
      });
    });
    return this.matchCredits(claims, { entityId: input.entityId, quarter: input.quarter });
  }

  /**
   * TDS the clients deducted in the quarter (their receipts), by the client's TAN, against what 26AS shows: matched
   * (within ₹1), short (26AS shows less: chase the client), more (26AS shows more), missing (not in 26AS at all), not
   * in the books (a deductor the books do not know); clients without a TAN are listed apart.
   */
  async matchCredits(claims: TenantClaims, q: { entityId: string; quarter: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const { from, to } = quarterRange(q.quarter);
    const books = await db<{ partyId: string; party: string; tan: string | null; tds: string }[]>`
      SELECT p.id AS "partyId", p.name AS party, p.tan, sum(r.tds)::text AS tds
      FROM acc.client_receipt r JOIN platform.party p ON p.id = r.party_id
      WHERE r.entity_id = ${q.entityId} AND r.status = 'posted' AND r.tds > 0 AND r.received_on BETWEEN ${from} AND ${to}
      GROUP BY p.id, p.name, p.tan ORDER BY p.name`;
    const [u] = await db<{ id: string; fileName: string; uploadedAt: string }[]>`
      SELECT id, file_name AS "fileName", uploaded_at AS "uploadedAt" FROM acc.tds_credit_upload
      WHERE entity_id = ${q.entityId} AND quarter = ${q.quarter}`;
    const credits = u
      ? await db<{ tan: string; deductor: string; tds: string }[]>`
          SELECT tan, max(deductor) AS deductor, sum(tds)::text AS tds FROM acc.tds_credit_line
          WHERE upload_id = ${u.id} GROUP BY tan ORDER BY tan`
      : [];
    const byTan = new Map(credits.map((c) => [c.tan, c]));
    const rows: {
      status: 'matched' | 'short' | 'more' | 'missing' | 'not_in_books' | 'no_tan';
      tan: string | null;
      party: string;
      books: string | null;
      reported: string | null;
    }[] = [];
    const seen = new Set<string>();
    for (const b of books) {
      if (!b.tan) {
        rows.push({ status: 'no_tan', tan: null, party: b.party, books: b.tds, reported: null });
        continue;
      }
      const c = byTan.get(b.tan);
      seen.add(b.tan);
      const diff = c ? dec(c.tds) - dec(b.tds) : 0n;
      rows.push({
        status: !c
          ? 'missing'
          : (diff < 0n ? -diff : diff) <= dec('1')
            ? 'matched'
            : diff < 0n
              ? 'short'
              : 'more',
        tan: b.tan,
        party: b.party,
        books: b.tds,
        reported: c?.tds ?? null,
      });
    }
    for (const c of credits.filter((x) => !seen.has(x.tan)))
      rows.push({
        status: 'not_in_books',
        tan: c.tan,
        party: c.deductor,
        books: null,
        reported: c.tds,
      });
    return { ...q, from, to, upload: u ?? null, rows };
  }
}
