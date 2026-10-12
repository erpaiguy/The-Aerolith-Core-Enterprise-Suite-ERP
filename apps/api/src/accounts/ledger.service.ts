// The ledger core (docs/wave3-plan.md step 1): companies, the chart of accounts and its account map, vouchers (which
// always balance and are reversed, never changed), locked months, opening balances, and the day book, ledger and
// trial balance. The database refuses an unbalanced voucher, an edit and a locked month too (migration 0036).
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
import { dec, fmt, type Dec } from '../rates/decimal.js';
import { nextNumber } from '../tender/numbering.js';
import {
  fromDb,
  fyOf,
  isRole,
  monthOf,
  partyGroupKey,
  ROLES,
  TYPED_IN,
  VOUCHER_TYPES,
  type Role,
  type VoucherType,
} from './accounts-rules.js';

type Db = Sql | TransactionSql;
const money = (v: Dec) => fmt(v, 2);
const groupBy = <T, K>(xs: T[], key: (x: T) => K) => {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
};
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export interface CompanyInput {
  name: string;
  legalName: string;
  gstin: string | null;
  pan: string | null;
  tan: string | null;
  stateCode: string | null;
  address: string;
  city: string;
  pincode: string | null;
  eInvoicing: boolean;
  booksFrom: string | null;
}
export interface AccountInput {
  parentId: string;
  isGroup: boolean;
  code: string;
  name: string;
  kind: 'ordinary' | 'bank' | 'cash' | 'tax';
  needsProject: boolean;
  itcBlocked: boolean;
}
export interface LineInput {
  accountId: string | null;
  partyId: string | null;
  debit: string;
  credit: string;
  projectId: string | null;
  siteId: string | null;
  costCodeId: string | null;
  note: string;
}
export interface VoucherInput {
  entityId: string;
  type: VoucherType;
  date: string;
  narration: string;
  reference: string;
  lines: LineInput[];
}

export interface AccountRow {
  id: string;
  parentId: string | null;
  isGroup: boolean;
  nature: string;
  code: string;
  name: string;
  kind: string;
  partyId: string | null;
  needsProject: boolean;
  itcBlocked: boolean;
  systemKey: string | null;
  closed: boolean;
  rowVersion: number;
}

@Injectable()
export class LedgerService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          p === 'accounts.view'
            ? 'Reading the books needs the accounts permission.'
            : 'Posting vouchers needs the permission to post.',
      });
  }
  private admin(claims: TenantClaims) {
    if (claims.role !== 'admin')
      throw new ForbiddenException({
        code: 'forbidden',
        message:
          'Only an admin changes companies, the chart of accounts, the account map, locks and opening balances.',
      });
  }
  private async audit(
    tx: Db,
    claims: TenantClaims,
    action: string,
    entity: string,
    id: string,
    data: object,
  ) {
    await tx`INSERT INTO platform.audit_log (actor_id, action, entity, entity_id, data)
      VALUES (${claims.sub}, ${action}, ${entity}, ${id}, ${tx.json(JSON.parse(JSON.stringify(data)))})`;
  }

  // --- companies ---

  private companyRows(db: Db) {
    return db<
      {
        id: string;
        name: string;
        legalName: string;
        gstin: string | null;
        pan: string | null;
        tan: string | null;
        stateCode: string | null;
        address: string;
        booksFrom: string | null;
        isDefault: boolean;
        vouchers: number;
        rowVersion: number;
      }[]
    >`
      SELECT e.id, e.name, e.legal_name AS "legalName", e.gstin, e.pan, e.tan, e.state_code AS "stateCode", e.address,
        e.city, e.pincode, e.e_invoicing AS "eInvoicing", to_char(e.books_from, 'YYYY-MM-DD') AS "booksFrom", e.is_default AS "isDefault",
        (SELECT count(*)::int FROM acc.voucher v WHERE v.entity_id = e.id) AS vouchers, e.row_version AS "rowVersion"
      FROM platform.entity e ORDER BY e.is_default DESC, lower(e.name)`;
  }

  /** Every signed-in user reads the companies (they name a tender's or project's company); the admin changes them. */
  async companies(claims: TenantClaims) {
    const db = await this.tenants.forTenant(claims.ten);
    return { companies: await this.companyRows(db), mayEdit: claims.role === 'admin' };
  }

  private checkCompany(b: CompanyInput) {
    if (b.gstin && b.stateCode && b.gstin.slice(0, 2) !== b.stateCode)
      throw new BadRequestException({
        code: 'state_mismatch',
        message: `The GSTIN is registered in state ${b.gstin.slice(0, 2)}, not ${b.stateCode}.`,
      });
    if (b.gstin && b.pan && b.gstin.slice(2, 12) !== b.pan)
      throw new BadRequestException({
        code: 'pan_mismatch',
        message: "The PAN is not the GSTIN's PAN.",
      });
    return {
      ...b,
      stateCode: b.stateCode ?? b.gstin?.slice(0, 2) ?? null,
      pan: b.pan ?? b.gstin?.slice(2, 12) ?? null,
    };
  }

  async createCompany(claims: TenantClaims, input: CompanyInput) {
    this.admin(claims);
    const b = this.checkCompany(input);
    const db = await this.tenants.forTenant(claims.ten);
    const [dup] = await db`SELECT 1 FROM platform.entity WHERE lower(name) = lower(${b.name})`;
    if (dup)
      throw new ConflictException({
        code: 'company_exists',
        message: `There is already a company called ${b.name}.`,
      });
    await db.begin(async (tx) => {
      const [e] = await tx<{ id: string }[]>`
        INSERT INTO platform.entity (name, legal_name, gstin, pan, tan, state_code, address, city, pincode, e_invoicing,
          books_from)
        VALUES (${b.name}, ${b.legalName}, ${b.gstin}, ${b.pan}, ${b.tan}, ${b.stateCode}, ${b.address}, ${b.city},
          ${b.pincode}, ${b.eInvoicing}, ${b.booksFrom})
        RETURNING id`;
      await this.seedRoles(tx, e!.id);
      await this.audit(tx, claims, 'company.create', 'entity', e!.id, { name: b.name });
    });
    return this.companies(claims);
  }

  async updateCompany(
    claims: TenantClaims,
    id: string,
    input: CompanyInput & { rowVersion: number },
  ) {
    this.admin(claims);
    const b = this.checkCompany(input);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const [e] = await tx<{ row_version: number; books_from: string | null }[]>`
        SELECT row_version, to_char(books_from, 'YYYY-MM-DD') AS books_from FROM platform.entity WHERE id = ${id}
        FOR UPDATE`;
      if (!e) throw new NotFoundException({ code: 'company_not_found' });
      if (e.row_version !== input.rowVersion)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone else changed this company. Reload.',
        });
      if (b.booksFrom !== e.books_from) {
        const [early] = await tx`
          SELECT 1 FROM acc.voucher WHERE entity_id = ${id}
            AND (type = 'opening' OR ${b.booksFrom === null} OR voucher_date < ${b.booksFrom ?? '1900-01-01'}) LIMIT 1`;
        if (early)
          throw new ConflictException({
            code: 'books_have_entries',
            message:
              'The books already have entries from before that date, or opening balances: the start stays.',
          });
      }
      const [dup] =
        await tx`SELECT 1 FROM platform.entity WHERE lower(name) = lower(${b.name}) AND id <> ${id}`;
      if (dup)
        throw new ConflictException({
          code: 'company_exists',
          message: `There is already a company called ${b.name}.`,
        });
      await tx`UPDATE platform.entity SET name = ${b.name}, legal_name = ${b.legalName}, gstin = ${b.gstin}, pan = ${b.pan},
          tan = ${b.tan}, state_code = ${b.stateCode}, address = ${b.address}, city = ${b.city}, pincode = ${b.pincode},
          e_invoicing = ${b.eInvoicing}, books_from = ${b.booksFrom},
          updated_at = now(), row_version = row_version + 1
        WHERE id = ${id}`;
      await this.audit(tx, claims, 'company.update', 'entity', id, { name: b.name });
    });
    return this.companies(claims);
  }

  private async company(db: Db, id: string) {
    const [e] = await db<{ id: string; name: string; booksFrom: string | null }[]>`
      SELECT id, name, to_char(books_from, 'YYYY-MM-DD') AS "booksFrom" FROM platform.entity WHERE id = ${id}`;
    if (!e) throw new NotFoundException({ code: 'company_not_found' });
    return e;
  }

  // --- the chart and the account map ---

  private accountRows(db: Db) {
    return db<(AccountRow & { hasEntries: boolean; partyName: string | null })[]>`
      SELECT a.id, a.parent_id AS "parentId", a.is_group AS "isGroup", a.nature, a.code, a.name, a.kind,
        a.party_id AS "partyId", a.needs_project AS "needsProject", a.itc_blocked AS "itcBlocked",
        a.system_key AS "systemKey",
        a.closed_at IS NOT NULL AS closed, a.row_version AS "rowVersion",
        EXISTS (SELECT 1 FROM acc.voucher_line l WHERE l.account_id = a.id) AS "hasEntries", p.name AS "partyName"
      FROM acc.account a LEFT JOIN platform.party p ON p.id = a.party_id
      ORDER BY a.code`;
  }

  async chart(claims: TenantClaims) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return { accounts: await this.accountRows(db), mayEdit: claims.role === 'admin' };
  }

  private async account(db: Db, id: string, lock = false) {
    const [a] = await db<AccountRow[]>`
      SELECT id, parent_id AS "parentId", is_group AS "isGroup", nature, code, name, kind, party_id AS "partyId",
        needs_project AS "needsProject", itc_blocked AS "itcBlocked", system_key AS "systemKey",
        closed_at IS NOT NULL AS closed,
        row_version AS "rowVersion"
      FROM acc.account WHERE id = ${id} ${lock ? db`FOR UPDATE` : db``}`;
    if (!a) throw new NotFoundException({ code: 'account_not_found' });
    return a;
  }

  private async uniqueAccount(db: Db, code: string, name: string, except: string | null) {
    const [c] =
      await db`SELECT 1 FROM acc.account WHERE lower(code) = lower(${code}) AND id IS DISTINCT FROM ${except}`;
    if (c)
      throw new ConflictException({ code: 'code_exists', message: `The code ${code} is taken.` });
    const [n] =
      await db`SELECT 1 FROM acc.account WHERE lower(name) = lower(${name}) AND id IS DISTINCT FROM ${except}`;
    if (n)
      throw new ConflictException({
        code: 'name_exists',
        message: `There is already an account called ${name}.`,
      });
  }

  async addAccount(claims: TenantClaims, b: AccountInput) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const parent = await this.account(db, b.parentId);
    if (!parent.isGroup)
      throw new BadRequestException({
        code: 'parent_not_group',
        message: 'Accounts go under a group.',
      });
    if (b.isGroup && b.kind !== 'ordinary')
      throw new BadRequestException({
        code: 'group_kind',
        message: 'A group has no kind; its ledgers do.',
      });
    await this.uniqueAccount(db, b.code, b.name, null);
    const [a] = await db<{ id: string }[]>`
      INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, needs_project, itc_blocked, created_by)
      VALUES (${parent.id}, ${b.isGroup}, ${parent.nature}, ${b.code}, ${b.name}, ${b.kind},
        ${!b.isGroup && b.needsProject}, ${!b.isGroup && b.itcBlocked}, ${claims.sub})
      RETURNING id`;
    await this.audit(db, claims, 'account.create', 'account', a!.id, {
      code: b.code,
      name: b.name,
    });
    return this.chart(claims);
  }

  async updateAccount(
    claims: TenantClaims,
    id: string,
    b: Omit<AccountInput, 'isGroup'> & { closed: boolean; rowVersion: number },
  ) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const a = await this.account(tx, id, true);
      if (a.rowVersion !== b.rowVersion)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone else changed this account. Reload.',
        });
      if (!a.parentId)
        throw new BadRequestException({
          code: 'root_account',
          message: 'The five top groups stay as they are.',
        });
      if (b.parentId !== a.parentId) {
        const parent = await this.account(tx, b.parentId);
        if (!parent.isGroup)
          throw new BadRequestException({
            code: 'parent_not_group',
            message: 'Accounts go under a group.',
          });
        if (parent.nature !== a.nature)
          throw new BadRequestException({
            code: 'nature_change',
            message: 'An account moves only within its own top group (assets stay assets).',
          });
        const [loop] = await tx`
          WITH RECURSIVE up AS (SELECT id, parent_id FROM acc.account WHERE id = ${b.parentId}
            UNION ALL SELECT x.id, x.parent_id FROM acc.account x JOIN up ON x.id = up.parent_id)
          SELECT 1 FROM up WHERE id = ${id}`;
        if (loop)
          throw new BadRequestException({
            code: 'parent_loop',
            message: 'A group cannot go inside itself.',
          });
      }
      const kind = a.kind === 'party' || a.isGroup ? a.kind : b.kind;
      if (b.closed && !a.closed) {
        if (a.isGroup)
          throw new BadRequestException({
            code: 'group_close',
            message: 'Close its ledgers, not the group.',
          });
        const [mapped] =
          await tx`SELECT role FROM acc.account_role WHERE account_id = ${id} LIMIT 1`;
        if (mapped)
          throw new ConflictException({
            code: 'mapped_to_role',
            message: 'The account map posts to this ledger; map the role elsewhere first.',
          });
      }
      await this.uniqueAccount(tx, b.code, b.name, id);
      await tx`UPDATE acc.account SET code = ${b.code}, name = ${b.name}, parent_id = ${b.parentId}, kind = ${kind},
          needs_project = ${!a.isGroup && b.needsProject}, itc_blocked = ${!a.isGroup && b.itcBlocked},
          closed_at = ${b.closed ? (a.closed ? tx`closed_at` : tx`now()`) : null},
          updated_at = now(), row_version = row_version + 1
        WHERE id = ${id}`;
      await this.audit(tx, claims, 'account.update', 'account', id, {
        code: b.code,
        name: b.name,
        closed: b.closed,
      });
    });
    return this.chart(claims);
  }

  /** The party's ledger, opened on first use under debtors (clients) or creditors (everyone else). */
  async partyLedger(tx: Db, partyId: string) {
    const [had] = await tx<
      { id: string }[]
    >`SELECT id FROM acc.account WHERE party_id = ${partyId}`;
    if (had) return had.id;
    const [p] = await tx<{ name: string; is_client: boolean }[]>`
      SELECT name, is_client FROM platform.party WHERE id = ${partyId} AND deleted_at IS NULL`;
    if (!p) throw new NotFoundException({ code: 'party_not_found' });
    const [seq] = await tx<{ n: string }[]>`SELECT nextval('acc.party_code')::text AS n`;
    const code = `P${seq!.n.padStart(5, '0')}`;
    const [clash] = await tx`SELECT 1 FROM acc.account WHERE lower(name) = lower(${p.name})`;
    const [a] = await tx<{ id: string }[]>`
      INSERT INTO acc.account (parent_id, is_group, nature, code, name, kind, party_id)
      SELECT g.id, false, g.nature, ${code}, ${clash ? `${p.name} (${code})` : p.name}, 'party', ${partyId}
      FROM acc.account g WHERE g.system_key = ${partyGroupKey(p.is_client)}
      ON CONFLICT (party_id) DO NOTHING
      RETURNING id`;
    if (a) return a.id;
    const [again] = await tx<
      { id: string }[]
    >`SELECT id FROM acc.account WHERE party_id = ${partyId}`;
    return again!.id;
  }

  /** Gives a company every role it lacks, mapped to the seeded ledger. */
  private async seedRoles(tx: Db, entityId: string) {
    const roles = Object.entries(ROLES).map(([role, r]) => ({ role, key: r.key }));
    await tx`
      INSERT INTO acc.account_role (entity_id, role, account_id)
      SELECT ${entityId}, x.role, a.id
      FROM jsonb_to_recordset(${tx.json(roles)}) AS x(role text, key text) JOIN acc.account a ON a.system_key = x.key
      ON CONFLICT DO NOTHING`;
  }

  /** The ledger a role posts to for a company: for the later money steps. */
  async roleAccount(tx: Db, entityId: string, role: Role) {
    await this.seedRoles(tx, entityId);
    const [r] = await tx<{ account_id: string }[]>`
      SELECT account_id FROM acc.account_role WHERE entity_id = ${entityId} AND role = ${role}`;
    if (!r)
      throw new ConflictException({
        code: 'role_not_mapped',
        message: `Map "${ROLES[role].label}" in the account map.`,
      });
    return r.account_id;
  }

  async accountMap(claims: TenantClaims, entityId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    await this.company(db, entityId);
    await this.seedRoles(db, entityId);
    const rows = await db<{ role: string; account: { id: string; code: string; name: string } }[]>`
      SELECT r.role, json_build_object('id', a.id, 'code', a.code, 'name', a.name) AS account
      FROM acc.account_role r JOIN acc.account a ON a.id = r.account_id WHERE r.entity_id = ${entityId}`;
    const by = new Map(rows.map((r) => [r.role, r.account]));
    return {
      roles: Object.entries(ROLES).map(([role, r]) => ({
        role,
        label: r.label,
        account: by.get(role) ?? null,
      })),
      mayEdit: claims.role === 'admin',
    };
  }

  async mapRole(claims: TenantClaims, b: { entityId: string; role: string; accountId: string }) {
    this.admin(claims);
    if (!isRole(b.role)) throw new BadRequestException({ code: 'unknown_role' });
    const db = await this.tenants.forTenant(claims.ten);
    await this.company(db, b.entityId);
    const a = await this.account(db, b.accountId);
    if (a.isGroup || a.closed || a.kind === 'party')
      throw new BadRequestException({
        code: 'not_a_ledger',
        message: 'Map a role to an open ledger that is not a party.',
      });
    await db`
      INSERT INTO acc.account_role (entity_id, role, account_id, updated_by)
      VALUES (${b.entityId}, ${b.role}, ${b.accountId}, ${claims.sub})
      ON CONFLICT (entity_id, role) DO UPDATE SET account_id = EXCLUDED.account_id, updated_at = now(),
        updated_by = EXCLUDED.updated_by`;
    await this.audit(db, claims, 'account_map.set', 'entity', b.entityId, {
      role: b.role,
      accountId: b.accountId,
    });
    return this.accountMap(claims, b.entityId);
  }

  // --- vouchers ---

  private async lockedMonth(db: Db, entityId: string, date: string) {
    const [l] =
      await db`SELECT 1 FROM acc.period_lock WHERE entity_id = ${entityId} AND month = ${monthOf(date)}`;
    if (l)
      throw new ConflictException({
        code: 'period_locked',
        message: `${date.slice(0, 7)} is locked for this company. An admin can reopen it.`,
      });
  }

  /**
   * Posts a voucher inside the caller's transaction: checks the lines, resolves party ledgers, numbers it. Later money
   * steps post their documents through this with a `source`.
   */
  async post(
    tx: TransactionSql,
    claims: TenantClaims,
    v: Omit<VoucherInput, 'type'> & { type: VoucherType },
    source: { kind: string; id: string } | null = null,
    reverses: string | null = null,
  ) {
    const company = await this.company(tx, v.entityId);
    if (company.booksFrom && v.type !== 'opening' && v.date < company.booksFrom)
      throw new BadRequestException({
        code: 'before_books',
        message: `${company.name}'s books start on ${company.booksFrom}; enter earlier figures as opening balances.`,
      });
    await this.lockedMonth(tx, v.entityId, v.date);
    if (v.lines.length < 2)
      throw new BadRequestException({
        code: 'too_few_lines',
        message: 'A voucher has two lines or more.',
      });
    const lines: (LineInput & { accountId: string; d: Dec; c: Dec; kind: string })[] = [];
    let [dr, cr] = [0n, 0n];
    for (const [i, l] of v.lines.entries()) {
      const d = dec(l.debit || '0');
      const c = dec(l.credit || '0');
      if ((d === 0n) === (c === 0n) || d < 0n || c < 0n)
        throw new BadRequestException({
          code: 'bad_amount',
          message: `Line ${i + 1}: a debit or a credit, not both.`,
        });
      if (!l.accountId === !l.partyId)
        throw new BadRequestException({
          code: 'bad_line',
          message: `Line ${i + 1}: a ledger or a party.`,
        });
      const accountId = l.accountId ?? (await this.partyLedger(tx, l.partyId!));
      const [a] = await tx<
        { kind: string }[]
      >`SELECT kind FROM acc.account WHERE id = ${accountId}`;
      if (!a)
        throw new NotFoundException({
          code: 'account_not_found',
          message: `Line ${i + 1}: no such ledger.`,
        });
      if (l.siteId) {
        const [s] =
          await tx`SELECT 1 FROM proj.site WHERE id = ${l.siteId} AND project_id = ${l.projectId}`;
        if (!s)
          throw new BadRequestException({
            code: 'site_not_in_project',
            message: `Line ${i + 1}: the site is not the project's.`,
          });
      }
      dr += d;
      cr += c;
      lines.push({ ...l, accountId, d, c, kind: a.kind });
    }
    if (dr !== cr)
      throw new BadRequestException({
        code: 'unbalanced',
        message: `The debits (₹${money(dr)}) and credits (₹${money(cr)}) must be equal.`,
      });
    const money_ = (k: string) => k === 'bank' || k === 'cash';
    const rule =
      v.type === 'payment'
        ? lines.some((l) => money_(l.kind) && l.c > 0n) ||
          'A payment is paid out of a bank or cash ledger (credited).'
        : v.type === 'receipt'
          ? lines.some((l) => money_(l.kind) && l.d > 0n) ||
            'A receipt comes into a bank or cash ledger (debited).'
          : v.type === 'contra'
            ? lines.every((l) => money_(l.kind)) ||
              'A contra moves money between bank and cash ledgers only.'
            : v.type === 'journal'
              ? !lines.some((l) => money_(l.kind)) ||
                'Bank and cash go in payments, receipts and contras, not journals.'
              : true;
    // A reversal turns every line round, so it is the original's type without its rule.
    if (rule !== true && !reverses)
      throw new BadRequestException({ code: 'voucher_type', message: rule });
    const number = await nextNumber(
      tx,
      `voucher_${v.type}`,
      v.entityId,
      VOUCHER_TYPES[v.type].prefix,
      new Date(`${v.date}T00:00:00Z`),
    );
    try {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO acc.voucher (entity_id, type, number, voucher_date, narration, reference, total, reverses_id,
          source_kind, source_id, created_by)
        VALUES (${v.entityId}, ${v.type}, ${number}, ${v.date}, ${v.narration}, ${v.reference}, ${money(dr)},
          ${reverses}, ${source?.kind ?? null}, ${source?.id ?? null}, ${claims.sub})
        RETURNING id`;
      for (const [i, l] of lines.entries())
        await tx`
          INSERT INTO acc.voucher_line (voucher_id, position, account_id, debit, credit, project_id, site_id,
            cost_code_id, note)
          VALUES (${row!.id}, ${i + 1}, ${l.accountId}, ${money(l.d)}, ${money(l.c)}, ${l.projectId}, ${l.siteId},
            ${l.costCodeId}, ${l.note})`;
      return { id: row!.id, number };
    } catch (err) {
      fromDb(err);
    }
  }

  async createVoucher(claims: TenantClaims, v: VoucherInput) {
    await this.may(claims, 'accounts.post');
    if (!TYPED_IN.includes(v.type)) throw new BadRequestException({ code: 'voucher_type' });
    const db = await this.tenants.forTenant(claims.ten);
    // In the accounts mode where Tally holds the books (step 8b), vouchers are typed into Tally, not here.
    const [mode] = await db<{ value: unknown }[]>`
      SELECT value FROM platform.setting WHERE key = 'accounts.mode'`;
    if (mode?.value === 'tally')
      throw new ConflictException({
        code: 'tally_mode',
        message:
          'Tally keeps the books: type the voucher in Tally. Bills, receipts and payments still post here.',
      });
    const made = await db.begin((tx) => this.post(tx, claims, v)).catch(fromDb);
    return this.voucher(claims, made!.id);
  }

  async reverse(claims: TenantClaims, id: string, b: { date: string; reason: string }) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const made = await db
      .begin(async (tx) => {
        const [v] = await tx<
          {
            entity_id: string;
            type: VoucherType;
            number: string;
            date: string;
            reverses_id: string | null;
            source_kind: string | null;
          }[]
        >`
          SELECT entity_id, type, number, to_char(voucher_date, 'YYYY-MM-DD') AS date, reverses_id, source_kind
          FROM acc.voucher WHERE id = ${id}`;
        if (!v) throw new NotFoundException({ code: 'voucher_not_found' });
        // Vouchers are never updated, so the app may not lock their rows; one reversal at a time per voucher (the
        // unique reverses_id is the backstop).
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'reverse ' + id}))`;
        if (v.source_kind)
          throw new ConflictException({
            code: 'posted_by_document',
            message: 'This voucher was posted by a document; cancel the document instead.',
          });
        if (v.reverses_id)
          throw new ConflictException({
            code: 'is_reversal',
            message: 'A reversal is not reversed again.',
          });
        const [done] = await tx<
          { number: string }[]
        >`SELECT number FROM acc.voucher WHERE reverses_id = ${id}`;
        if (done)
          throw new ConflictException({
            code: 'already_reversed',
            message: `Already reversed by ${done.number}.`,
          });
        if (v.type === 'opening') this.admin(claims);
        if (b.date < v.date)
          throw new BadRequestException({
            code: 'before_voucher',
            message: 'A reversal is dated on or after the voucher.',
          });
        const lines = await tx<LineInput[]>`
          SELECT account_id AS "accountId", NULL AS "partyId", credit::text AS debit, debit::text AS credit,
            project_id AS "projectId", site_id AS "siteId", cost_code_id AS "costCodeId", note
          FROM acc.voucher_line WHERE voucher_id = ${id} ORDER BY position`;
        return this.post(
          tx,
          claims,
          {
            entityId: v.entity_id,
            type: v.type,
            date: b.date,
            narration: `Reversal of ${v.number}: ${b.reason}`,
            reference: v.number,
            lines,
          },
          null,
          id,
        );
      })
      .catch(fromDb);
    return this.voucher(claims, made!.id);
  }

  async vouchers(
    claims: TenantClaims,
    q: { entityId: string; type?: VoucherType; from?: string; to?: string; q?: string },
  ) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await db`
      SELECT v.id, v.type, v.number, to_char(v.voucher_date, 'YYYY-MM-DD') AS date, v.narration, v.reference,
        v.total::text AS total, v.reverses_id IS NOT NULL AS "isReversal",
        EXISTS (SELECT 1 FROM acc.voucher r WHERE r.reverses_id = v.id) AS reversed, v.source_kind AS "sourceKind"
      FROM acc.voucher v
      WHERE v.entity_id = ${q.entityId}
        ${q.type ? db`AND v.type = ${q.type}` : db``}
        ${q.from ? db`AND v.voucher_date >= ${q.from}` : db``}
        ${q.to ? db`AND v.voucher_date <= ${q.to}` : db``}
        ${q.q ? db`AND (v.number ILIKE ${'%' + q.q + '%'} OR v.narration ILIKE ${'%' + q.q + '%'} OR v.reference ILIKE ${'%' + q.q + '%'})` : db``}
      ORDER BY v.voucher_date DESC, v.created_at DESC LIMIT 500`;
    return { vouchers: rows, mayPost: await this.permissions.can(claims, 'accounts.post') };
  }

  private lineRows(db: Db, ids: string[]) {
    return db<
      {
        voucherId: string;
        position: number;
        account: { id: string; code: string; name: string };
        debit: string;
        credit: string;
        project: { id: string; number: string; name: string } | null;
        site: { id: string; name: string } | null;
        costCode: { id: string; code: string } | null;
        note: string;
      }[]
    >`
      SELECT l.voucher_id AS "voucherId", l.position,
        json_build_object('id', a.id, 'code', a.code, 'name', a.name) AS account, l.debit::text AS debit,
        l.credit::text AS credit,
        CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id', p.id, 'number', p.number, 'name', p.name) END
          AS project,
        CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id', s.id, 'name', s.name) END AS site,
        CASE WHEN c.id IS NULL THEN NULL ELSE json_build_object('id', c.id, 'code', c.code) END AS "costCode", l.note
      FROM acc.voucher_line l JOIN acc.account a ON a.id = l.account_id
      LEFT JOIN proj.project p ON p.id = l.project_id LEFT JOIN proj.site s ON s.id = l.site_id
      LEFT JOIN platform.cost_code c ON c.id = l.cost_code_id
      WHERE l.voucher_id IN ${db(ids)} ORDER BY l.voucher_id, l.position`;
  }

  async voucher(claims: TenantClaims, id: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const [v] = await db`
      SELECT v.id, v.entity_id AS "entityId", e.name AS company, v.type, v.number,
        to_char(v.voucher_date, 'YYYY-MM-DD') AS date, v.narration, v.reference, v.total::text AS total,
        v.source_kind AS "sourceKind", v.source_id AS "sourceId",
        (SELECT json_build_object('id', r.id, 'number', r.number) FROM acc.voucher r WHERE r.id = v.reverses_id)
          AS reverses,
        (SELECT json_build_object('id', r.id, 'number', r.number) FROM acc.voucher r WHERE r.reverses_id = v.id)
          AS "reversedBy",
        u.display_name AS "createdBy", v.created_at AS "createdAt"
      FROM acc.voucher v JOIN platform.entity e ON e.id = v.entity_id
      LEFT JOIN platform."user" u ON u.id = v.created_by WHERE v.id = ${id}`;
    if (!v) throw new NotFoundException({ code: 'voucher_not_found' });
    const lines = await this.lineRows(db, [id]);
    const mayReverse =
      !v.reversedBy &&
      !v.reverses &&
      !v.sourceKind &&
      (await this.permissions.can(claims, 'accounts.post')) &&
      (v.type !== 'opening' || claims.role === 'admin');
    return { ...v, lines, mayReverse };
  }

  // --- periods ---

  async periods(claims: TenantClaims, entityId: string, fy: string) {
    await this.may(claims, 'accounts.view');
    if (!/^\d{4}-\d{2}$/.test(fy)) throw new BadRequestException({ code: 'bad_year' });
    const db = await this.tenants.forTenant(claims.ten);
    await this.company(db, entityId);
    const start = Number(fy.slice(0, 4));
    const months = Array.from({ length: 12 }, (_, i) => {
      const m = ((3 + i) % 12) + 1;
      return `${m >= 4 ? start : start + 1}-${String(m).padStart(2, '0')}-01`;
    });
    const rows = await db<
      { month: string; lockedAt: string | null; lockedBy: string | null; vouchers: number }[]
    >`
      SELECT to_char(m.month, 'YYYY-MM-DD') AS month, l.locked_at AS "lockedAt", u.display_name AS "lockedBy",
        (SELECT count(*)::int FROM acc.voucher v WHERE v.entity_id = ${entityId}
          AND date_trunc('month', v.voucher_date) = m.month) AS vouchers
      FROM unnest(${months}::date[]) AS m(month)
      LEFT JOIN acc.period_lock l ON l.entity_id = ${entityId} AND l.month = m.month
      LEFT JOIN platform."user" u ON u.id = l.locked_by
      ORDER BY m.month`;
    return { fy, months: rows, mayEdit: claims.role === 'admin' };
  }

  async lockMonth(claims: TenantClaims, b: { entityId: string; month: string }) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await this.company(db, b.entityId);
    const month = monthOf(b.month);
    await db.begin(async (tx) => {
      const [made] = await tx`
        INSERT INTO acc.period_lock (entity_id, month, locked_by) VALUES (${b.entityId}, ${month}, ${claims.sub})
        ON CONFLICT DO NOTHING RETURNING 1`;
      if (made)
        await tx`INSERT INTO acc.period_event (entity_id, month, action, by_user)
          VALUES (${b.entityId}, ${month}, 'locked', ${claims.sub})`;
    });
    return this.periods(claims, b.entityId, fyOf(month).label);
  }

  async reopenMonth(claims: TenantClaims, b: { entityId: string; month: string; reason: string }) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const month = monthOf(b.month);
    await db.begin(async (tx) => {
      const [gone] =
        await tx`DELETE FROM acc.period_lock WHERE entity_id = ${b.entityId} AND month = ${month} RETURNING 1`;
      if (!gone)
        throw new ConflictException({ code: 'not_locked', message: 'That month is not locked.' });
      await tx`INSERT INTO acc.period_event (entity_id, month, action, reason, by_user)
        VALUES (${b.entityId}, ${month}, 'reopened', ${b.reason}, ${claims.sub})`;
      await this.audit(tx, claims, 'period.reopen', 'entity', b.entityId, {
        month,
        reason: b.reason,
      });
    });
    return this.periods(claims, b.entityId, fyOf(month).label);
  }

  // --- opening balances ---

  private async liveOpening(db: Db, entityId: string) {
    const [v] = await db<{ id: string; number: string; date: string }[]>`
      SELECT v.id, v.number, to_char(v.voucher_date, 'YYYY-MM-DD') AS date FROM acc.voucher v
      WHERE v.entity_id = ${entityId} AND v.type = 'opening'
        AND NOT EXISTS (SELECT 1 FROM acc.voucher r WHERE r.reverses_id = v.id)
        AND v.reverses_id IS NULL`;
    return v ?? null;
  }

  async opening(claims: TenantClaims, entityId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const company = await this.company(db, entityId);
    const v = await this.liveOpening(db, entityId);
    return {
      booksFrom: company.booksFrom,
      voucher: v ? { ...v, lines: await this.lineRows(db, [v.id]) } : null,
      mayEdit: claims.role === 'admin',
    };
  }

  /** Replaces the company's opening balances: the old voucher reversed, the new one posted, the day before the books. */
  async setOpening(claims: TenantClaims, entityId: string, lines: LineInput[]) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const company = await this.company(db, entityId);
    if (!company.booksFrom)
      throw new BadRequestException({
        code: 'no_books_from',
        message: "Set the date the company's books start first.",
      });
    const date = addDays(company.booksFrom, -1);
    await db
      .begin(async (tx) => {
        await tx`SELECT 1 FROM platform.entity WHERE id = ${entityId} FOR UPDATE`;
        const old = await this.liveOpening(tx, entityId);
        if (old) {
          const back = await tx<LineInput[]>`
            SELECT account_id AS "accountId", NULL AS "partyId", credit::text AS debit, debit::text AS credit,
              project_id AS "projectId", site_id AS "siteId", cost_code_id AS "costCodeId", note
            FROM acc.voucher_line WHERE voucher_id = ${old.id} ORDER BY position`;
          await this.post(
            tx,
            claims,
            {
              entityId,
              type: 'opening',
              date: old.date,
              narration: `Replaced: reversal of ${old.number}`,
              reference: old.number,
              lines: back,
            },
            null,
            old.id,
          );
        }
        await this.post(tx, claims, {
          entityId,
          type: 'opening',
          date,
          narration: 'Opening balances',
          reference: '',
          lines,
        });
        await this.audit(tx, claims, 'opening.set', 'entity', entityId, { lines: lines.length });
      })
      .catch(fromDb);
    return this.opening(claims, entityId);
  }

  /** Opening balances from rows of (ledger code or name, debit, credit): what each row is, and what is wrong. */
  async resolveOpening(
    claims: TenantClaims,
    rows: { rowNo: number; ledger: string; debit: string; credit: string }[],
  ) {
    this.admin(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const accounts = await db<
      { id: string; code: string; name: string; is_group: boolean; closed: boolean }[]
    >`
      SELECT id, code, name, is_group, closed_at IS NOT NULL AS closed FROM acc.account`;
    const parties = await db<{ id: string; name: string }[]>`
      SELECT id, name FROM platform.party WHERE deleted_at IS NULL`;
    const byCode = new Map(accounts.map((a) => [a.code.toLowerCase(), a]));
    const byName = new Map(accounts.map((a) => [a.name.toLowerCase(), a]));
    const partyByName = new Map(parties.map((p) => [p.name.toLowerCase(), p]));
    const problems: { rowNo: number; message: string }[] = [];
    const lines: (LineInput & { rowNo: number; label: string })[] = [];
    let [dr, cr] = [0n, 0n];
    for (const r of rows) {
      const key = r.ledger.trim().toLowerCase();
      const amount = (v: string) => {
        const t = v.replace(/[,₹\s]/g, '');
        return t === '' ? 0n : /^\d+(\.\d{1,2})?$/.test(t) ? dec(t) : null;
      };
      const [d, c] = [amount(r.debit), amount(r.credit)];
      if (d === null || c === null) {
        problems.push({ rowNo: r.rowNo, message: 'The debit and credit must be amounts.' });
        continue;
      }
      if (d === 0n && c === 0n) continue;
      const net = d - c;
      const a = byCode.get(key) ?? byName.get(key);
      const p = a ? undefined : partyByName.get(key);
      if (!a && !p) {
        problems.push({
          rowNo: r.rowNo,
          message: `No ledger or party called "${r.ledger.trim()}".`,
        });
        continue;
      }
      if (a && (a.is_group || a.closed)) {
        problems.push({
          rowNo: r.rowNo,
          message: `${a.name} is ${a.is_group ? 'a group' : 'closed'}.`,
        });
        continue;
      }
      if (net === 0n) continue;
      if (net > 0n) dr += net;
      else cr -= net;
      lines.push({
        rowNo: r.rowNo,
        label: a ? `${a.code} ${a.name}` : `${p!.name} (party)`,
        accountId: a?.id ?? null,
        partyId: p?.id ?? null,
        debit: net > 0n ? money(net) : '0',
        credit: net < 0n ? money(-net) : '0',
        projectId: null,
        siteId: null,
        costCodeId: null,
        note: '',
      });
    }
    return { lines, problems, debit: money(dr), credit: money(cr), balanced: dr === cr };
  }

  // --- reports ---

  async dayBook(claims: TenantClaims, q: { entityId: string; from: string; to: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const company = await this.company(db, q.entityId);
    const vouchers = await db<
      { id: string; type: string; number: string; date: string; narration: string; total: string }[]
    >`
      SELECT id, type, number, to_char(voucher_date, 'YYYY-MM-DD') AS date, narration, total::text AS total
      FROM acc.voucher WHERE entity_id = ${q.entityId} AND voucher_date BETWEEN ${q.from} AND ${q.to}
      ORDER BY voucher_date, created_at LIMIT 2001`;
    if (vouchers.length > 2000)
      throw new BadRequestException({
        code: 'too_many',
        message: 'More than 2,000 vouchers: choose fewer days.',
      });
    const lines = vouchers.length
      ? await this.lineRows(
          db,
          vouchers.map((v) => v.id),
        )
      : [];
    const by = groupBy(lines, (l) => l.voucherId);
    const total = vouchers.reduce((s, v) => s + dec(v.total), 0n);
    return {
      company: company.name,
      ...q,
      vouchers: vouchers.map((v) => ({ ...v, lines: by.get(v.id) ?? [] })),
      total: money(total),
    };
  }

  async ledger(
    claims: TenantClaims,
    accountId: string,
    q: { entityId: string; from: string; to: string; projectId?: string },
  ) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const company = await this.company(db, q.entityId);
    const a = await this.account(db, accountId);
    if (a.isGroup)
      throw new BadRequestException({
        code: 'not_a_ledger',
        message: 'Open a ledger, not a group.',
      });
    const project = q.projectId ? db`AND l.project_id = ${q.projectId}` : db``;
    const [o] = await db<{ net: string }[]>`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text AS net FROM acc.voucher_line l
      JOIN acc.voucher v ON v.id = l.voucher_id
      WHERE l.account_id = ${accountId} AND v.entity_id = ${q.entityId} AND v.voucher_date < ${q.from} ${project}`;
    const rows = await db<
      {
        voucherId: string;
        number: string;
        type: string;
        date: string;
        narration: string;
        debit: string;
        credit: string;
        note: string;
        project: string | null;
      }[]
    >`
      SELECT v.id AS "voucherId", v.number, v.type, to_char(v.voucher_date, 'YYYY-MM-DD') AS date, v.narration,
        l.debit::text AS debit, l.credit::text AS credit, l.note, p.number AS project
      FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id LEFT JOIN proj.project p ON p.id = l.project_id
      WHERE l.account_id = ${accountId} AND v.entity_id = ${q.entityId}
        AND v.voucher_date BETWEEN ${q.from} AND ${q.to} ${project}
      ORDER BY v.voucher_date, v.created_at, l.position`;
    let run = dec(o!.net);
    const opening = run;
    let [dr, cr] = [0n, 0n];
    const lines = rows.map((r) => {
      const [d, c] = [dec(r.debit), dec(r.credit)];
      run += d - c;
      dr += d;
      cr += c;
      return { ...r, balance: money(run) };
    });
    return {
      company: company.name,
      account: { id: a.id, code: a.code, name: a.name, nature: a.nature },
      ...q,
      opening: money(opening),
      lines,
      debit: money(dr),
      credit: money(cr),
      closing: money(run),
    };
  }

  /** Each account's balance as at a date (debit positive), groups the sum of what is under them. */
  async trialBalance(
    claims: TenantClaims,
    q: { entityId: string; asOf: string; projectId?: string },
  ) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const company = await this.company(db, q.entityId);
    const accounts = await this.accountRows(db);
    const sums = await db<{ account_id: string; dr: string; cr: string }[]>`
      SELECT l.account_id, sum(l.debit)::text AS dr, sum(l.credit)::text AS cr
      FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id
      WHERE v.entity_id = ${q.entityId} AND v.voucher_date <= ${q.asOf}
        ${q.projectId ? db`AND l.project_id = ${q.projectId}` : db``}
      GROUP BY l.account_id`;
    const net = new Map<string, Dec>(sums.map((s) => [s.account_id, dec(s.dr) - dec(s.cr)]));
    const children = groupBy(accounts, (a) => a.parentId ?? '');
    const total = (id: string): Dec =>
      (net.get(id) ?? 0n) + (children.get(id) ?? []).reduce((s, c) => s + total(c.id), 0n);
    const rows: {
      id: string;
      code: string;
      name: string;
      isGroup: boolean;
      depth: number;
      debit: string | null;
      credit: string | null;
    }[] = [];
    const walk = (parent: string, depth: number) => {
      for (const a of children.get(parent) ?? []) {
        const t = total(a.id);
        if (t === 0n && !(a.isGroup && depth === 0)) continue;
        rows.push({
          id: a.id,
          code: a.code,
          name: a.name,
          isGroup: a.isGroup,
          depth,
          debit: t > 0n ? money(t) : null,
          credit: t < 0n ? money(-t) : null,
        });
        walk(a.id, depth + 1);
      }
    };
    walk('', 0);
    const all = [...net.values()];
    const dr = all.filter((v) => v > 0n).reduce((s, v) => s + v, 0n);
    const cr = -all.filter((v) => v < 0n).reduce((s, v) => s + v, 0n);
    return { company: company.name, ...q, rows, debit: money(dr), credit: money(cr) };
  }
}
