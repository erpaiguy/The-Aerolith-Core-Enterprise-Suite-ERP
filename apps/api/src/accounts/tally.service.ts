// The books in Tally's own format (docs/wave3-plan.md step 8b): masters (groups and ledgers, opening balances, parties
// with GSTIN and address) and vouchers for a period, as Tally Prime's XML import takes them; and the accounts mode
// that decides whether the app keeps the books, exports them, or leaves them to Tally.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { dec, fmt } from '../rates/decimal.js';
import { STATES } from './gst.service.js';

type Db = Sql | TransactionSql;
const MODE_KEY = 'accounts.mode';
export const MODES = ['native', 'native_tally', 'tally'] as const;
export type AccountsMode = (typeof MODES)[number];

/** Tally's own primary groups, by the chart's top groups. */
const PRIMARY: Record<string, string> = {
  capital: 'Capital Account',
  reserves: 'Reserves & Surplus',
  long_term_borrowings: 'Loans (Liability)',
  short_term_borrowings: 'Loans (Liability)',
  sundry_creditors: 'Sundry Creditors',
  other_current_liabilities: 'Current Liabilities',
  duties_and_taxes: 'Duties & Taxes',
  provisions: 'Provisions',
  fixed_assets: 'Fixed Assets',
  inventories: 'Stock-in-Hand',
  sundry_debtors: 'Sundry Debtors',
  cash_and_bank: 'Bank Accounts',
  loans_and_advances: 'Loans & Advances (Asset)',
  revenue: 'Sales Accounts',
  other_income: 'Indirect Incomes',
  materials_consumed: 'Purchase Accounts',
  subcontract_and_labour: 'Direct Expenses',
  site_expenses: 'Direct Expenses',
  employee_benefits: 'Indirect Expenses',
  finance_costs: 'Indirect Expenses',
  depreciation_group: 'Indirect Expenses',
  other_expenses: 'Indirect Expenses',
};
const BY_NATURE: Record<string, string> = {
  equity: 'Capital Account',
  liability: 'Current Liabilities',
  asset: 'Current Assets',
  income: 'Indirect Incomes',
  expense: 'Indirect Expenses',
};
const VOUCHER_TYPE: Record<string, string> = {
  journal: 'Journal',
  payment: 'Payment',
  receipt: 'Receipt',
  contra: 'Contra',
  sales: 'Sales',
  purchase: 'Purchase',
  debit_note: 'Debit Note',
  credit_note: 'Credit Note',
};

/** XML text, escaped. */
export const x = (v: string | null | undefined) =>
  (v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
/** Tally's amounts: debits negative, credits positive. */
const tallyAmount = (debitPositive: bigint) => fmt(-debitPositive, 2);
const envelope = (report: 'All Masters' | 'Vouchers', company: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>${report}</REPORTNAME>
    <STATICVARIABLES><SVCURRENTCOMPANY>${x(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>
${body}
   </REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>
`;

interface Acct {
  id: string;
  parent_id: string | null;
  system_key: string | null;
  nature: string;
  is_group: boolean;
  kind: string;
  name: string;
  closed: boolean;
  gstin: string | null;
  address: string | null;
  state_code: string | null;
  pincode: string | null;
}

@Injectable()
export class TallyService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  async mode(db: Db): Promise<AccountsMode> {
    const [s] = await db<
      { value: unknown }[]
    >`SELECT value FROM platform.setting WHERE key = ${MODE_KEY}`;
    return MODES.includes(s?.value as AccountsMode) ? (s!.value as AccountsMode) : 'native';
  }

  async getMode(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return { mode: await this.mode(db), mayEdit: claims.role === 'admin' };
  }

  async setMode(claims: TenantClaims, mode: AccountsMode) {
    if (claims.role !== 'admin')
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Only an admin sets the accounts mode.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db`INSERT INTO platform.setting (key, value) VALUES (${MODE_KEY}, ${db.json(mode)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    return this.getMode(claims);
  }

  private async may(claims: TenantClaims, db: Db) {
    if (!(await this.permissions.can(claims, 'accounts.view')))
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'The export needs the accounts permission.',
      });
    if ((await this.mode(db)) === 'native')
      throw new ConflictException({
        code: 'export_off',
        message: 'The accounts mode does not include the Tally export. The admin turns it on.',
      });
  }

  private async company(db: Db, entityId: string) {
    const [e] = await db<{ name: string; legal_name: string }[]>`
      SELECT name, legal_name FROM platform.entity WHERE id = ${entityId}`;
    if (!e) throw new BadRequestException({ code: 'company_not_found' });
    return e.legal_name || e.name;
  }

  /**
   * Groups below the top ones (under their parent, the top ones standing for Tally's primary groups) and every ledger
   * the company has used or that is open, with its balance on the day before the period as the opening balance.
   */
  async masters(claims: TenantClaims, q: { entityId: string; from: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.may(claims, db);
    const company = await this.company(db, q.entityId);
    const all = await db<Acct[]>`
      SELECT a.id, a.parent_id, a.system_key, a.nature, a.is_group, a.kind, a.name, a.closed_at IS NOT NULL AS closed,
        p.gstin, p.address, coalesce(p.state_code, substr(p.gstin, 1, 2)) AS state_code, p.pincode
      FROM acc.account a LEFT JOIN platform.party p ON p.id = a.party_id ORDER BY a.code`;
    const byId = new Map(all.map((a) => [a.id, a]));
    const isTop = (a: Acct) => !!a.parent_id && !byId.get(a.parent_id)?.parent_id;
    const topOf = (a: Acct) => {
      let t = a;
      while (t.parent_id && !isTop(t)) t = byId.get(t.parent_id)!;
      return t;
    };
    const primary = (a: Acct) => {
      const t = topOf(a);
      if (t.system_key === 'cash_and_bank' && a.kind === 'cash') return 'Cash-in-Hand';
      return PRIMARY[t.system_key ?? ''] ?? BY_NATURE[t.nature]!;
    };
    const parentName = (a: Acct) => {
      const p = byId.get(a.parent_id!)!;
      return isTop(p) || !p.parent_id ? primary(a) : p.name;
    };
    const opening = new Map(
      (
        await db<{ account_id: string; net: string }[]>`
          SELECT l.account_id, sum(l.debit - l.credit)::text AS net FROM acc.voucher_line l
          JOIN acc.voucher v ON v.id = l.voucher_id
          WHERE v.entity_id = ${q.entityId} AND v.voucher_date < ${q.from}
          GROUP BY l.account_id`
      ).map((r) => [r.account_id, dec(r.net)]),
    );
    const used = new Set(
      (
        await db<{ account_id: string }[]>`
          SELECT DISTINCT l.account_id FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id
          WHERE v.entity_id = ${q.entityId}`
      ).map((r) => r.account_id),
    );
    const groups = all.filter((a) => a.is_group && a.parent_id && !isTop(a));
    const ledgers = all.filter((a) => !a.is_group && (used.has(a.id) || !a.closed));
    const out: string[] = [];
    for (const g of groups)
      out.push(`    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <GROUP NAME="${x(g.name)}" ACTION="Create">
      <NAME.LIST><NAME>${x(g.name)}</NAME></NAME.LIST>
      <PARENT>${x(parentName(g))}</PARENT>
     </GROUP>
    </TALLYMESSAGE>`);
    for (const l of ledgers) {
      const party = l.kind === 'party';
      const state = l.state_code ? STATES[l.state_code] : null;
      out.push(`    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <LEDGER NAME="${x(l.name)}" ACTION="Create">
      <NAME.LIST><NAME>${x(l.name)}</NAME></NAME.LIST>
      <PARENT>${x(parentName(l))}</PARENT>
      <OPENINGBALANCE>${tallyAmount(opening.get(l.id) ?? 0n)}</OPENINGBALANCE>${
        party
          ? `
      <ISBILLWISEON>Yes</ISBILLWISEON>${l.gstin ? `\n      <PARTYGSTIN>${x(l.gstin)}</PARTYGSTIN>\n      <GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>` : `\n      <GSTREGISTRATIONTYPE>Unregistered</GSTREGISTRATIONTYPE>`}${state ? `\n      <LEDSTATENAME>${x(state)}</LEDSTATENAME>` : ''}${l.pincode ? `\n      <PINCODE>${x(l.pincode)}</PINCODE>` : ''}${l.address ? `\n      <ADDRESS.LIST><ADDRESS>${x(l.address.replace(/\s+/g, ' ').slice(0, 200))}</ADDRESS></ADDRESS.LIST>` : ''}`
          : ''
      }
     </LEDGER>
    </TALLYMESSAGE>`);
    }
    return {
      fileName: `Tally-masters-${q.from}.xml`,
      xml: envelope('All Masters', company, out.join('\n')),
      counts: { groups: groups.length, ledgers: ledgers.length },
    };
  }

  /** Every voucher of the period (opening balances are the masters'), each ledger entry with Tally's signs. */
  async vouchers(claims: TenantClaims, q: { entityId: string; from: string; to: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.may(claims, db);
    const company = await this.company(db, q.entityId);
    const vs = await db<
      {
        id: string;
        type: string;
        number: string;
        date: string;
        narration: string;
        reference: string;
        lines: { name: string; debit: string; credit: string }[];
      }[]
    >`
      SELECT v.id, v.type, v.number, to_char(v.voucher_date, 'YYYYMMDD') AS date, v.narration, v.reference,
        (SELECT json_agg(json_build_object('name', a.name, 'debit', l.debit::text, 'credit', l.credit::text)
          ORDER BY l.position) FROM acc.voucher_line l JOIN acc.account a ON a.id = l.account_id
          WHERE l.voucher_id = v.id) AS lines
      FROM acc.voucher v
      WHERE v.entity_id = ${q.entityId} AND v.type <> 'opening' AND v.voucher_date BETWEEN ${q.from} AND ${q.to}
      ORDER BY v.voucher_date, v.number`;
    const out = vs.map((v) => {
      const type = VOUCHER_TYPE[v.type] ?? 'Journal';
      const entries = v.lines
        .map((l) => {
          const debit = dec(l.debit) - dec(l.credit);
          return `      <ALLLEDGERENTRIES.LIST>
       <LEDGERNAME>${x(l.name)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>${debit > 0n ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
       <AMOUNT>${tallyAmount(debit)}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`;
        })
        .join('\n');
      return `    <TALLYMESSAGE xmlns:UDF="TallyUDF">
     <VOUCHER VCHTYPE="${type}" ACTION="Create">
      <DATE>${v.date}</DATE>
      <VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>
      <VOUCHERNUMBER>${x(v.number)}</VOUCHERNUMBER>${v.reference ? `\n      <REFERENCE>${x(v.reference)}</REFERENCE>` : ''}
      <NARRATION>${x(v.narration)}</NARRATION>
${entries}
     </VOUCHER>
    </TALLYMESSAGE>`;
    });
    return {
      fileName: `Tally-vouchers-${q.from}-${q.to}.xml`,
      xml: envelope('Vouchers', company, out.join('\n')),
      count: vs.length,
    };
  }
}
