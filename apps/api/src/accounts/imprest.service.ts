// Site imprest (docs/wave7-plan.md step 7d.6): a petty-cash float with someone on a project's team. Accounts pays
// advances into it (a payment: staff advances debited, the bank or cash credited); the holder enters what they spend
// (the expense ledger, the bill); accounts settles the unsettled spends in one journal (each expense debited to the
// project, staff advances credited) and takes back what is left (a receipt). The float closes at nothing in hand.
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
import { dec, fmt } from '../rates/decimal.js';
import { nextNumber } from '../tender/numbering.js';
import { fromDb } from './accounts-rules.js';
import { LedgerService } from './ledger.service.js';

type Db = Sql | TransactionSql;
interface Head {
  id: string;
  entity_id: string;
  project_id: string;
  custodian_id: string;
  float_limit: string;
  status: string;
  number: string;
}
export interface EntryInput {
  date: string;
  amount: string;
  accountId: string;
  description: string;
  reference: string;
}

@Injectable()
export class ImprestService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly ledger: LedgerService,
  ) {}

  private async poster(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'accounts.post')))
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Paying and settling an imprest needs the permission to post.',
      });
  }

  private async head(db: Db, id: string, lock = false) {
    const [h] = lock
      ? await db<Head[]>`SELECT * FROM acc.imprest WHERE id = ${id} FOR UPDATE`
      : await db<Head[]>`SELECT * FROM acc.imprest WHERE id = ${id}`;
    if (!h) throw new NotFoundException({ code: 'not_found' });
    return h;
  }

  private async sums(db: Db, id: string) {
    const [s] = await db<
      { advanced: string; spent: string; unsettled: string; returned: string; balance: string }[]
    >`
      SELECT coalesce(sum(amount) FILTER (WHERE kind = 'advance'), 0)::text AS advanced,
        coalesce(sum(amount) FILTER (WHERE kind = 'expense'), 0)::text AS spent,
        coalesce(sum(amount) FILTER (WHERE kind = 'expense' AND settlement_id IS NULL), 0)::text AS unsettled,
        coalesce(sum(amount) FILTER (WHERE kind = 'return'), 0)::text AS returned,
        (coalesce(sum(amount) FILTER (WHERE kind = 'advance'), 0)
          - coalesce(sum(amount) FILTER (WHERE kind <> 'advance'), 0))::text AS balance
      FROM acc.imprest_entry WHERE imprest_id = ${id}`;
    return s!;
  }

  private open(h: Head) {
    if (h.status !== 'open')
      throw new ConflictException({ code: 'closed', message: 'The imprest is closed.' });
  }

  async list(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const imprests = await db`
      SELECT i.id, i.number, i.purpose, i.float_limit AS "floatLimit", i.status, u.display_name AS custodian,
        coalesce(sum(e.amount) FILTER (WHERE e.kind = 'advance'), 0) AS advanced,
        coalesce(sum(e.amount) FILTER (WHERE e.kind = 'expense'), 0) AS spent,
        coalesce(sum(e.amount) FILTER (WHERE e.kind = 'expense' AND e.settlement_id IS NULL), 0) AS unsettled,
        coalesce(sum(e.amount) FILTER (WHERE e.kind = 'advance'), 0)
          - coalesce(sum(e.amount) FILTER (WHERE e.kind <> 'advance'), 0) AS balance
      FROM acc.imprest i JOIN platform."user" u ON u.id = i.custodian_id
      LEFT JOIN acc.imprest_entry e ON e.imprest_id = i.id
      WHERE i.project_id = ${projectId} GROUP BY i.id, u.display_name ORDER BY i.created_at DESC`;
    const team = await db`
      SELECT u.id, u.display_name AS name FROM proj.member m JOIN platform."user" u ON u.id = m.user_id
      WHERE m.project_id = ${projectId} ORDER BY u.display_name`;
    return { imprests, team, mayPost: await this.permissions.can(claims, 'accounts.post') };
  }

  async get(claims: TenantClaims, id: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const h = await this.head(db, id);
    await this.projects.access(db, claims, h.project_id);
    const [info] = await db`
      SELECT i.id, i.number, i.purpose, i.float_limit AS "floatLimit", i.status, i.project_id AS "projectId",
        p.name AS project, i.custodian_id AS "custodianId", u.display_name AS custodian, en.name AS company
      FROM acc.imprest i JOIN proj.project p ON p.id = i.project_id JOIN platform."user" u ON u.id = i.custodian_id
      JOIN platform.entity en ON en.id = i.entity_id WHERE i.id = ${id}`;
    const entries = await db`
      SELECT e.id, e.kind, to_char(e.entry_date, 'YYYY-MM-DD') AS date, e.amount, a.name AS account, e.description,
        e.reference, v.number AS voucher, e.voucher_id AS "voucherId", e.settlement_id IS NOT NULL AS settled
      FROM acc.imprest_entry e JOIN acc.account a ON a.id = e.account_id LEFT JOIN acc.voucher v ON v.id = e.voucher_id
      WHERE e.imprest_id = ${id} ORDER BY e.entry_date, e.created_at`;
    const ledgers = await db`
      SELECT id, code, name, kind, nature FROM acc.account
      WHERE NOT is_group AND closed_at IS NULL AND party_id IS NULL
        AND (kind IN ('bank', 'cash') OR nature = 'expense') ORDER BY code`;
    const mayPost = await this.permissions.can(claims, 'accounts.post');
    return {
      ...info,
      totals: await this.sums(db, id),
      entries,
      moneyLedgers: ledgers.filter((l) => l.kind === 'bank' || l.kind === 'cash'),
      expenseLedgers: ledgers.filter((l) => l.nature === 'expense' && l.kind === 'ordinary'),
      mayPost,
      maySpend: h.custodian_id === claims.sub || mayPost,
    };
  }

  async create(
    claims: TenantClaims,
    projectId: string,
    b: { custodianId: string; purpose: string; floatLimit: string },
  ) {
    await this.poster(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const [m] =
      await db`SELECT 1 FROM proj.member WHERE project_id = ${projectId} AND user_id = ${b.custodianId}`;
    if (!m)
      throw new BadRequestException({
        code: 'not_on_project',
        message: "The holder must be on the project's team.",
      });
    const id = await db.begin(async (tx) => {
      const [p] = await tx<
        { entity_id: string }[]
      >`SELECT entity_id FROM proj.project WHERE id = ${projectId}`;
      const number = await nextNumber(tx, 'imprest', p!.entity_id, 'IMP', new Date());
      const [i] = await tx<{ id: string }[]>`
        INSERT INTO acc.imprest (entity_id, project_id, number, custodian_id, purpose, float_limit, created_by)
        VALUES (${p!.entity_id}, ${projectId}, ${number}, ${b.custodianId}, ${b.purpose}, ${b.floatLimit},
          ${claims.sub})
        RETURNING id`;
      return i!.id;
    });
    return this.get(claims, id);
  }

  private async moneyLedger(db: Db, accountId: string) {
    const [a] = await db<{ kind: string }[]>`
      SELECT kind FROM acc.account WHERE id = ${accountId} AND NOT is_group AND closed_at IS NULL`;
    if (!a || (a.kind !== 'bank' && a.kind !== 'cash'))
      throw new BadRequestException({
        code: 'not_money',
        message: 'Pay from (or take back into) a bank or cash ledger.',
      });
  }

  /** Money paid into the float: a payment voucher. */
  async advance(claims: TenantClaims, id: string, b: EntryInput) {
    await this.poster(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const h = await this.head(tx, id, true);
        await this.projects.access(tx, claims, h.project_id);
        this.open(h);
        await this.moneyLedger(tx, b.accountId);
        const s = await this.sums(tx, id);
        if (dec(h.float_limit) > 0n && dec(s.balance) + dec(b.amount) > dec(h.float_limit))
          throw new BadRequestException({
            code: 'over_limit',
            message: `That would put ₹${fmt(dec(s.balance) + dec(b.amount), 2)} in hand, over the float of ₹${h.float_limit}.`,
          });
        const advances = await this.ledger.roleAccount(tx, h.entity_id, 'staff_advances');
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: h.entity_id,
            type: 'payment',
            date: b.date,
            narration: `Imprest ${h.number}: advance${b.description ? `, ${b.description}` : ''}`,
            reference: b.reference,
            lines: [
              this.line(advances, b.amount, '0', h.project_id, `Imprest ${h.number}`),
              this.line(b.accountId, '0', b.amount, null, ''),
            ],
          },
          { kind: 'imprest', id },
        );
        await tx`
          INSERT INTO acc.imprest_entry (imprest_id, kind, entry_date, amount, account_id, description, reference,
            voucher_id, created_by)
          VALUES (${id}, 'advance', ${b.date}, ${b.amount}, ${b.accountId}, ${b.description}, ${b.reference},
            ${v!.id}, ${claims.sub})`;
      })
      .catch(fromDb);
    return this.get(claims, id);
  }

  private line(
    accountId: string,
    debit: string,
    credit: string,
    projectId: string | null,
    note: string,
  ) {
    return {
      accountId,
      partyId: null,
      debit,
      credit,
      projectId,
      siteId: null,
      costCodeId: null,
      note,
    };
  }

  /** A spend from the float, entered by its holder (or accounts); booked when settled. */
  async expense(claims: TenantClaims, id: string, b: EntryInput) {
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      const h = await this.head(tx, id, true);
      await this.projects.access(tx, claims, h.project_id);
      if (h.custodian_id !== claims.sub && !(await this.permissions.can(claims, 'accounts.post')))
        throw new ForbiddenException({
          code: 'forbidden',
          message: 'Its holder or accounts enters what an imprest spent.',
        });
      this.open(h);
      const [a] = await tx<{ nature: string; kind: string }[]>`
        SELECT nature, kind FROM acc.account WHERE id = ${b.accountId} AND NOT is_group AND closed_at IS NULL`;
      if (!a || a.nature !== 'expense' || a.kind !== 'ordinary')
        throw new BadRequestException({
          code: 'not_expense',
          message: 'Choose an expense ledger.',
        });
      const s = await this.sums(tx, id);
      if (dec(b.amount) > dec(s.balance))
        throw new BadRequestException({
          code: 'over_balance',
          message: `Only ₹${fmt(dec(s.balance), 2)} is in hand.`,
        });
      await tx`
        INSERT INTO acc.imprest_entry (imprest_id, kind, entry_date, amount, account_id, description, reference,
          created_by)
        VALUES (${id}, 'expense', ${b.date}, ${b.amount}, ${b.accountId}, ${b.description}, ${b.reference},
          ${claims.sub})`;
    });
    return this.get(claims, id);
  }

  /** The unsettled spends into the books: one journal, each expense to the project, staff advances credited. */
  async settle(claims: TenantClaims, id: string, b: { date: string }) {
    await this.poster(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const h = await this.head(tx, id, true);
        await this.projects.access(tx, claims, h.project_id);
        const spends = await tx<
          {
            id: string;
            amount: string;
            account_id: string;
            description: string;
            reference: string;
          }[]
        >`
          SELECT id, amount::text, account_id, description, reference FROM acc.imprest_entry
          WHERE imprest_id = ${id} AND kind = 'expense' AND settlement_id IS NULL AND entry_date <= ${b.date}
          ORDER BY entry_date, created_at`;
        if (!spends.length)
          throw new BadRequestException({
            code: 'nothing_to_settle',
            message: 'No spend to settle up to that date.',
          });
        const total = spends.reduce((t, s) => t + dec(s.amount), 0n);
        const advances = await this.ledger.roleAccount(tx, h.entity_id, 'staff_advances');
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: h.entity_id,
            type: 'journal',
            date: b.date,
            narration: `Imprest ${h.number}: ${spends.length} spends settled`,
            reference: h.number,
            lines: [
              ...spends.map((s) =>
                this.line(
                  s.account_id,
                  s.amount,
                  '0',
                  h.project_id,
                  [s.description, s.reference].filter(Boolean).join(' · '),
                ),
              ),
              this.line(advances, '0', fmt(total, 2), h.project_id, `Imprest ${h.number}`),
            ],
          },
          { kind: 'imprest', id },
        );
        const [st] = await tx<{ id: string }[]>`
          INSERT INTO acc.imprest_settlement (imprest_id, settled_on, total, voucher_id, created_by)
          VALUES (${id}, ${b.date}, ${fmt(total, 2)}, ${v!.id}, ${claims.sub}) RETURNING id`;
        await tx`
          UPDATE acc.imprest_entry SET settlement_id = ${st!.id}, voucher_id = ${v!.id}
          WHERE id IN ${tx(spends.map((s) => s.id))}`;
      })
      .catch(fromDb);
    return this.get(claims, id);
  }

  /** What is left taken back (a receipt); with nothing left and nothing unsettled, the float may close. */
  async takeBack(claims: TenantClaims, id: string, b: EntryInput & { close: boolean }) {
    await this.poster(claims);
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const h = await this.head(tx, id, true);
        await this.projects.access(tx, claims, h.project_id);
        this.open(h);
        const s = await this.sums(tx, id);
        if (dec(b.amount) > 0n) {
          await this.moneyLedger(tx, b.accountId);
          if (dec(b.amount) > dec(s.balance))
            throw new BadRequestException({
              code: 'over_balance',
              message: `Only ₹${fmt(dec(s.balance), 2)} is in hand.`,
            });
          const advances = await this.ledger.roleAccount(tx, h.entity_id, 'staff_advances');
          const v = await this.ledger.post(
            tx,
            claims,
            {
              entityId: h.entity_id,
              type: 'receipt',
              date: b.date,
              narration: `Imprest ${h.number}: balance taken back`,
              reference: b.reference,
              lines: [
                this.line(b.accountId, b.amount, '0', null, ''),
                this.line(advances, '0', b.amount, h.project_id, `Imprest ${h.number}`),
              ],
            },
            { kind: 'imprest', id },
          );
          await tx`
            INSERT INTO acc.imprest_entry (imprest_id, kind, entry_date, amount, account_id, description, reference,
              voucher_id, created_by)
            VALUES (${id}, 'return', ${b.date}, ${b.amount}, ${b.accountId}, ${b.description}, ${b.reference},
              ${v!.id}, ${claims.sub})`;
        }
        if (b.close) {
          const after = await this.sums(tx, id);
          if (dec(after.balance) !== 0n || dec(after.unsettled) !== 0n)
            throw new ConflictException({
              code: 'not_squared',
              message: 'Settle every spend and take back what is left before closing.',
            });
          await tx`UPDATE acc.imprest SET status = 'closed' WHERE id = ${id}`;
        }
      })
      .catch(fromDb);
    return this.get(claims, id);
  }
}
