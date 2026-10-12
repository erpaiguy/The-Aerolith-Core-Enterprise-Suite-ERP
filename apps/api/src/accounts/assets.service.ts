// Fixed assets (docs/wave3-plan.md step 9): classes; the register (from a supplier's bill or opening balances), each
// asset's moves between sites and projects; depreciation runs posted as journals (and reversed); the Income Tax
// blocks; disposals with their gain or loss.
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
import { audit } from '../tender/tender-records.js';
import { fromDb, fyOf } from './accounts-rules.js';
import { addDays, charge, daysBetween, taxBlock } from './depreciation.js';
import { LedgerService, type LineInput } from './ledger.service.js';

type Db = Sql | TransactionSql;
const money = (v: Dec) => fmt(v, 2);

interface AssetRow {
  id: string;
  entity_id: string;
  number: string;
  name: string;
  class_id: string;
  source: 'bill' | 'opening';
  purchased_on: string;
  put_to_use_on: string;
  cost: string;
  opening_depreciation: string;
  it_opening_wdv: string | null;
  status: 'active' | 'disposed';
  disposed_on: string | null;
  proceeds: string | null;
  life_years: string;
  method: 'slm' | 'wdv';
  residual_pct: string;
  it_rate: string;
  account_id: string;
  class_name: string;
}
export interface AssetClassInput {
  name: string;
  lifeYears: string;
  method: 'slm' | 'wdv';
  residualPct: string;
  itRate: string;
  accountId: string;
}

@Injectable()
export class AssetService {
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
            ? 'Fixed assets need the accounts permission.'
            : 'This needs the permission to post.',
      });
  }

  // --- classes ---

  async classes(claims: TenantClaims) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT c.id, c.name, c.life_years::text AS "lifeYears", c.method, c.residual_pct::text AS "residualPct",
        c.it_rate::text AS "itRate", json_build_object('id', a.id, 'code', a.code, 'name', a.name) AS account,
        c.row_version AS "rowVersion"
      FROM acc.asset_class c JOIN acc.account a ON a.id = c.account_id ORDER BY c.name`;
  }

  async saveClass(
    claims: TenantClaims,
    id: string | null,
    input: AssetClassInput & { rowVersion?: number },
  ) {
    if (claims.role !== 'admin')
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Only an admin changes asset classes.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    const [a] = await db<{ ok: boolean }[]>`
      SELECT a.is_group = false AND g.system_key = 'fixed_assets' AS ok FROM acc.account a
      JOIN acc.account g ON g.id = a.parent_id WHERE a.id = ${input.accountId}`;
    if (!a?.ok)
      throw new BadRequestException({
        code: 'not_a_fixed_asset_ledger',
        message: 'Choose a ledger under fixed assets.',
      });
    await db
      .begin(async (tx) => {
        if (id) {
          const [u] = await tx`
            UPDATE acc.asset_class SET name = ${input.name}, life_years = ${input.lifeYears}, method = ${input.method},
              residual_pct = ${input.residualPct}, it_rate = ${input.itRate}, account_id = ${input.accountId},
              updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
            WHERE id = ${id} AND row_version = ${input.rowVersion ?? 0} RETURNING 1`;
          if (!u)
            throw new ConflictException({
              code: 'stale',
              message: 'Someone else changed this class. Reload.',
            });
        } else
          await tx`INSERT INTO acc.asset_class (name, life_years, method, residual_pct, it_rate, account_id, updated_by)
            VALUES (${input.name}, ${input.lifeYears}, ${input.method}, ${input.residualPct}, ${input.itRate},
              ${input.accountId}, ${claims.sub})`;
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'class_exists',
            message: `There is already a class ${input.name}.`,
          });
        throw err;
      });
    return this.classes(claims);
  }

  // --- the register ---

  private async row(db: Db, id: string, lock = false) {
    const [a] = await db<AssetRow[]>`
      SELECT a.id, a.entity_id, a.number, a.name, a.class_id, a.source, to_char(a.purchased_on, 'YYYY-MM-DD') AS purchased_on,
        to_char(a.put_to_use_on, 'YYYY-MM-DD') AS put_to_use_on, a.cost::text AS cost,
        a.opening_depreciation::text AS opening_depreciation, a.it_opening_wdv::text AS it_opening_wdv, a.status,
        to_char(a.disposed_on, 'YYYY-MM-DD') AS disposed_on, a.proceeds::text AS proceeds, c.life_years::text AS life_years,
        c.method, c.residual_pct::text AS residual_pct, c.it_rate::text AS it_rate, c.account_id, c.name AS class_name
      FROM acc.asset a JOIN acc.asset_class c ON c.id = a.class_id WHERE a.id = ${id} ${lock ? db`FOR UPDATE OF a` : db``}`;
    if (!a) throw new NotFoundException({ code: 'asset_not_found' });
    return a;
  }

  /** Depreciation charged to an asset: its opening and every line of runs not reversed; the last day charged. */
  private async charged(db: Db, assetId: string) {
    const [c] = await db<{ total: string; upto: string | null }[]>`
      SELECT coalesce(sum(l.amount), 0)::text AS total, to_char(max(l.date_to), 'YYYY-MM-DD') AS upto
      FROM acc.depreciation_line l JOIN acc.depreciation_run r ON r.id = l.run_id
      WHERE l.asset_id = ${assetId} AND r.reversed_voucher_id IS NULL`;
    return { total: dec(c!.total), upto: c!.upto };
  }

  /** Charged before a date, for WDV's base at a year's start. */
  private async chargedBefore(db: Db, assetId: string, date: string) {
    const [c] = await db<{ total: string }[]>`
      SELECT coalesce(sum(l.amount), 0)::text AS total FROM acc.depreciation_line l
      JOIN acc.depreciation_run r ON r.id = l.run_id
      WHERE l.asset_id = ${assetId} AND r.reversed_voucher_id IS NULL AND l.date_to < ${date}`;
    return dec(c!.total);
  }

  private moves(db: Db, assetId: string) {
    return db<{ from: string; projectId: string | null; siteId: string | null }[]>`
      SELECT to_char(moved_on, 'YYYY-MM-DD') AS from, project_id AS "projectId", site_id AS "siteId"
      FROM acc.asset_move WHERE asset_id = ${assetId} ORDER BY moved_on`;
  }

  async register(
    claims: TenantClaims,
    input: {
      entityId: string;
      name: string;
      classId: string;
      source: 'bill' | 'opening';
      vendorBillId: string | null;
      purchasedOn: string;
      putToUseOn: string;
      cost: string;
      openingDepreciation: string;
      itOpeningWdv: string | null;
      serialNo: string;
      projectId: string | null;
      siteId: string | null;
      custodianId: string | null;
    },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const id = await db
      .begin(async (tx) => {
        const [cls] = await tx<
          { account_id: string }[]
        >`SELECT account_id FROM acc.asset_class WHERE id = ${input.classId}`;
        if (!cls)
          throw new BadRequestException({ code: 'unknown_class', message: 'No such asset class.' });
        if (input.source === 'bill') {
          if (!input.vendorBillId)
            throw new BadRequestException({
              code: 'bill_needed',
              message: "Name the supplier's bill it came on.",
            });
          const [b] = await tx<{ ok: boolean; on_ledger: string }[]>`
            SELECT b.status = 'posted' AND b.entity_id = ${input.entityId} AS ok,
              coalesce((SELECT sum(l.amount) FROM acc.vendor_bill_line l WHERE l.bill_id = b.id
                AND l.account_id = ${cls.account_id}), 0)::text AS on_ledger
            FROM acc.vendor_bill b WHERE b.id = ${input.vendorBillId}`;
          if (!b?.ok)
            throw new BadRequestException({
              code: 'bill_not_posted',
              message: "The supplier's bill is not posted.",
            });
          const [already] = await tx<{ v: string }[]>`
            SELECT coalesce(sum(cost), 0)::text AS v FROM acc.asset WHERE vendor_bill_id = ${input.vendorBillId}`;
          if (dec(input.cost) + dec(already!.v) > dec(b.on_ledger))
            throw new BadRequestException({
              code: 'over_bill',
              message: `The bill put ₹${b.on_ledger} on this class's ledger; ₹${already!.v} of it is registered already.`,
            });
        } else if (input.vendorBillId)
          throw new BadRequestException({
            code: 'opening_from_bill',
            message: 'An opening asset has no bill.',
          });
        if (input.putToUseOn < input.purchasedOn)
          throw new BadRequestException({
            code: 'used_before_bought',
            message: 'Put to use on or after it was bought.',
          });
        const number = await nextNumber(
          tx,
          'asset',
          input.entityId,
          'FA',
          new Date(`${input.putToUseOn}T00:00:00Z`),
        );
        const [a] = await tx<{ id: string }[]>`
          INSERT INTO acc.asset (entity_id, number, name, class_id, source, vendor_bill_id, purchased_on, put_to_use_on,
            cost, opening_depreciation, it_opening_wdv, serial_no, custodian_id, created_by)
          VALUES (${input.entityId}, ${number}, ${input.name}, ${input.classId}, ${input.source}, ${input.vendorBillId},
            ${input.purchasedOn}, ${input.putToUseOn}, ${input.cost}, ${input.openingDepreciation}, ${input.itOpeningWdv},
            ${input.serialNo}, ${input.custodianId}, ${claims.sub})
          RETURNING id`;
        await tx`INSERT INTO acc.asset_move (asset_id, moved_on, project_id, site_id, created_by)
          VALUES (${a!.id}, ${input.putToUseOn}, ${input.projectId}, ${input.siteId}, ${claims.sub})`;
        await audit(tx, claims.sub, 'asset.register', 'asset', a!.id, { number, cost: input.cost });
        return a!.id;
      })
      .catch(fromDb);
    return this.asset(claims, id);
  }

  async asset(claims: TenantClaims, id: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const a = await this.row(db, id);
    const c = await this.charged(db, id);
    const moves = await db`
      SELECT to_char(m.moved_on, 'YYYY-MM-DD') AS date, p.number AS project, p.name AS "projectName", s.name AS site
      FROM acc.asset_move m LEFT JOIN proj.project p ON p.id = m.project_id LEFT JOIN proj.site s ON s.id = m.site_id
      WHERE m.asset_id = ${id} ORDER BY m.moved_on`;
    const lines = await db`
      SELECT to_char(l.date_from, 'YYYY-MM-DD') AS "from", to_char(l.date_to, 'YYYY-MM-DD') AS "to",
        l.amount::text AS amount, p.number AS project, v.number AS voucher
      FROM acc.depreciation_line l JOIN acc.depreciation_run r ON r.id = l.run_id
      LEFT JOIN proj.project p ON p.id = l.project_id LEFT JOIN acc.voucher v ON v.id = r.voucher_id
      WHERE l.asset_id = ${id} AND r.reversed_voucher_id IS NULL ORDER BY l.date_from`;
    return {
      id: a.id,
      number: a.number,
      name: a.name,
      class: {
        id: a.class_id,
        name: a.class_name,
        method: a.method,
        lifeYears: a.life_years,
        itRate: a.it_rate,
      },
      source: a.source,
      purchasedOn: a.purchased_on,
      putToUseOn: a.put_to_use_on,
      cost: a.cost,
      depreciation: money(dec(a.opening_depreciation) + c.total),
      bookValue: money(dec(a.cost) - dec(a.opening_depreciation) - c.total),
      depreciatedTo: c.upto,
      status: a.status,
      disposedOn: a.disposed_on,
      proceeds: a.proceeds,
      moves,
      lines,
    };
  }

  async assets(claims: TenantClaims, entityId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT a.id, a.number, a.name, c.name AS class, a.status, to_char(a.put_to_use_on, 'YYYY-MM-DD') AS "putToUseOn",
        a.cost::text AS cost,
        (a.cost - a.opening_depreciation - coalesce((SELECT sum(l.amount) FROM acc.depreciation_line l
          JOIN acc.depreciation_run r ON r.id = l.run_id WHERE l.asset_id = a.id AND r.reversed_voucher_id IS NULL), 0))::text
          AS "bookValue",
        (SELECT p.number FROM acc.asset_move m JOIN proj.project p ON p.id = m.project_id WHERE m.asset_id = a.id
          ORDER BY m.moved_on DESC LIMIT 1) AS project
      FROM acc.asset a JOIN acc.asset_class c ON c.id = a.class_id
      WHERE a.entity_id = ${entityId} ORDER BY a.number`;
  }

  async transfer(
    claims: TenantClaims,
    id: string,
    input: { date: string; projectId: string | null; siteId: string | null },
  ) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const a = await this.row(tx, id, true);
        if (a.status !== 'active')
          throw new ConflictException({ code: 'disposed', message: 'The asset is disposed.' });
        const c = await this.charged(tx, id);
        if (input.date <= a.put_to_use_on || (c.upto && input.date <= c.upto))
          throw new BadRequestException({
            code: 'before_last_charge',
            message: 'Move it after its last depreciation and after it was put to use.',
          });
        await tx`INSERT INTO acc.asset_move (asset_id, moved_on, project_id, site_id, created_by)
          VALUES (${id}, ${input.date}, ${input.projectId}, ${input.siteId}, ${claims.sub})`;
        await audit(tx, claims.sub, 'asset.transfer', 'asset', id, { ...input });
      })
      .catch((err: unknown) => {
        if ((err as { code?: string }).code === '23505')
          throw new ConflictException({
            code: 'moved_that_day',
            message: 'It already moved on that day.',
          });
        return fromDb(err);
      });
    return this.asset(claims, id);
  }

  // --- depreciation runs ---

  /** Charges every active asset of the company (or the ones named) up to the date; one journal for the lot. */
  private async runIn(
    tx: TransactionSql,
    claims: TenantClaims,
    entityId: string,
    upto: string,
    only: string[] | null,
  ) {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${'depreciation ' + entityId}))`;
    const ids = (
      await tx<{ id: string }[]>`
        SELECT id FROM acc.asset WHERE entity_id = ${entityId} AND status = 'active' AND put_to_use_on <= ${upto}
          ${only ? tx`AND id IN ${tx(only)}` : tx``}
        ORDER BY number`
    ).map((r) => r.id);
    const [e] = await tx<{ books_from: string | null }[]>`
      SELECT to_char(books_from, 'YYYY-MM-DD') AS books_from FROM platform.entity WHERE id = ${entityId}`;
    const booksFrom = e?.books_from ?? null;
    const lines: {
      assetId: string;
      from: string;
      to: string;
      projectId: string | null;
      amount: string;
      account: string;
    }[] = [];
    for (const id of ids) {
      const a = await this.row(tx, id);
      const c = await this.charged(tx, id);
      // An opening asset's earlier depreciation is in its opening figure: it is charged from the books' start.
      const start =
        a.source === 'opening' && booksFrom && booksFrom > a.put_to_use_on
          ? booksFrom
          : a.put_to_use_on;
      const from = c.upto ? addDays(c.upto, 1) : start;
      if (from > upto) continue;
      const fyFrom = fyOf(from).from;
      const before = await this.chargedBefore(tx, id, fyFrom);
      const yearOpening = dec(a.cost) - dec(a.opening_depreciation) - before;
      for (const p of charge(
        {
          cost: a.cost,
          charged: money(dec(a.opening_depreciation) + c.total),
          yearOpening: money(yearOpening),
          residualPct: a.residual_pct,
          lifeYears: a.life_years,
          method: a.method,
          moves: await this.moves(tx, id),
        },
        from,
        upto,
      ))
        lines.push({ assetId: id, ...p, account: a.account_id });
    }
    if (!lines.length) return null;
    const total = lines.reduce((s, l) => s + dec(l.amount), 0n);
    const dep = await this.ledger.roleAccount(tx, entityId, 'depreciation');
    const line = (
      accountId: string,
      debit: string,
      credit: string,
      projectId: string | null,
      note: string,
    ): LineInput => ({
      accountId,
      partyId: null,
      debit,
      credit,
      projectId,
      siteId: null,
      costCodeId: null,
      note,
    });
    // Depreciation by project; each asset ledger credited its total.
    const byProject = new Map<string, Dec>();
    const byLedger = new Map<string, Dec>();
    for (const l of lines) {
      byProject.set(l.projectId ?? '', (byProject.get(l.projectId ?? '') ?? 0n) + dec(l.amount));
      byLedger.set(l.account, (byLedger.get(l.account) ?? 0n) + dec(l.amount));
    }
    const [run] = await tx<{ id: string }[]>`
      INSERT INTO acc.depreciation_run (entity_id, upto, total, created_by)
      VALUES (${entityId}, ${upto}, ${money(total)}, ${claims.sub}) RETURNING id`;
    const v = await this.ledger.post(
      tx,
      claims,
      {
        entityId,
        type: 'journal',
        date: upto,
        narration: `Depreciation to ${upto}`,
        reference: `Depreciation ${upto}`,
        lines: [
          ...[...byProject.entries()].map(([p, v]) =>
            line(dep, money(v), '0', p || null, 'Depreciation'),
          ),
          ...[...byLedger.entries()].map(([a, v]) => line(a, '0', money(v), null, 'Depreciation')),
        ],
      },
      { kind: 'depreciation_run', id: run!.id },
    );
    await tx`UPDATE acc.depreciation_run SET voucher_id = ${v!.id} WHERE id = ${run!.id}`;
    for (const l of lines)
      await tx`INSERT INTO acc.depreciation_line (run_id, asset_id, date_from, date_to, project_id, amount)
        VALUES (${run!.id}, ${l.assetId}, ${l.from}, ${l.to}, ${l.projectId}, ${l.amount})`;
    await audit(tx, claims.sub, 'depreciation.run', 'entity', entityId, {
      upto,
      total: money(total),
    });
    return { id: run!.id, total: money(total), voucher: v!.number };
  }

  async run(claims: TenantClaims, input: { entityId: string; upto: string }) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const r = await db
      .begin((tx) => this.runIn(tx, claims, input.entityId, input.upto, null))
      .catch(fromDb);
    if (!r)
      throw new BadRequestException({
        code: 'nothing_to_charge',
        message: 'Nothing is left to depreciate to that date.',
      });
    return r;
  }

  async runs(claims: TenantClaims, entityId: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    return db`
      SELECT r.id, to_char(r.upto, 'YYYY-MM-DD') AS upto, r.total::text AS total, v.number AS voucher,
        r.reversed_voucher_id IS NOT NULL AS reversed,
        (SELECT count(*)::int FROM acc.depreciation_line l WHERE l.run_id = r.id) AS lines
      FROM acc.depreciation_run r LEFT JOIN acc.voucher v ON v.id = r.voucher_id
      WHERE r.entity_id = ${entityId} ORDER BY r.created_at DESC`;
  }

  /** The latest run of the company reversed (later ones first, so the charge stays continuous). */
  async reverseRun(claims: TenantClaims, id: string, input: { date: string; reason: string }) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const [r] = await db<
      {
        entity_id: string;
        voucher_id: string;
        reversed: boolean;
        later: boolean;
        disposed: boolean;
      }[]
    >`
      SELECT r.entity_id, r.voucher_id, r.reversed_voucher_id IS NOT NULL AS reversed,
        EXISTS (SELECT 1 FROM acc.depreciation_run x WHERE x.entity_id = r.entity_id AND x.created_at > r.created_at
          AND x.reversed_voucher_id IS NULL) AS later,
        EXISTS (SELECT 1 FROM acc.depreciation_line l JOIN acc.asset a ON a.id = l.asset_id
          WHERE l.run_id = r.id AND a.status = 'disposed') AS disposed
      FROM acc.depreciation_run r WHERE r.id = ${id}`;
    if (!r) throw new NotFoundException({ code: 'run_not_found' });
    if (r.reversed)
      throw new ConflictException({ code: 'already_reversed', message: 'Already reversed.' });
    if (r.later)
      throw new ConflictException({ code: 'later_runs', message: 'Reverse the later runs first.' });
    if (r.disposed)
      throw new ConflictException({
        code: 'asset_disposed',
        message: 'An asset in this run has since been disposed.',
      });
    await db
      .begin(async (tx) => {
        const [v] = await tx<{ number: string; date: string }[]>`
          SELECT number, to_char(voucher_date, 'YYYY-MM-DD') AS date FROM acc.voucher WHERE id = ${r.voucher_id}`;
        if (input.date < v!.date)
          throw new BadRequestException({
            code: 'before_run',
            message: 'Reverse on or after the run.',
          });
        const back = await tx<LineInput[]>`
          SELECT account_id AS "accountId", NULL AS "partyId", credit::text AS debit, debit::text AS credit,
            project_id AS "projectId", site_id AS "siteId", cost_code_id AS "costCodeId", note
          FROM acc.voucher_line WHERE voucher_id = ${r.voucher_id} ORDER BY position`;
        const rev = await this.ledger.post(
          tx,
          claims,
          {
            entityId: r.entity_id,
            type: 'journal',
            date: input.date,
            narration: `Reversed: ${v!.number}: ${input.reason}`,
            reference: v!.number,
            lines: back,
          },
          { kind: 'depreciation_run', id },
          r.voucher_id,
        );
        await tx`UPDATE acc.depreciation_run SET reversed_voucher_id = ${rev!.id} WHERE id = ${id}`;
        await audit(tx, claims.sub, 'depreciation.reverse', 'entity', r.entity_id, {
          reason: input.reason,
        });
      })
      .catch(fromDb);
    return this.runs(claims, r.entity_id);
  }

  // --- disposal ---

  /** Charged to the day before, then sold: the bank or buyer Dr, the ledger Cr the book value, the gain or loss. */
  async dispose(
    claims: TenantClaims,
    id: string,
    input: {
      date: string;
      proceeds: string;
      bankAccountId: string | null;
      partyId: string | null;
      narration: string;
    },
  ) {
    await this.may(claims, 'accounts.post');
    if (dec(input.proceeds) > 0n && !input.bankAccountId === !input.partyId)
      throw new BadRequestException({
        code: 'where_paid',
        message: 'Say the bank it came into, or the buyer.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db
      .begin(async (tx) => {
        const a = await this.row(tx, id, true);
        if (a.status !== 'active')
          throw new ConflictException({ code: 'disposed', message: 'Already disposed.' });
        if (input.date < a.put_to_use_on)
          throw new BadRequestException({
            code: 'before_use',
            message: 'Not before it was put to use.',
          });
        const c0 = await this.charged(tx, id);
        if (c0.upto && c0.upto >= input.date)
          throw new BadRequestException({
            code: 'charged_beyond',
            message: `Depreciation runs to ${c0.upto}; dispose after that, or reverse the run.`,
          });
        if (input.date > a.put_to_use_on)
          await this.runIn(tx, claims, a.entity_id, addDays(input.date, -1), [id]);
        const c = await this.charged(tx, id);
        const book = dec(a.cost) - dec(a.opening_depreciation) - c.total;
        const proceeds = dec(input.proceeds);
        const result = proceeds - book;
        const [project] = (await this.moves(tx, id)).slice(-1);
        const line = (
          accountId: string,
          debit: string,
          credit: string,
          projectId: string | null = null,
        ): LineInput => ({
          accountId,
          partyId: null,
          debit,
          credit,
          projectId,
          siteId: null,
          costCodeId: null,
          note: `${a.number} ${a.name} disposed`,
        });
        const sale = await this.ledger.roleAccount(tx, a.entity_id, 'asset_sale_result');
        const lines: LineInput[] = [];
        if (proceeds > 0n)
          lines.push(
            line(
              input.bankAccountId ?? (await this.ledger.partyLedger(tx, input.partyId!)),
              money(proceeds),
              '0',
            ),
          );
        if (book > 0n) lines.push(line(a.account_id, '0', money(book)));
        if (result > 0n) lines.push(line(sale, '0', money(result)));
        if (result < 0n) lines.push(line(sale, money(-result), '0', project?.projectId ?? null));
        let voucherId: string | null = null;
        if (lines.length >= 2) {
          const v = await this.ledger.post(
            tx,
            claims,
            {
              entityId: a.entity_id,
              type: proceeds > 0n && input.bankAccountId ? 'receipt' : 'journal',
              date: input.date,
              narration: input.narration || `${a.number} ${a.name} disposed`,
              reference: a.number,
              lines,
            },
            { kind: 'asset_disposal', id },
          );
          voucherId = v!.id;
        }
        await tx`UPDATE acc.asset SET status = 'disposed', disposed_on = ${input.date}, proceeds = ${money(proceeds)},
            disposal_voucher_id = ${voucherId}, row_version = row_version + 1
          WHERE id = ${id}`;
        await audit(tx, claims.sub, 'asset.dispose', 'asset', id, {
          proceeds: money(proceeds),
          result: money(result),
        });
      })
      .catch(fromDb);
    return this.asset(claims, id);
  }

  // --- Income Tax ---

  /**
   * The Income Tax blocks for a financial year, worked from the books' first year: each block's opening value,
   * additions (full or half rate by the days used), sales, depreciation and closing value.
   */
  async taxDepreciation(claims: TenantClaims, q: { entityId: string; fy: string }) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const m = /^(\d{4})-\d{2}$/.exec(q.fy);
    if (!m)
      throw new BadRequestException({ code: 'bad_year', message: 'A financial year: 2026-27.' });
    const target = Number(m[1]);
    const assets = await db<
      {
        block: string;
        rate: string;
        source: string;
        put_to_use_on: string;
        cost: string;
        opening_wdv: string;
        disposed_on: string | null;
        proceeds: string | null;
      }[]
    >`
      SELECT c.name || ' ' || c.it_rate::text || '%' AS block, c.it_rate::text AS rate, a.source,
        to_char(a.put_to_use_on, 'YYYY-MM-DD') AS put_to_use_on, a.cost::text AS cost,
        coalesce(a.it_opening_wdv, a.cost - a.opening_depreciation)::text AS opening_wdv,
        to_char(a.disposed_on, 'YYYY-MM-DD') AS disposed_on, a.proceeds::text AS proceeds
      FROM acc.asset a JOIN acc.asset_class c ON c.id = a.class_id WHERE a.entity_id = ${q.entityId}`;
    const [e] = await db<{ books_from: string | null }[]>`
      SELECT to_char(books_from, 'YYYY-MM-DD') AS books_from FROM platform.entity WHERE id = ${q.entityId}`;
    const first = Number(fyOf(e?.books_from ?? `${target}-04-01`).from.slice(0, 4));
    const blocks = [...new Set(assets.map((a) => a.block))].sort();
    return {
      ...q,
      blocks: blocks.map((block) => {
        const mine = assets.filter((a) => a.block === block);
        const rate = mine[0]!.rate;
        // Opening assets enter the first year's opening value.
        let opening = mine
          .filter((a) => a.source === 'opening')
          .reduce((s, a) => s + dec(a.opening_wdv), 0n);
        let year = taxBlock({ rate, opening: '0', additions: [], sales: '0' });
        for (let y = first; y <= target; y++) {
          const [from, to] = [`${y}-04-01`, `${y + 1}-03-31`];
          year = taxBlock({
            rate,
            opening: money(opening),
            additions: mine
              .filter(
                (a) => a.source === 'bill' && a.put_to_use_on >= from && a.put_to_use_on <= to,
              )
              .map((a) => ({ cost: a.cost, daysUsed: daysBetween(a.put_to_use_on, to) })),
            sales: money(
              mine
                .filter((a) => a.disposed_on && a.disposed_on >= from && a.disposed_on <= to)
                .reduce((s, a) => s + dec(a.proceeds ?? '0'), 0n),
            ),
          });
          opening = dec(year.closing);
        }
        return { block, rate, ...year };
      }),
    };
  }
}
