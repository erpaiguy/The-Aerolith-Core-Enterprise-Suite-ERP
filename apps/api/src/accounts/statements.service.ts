// Financial statements (docs/wave3-plan.md step 8a): profit and loss and balance sheet in Schedule III's lines, with
// the previous year beside them; cash flow by the indirect method; each project's P&L; the year end (closing stock,
// income and expense closed into the profit and loss account, the year's months locked).
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
import { dec, fmt, type Dec } from '../rates/decimal.js';
import { audit } from '../tender/tender-records.js';
import { fromDb, fyOf } from './accounts-rules.js';
import { LedgerService, type LineInput } from './ledger.service.js';

type Db = Sql | TransactionSql;
const money = (v: Dec) => fmt(v, 2);
export const YEAR_END = 'year_end';

/** Schedule III's lines, in its order, and the chart's top groups that fall in each. */
export const SCHEDULE_III = {
  balanceSheet: [
    { head: 'Equity', key: 'share_capital', label: 'Share capital', groups: ['capital'] },
    { head: 'Equity', key: 'other_equity', label: 'Other equity', groups: ['reserves'] },
    {
      head: 'Non-current liabilities',
      key: 'long_term_borrowings',
      label: 'Long-term borrowings',
      groups: ['long_term_borrowings'],
    },
    {
      head: 'Current liabilities',
      key: 'short_term_borrowings',
      label: 'Short-term borrowings',
      groups: ['short_term_borrowings'],
    },
    {
      head: 'Current liabilities',
      key: 'trade_payables',
      label: 'Trade payables',
      groups: ['sundry_creditors'],
    },
    {
      head: 'Current liabilities',
      key: 'other_current_liabilities',
      label: 'Other current liabilities',
      groups: ['other_current_liabilities', 'duties_and_taxes'],
    },
    {
      head: 'Current liabilities',
      key: 'short_term_provisions',
      label: 'Short-term provisions',
      groups: ['provisions'],
    },
    {
      head: 'Non-current assets',
      key: 'ppe',
      label: 'Property, plant and equipment',
      groups: ['fixed_assets'],
    },
    { head: 'Current assets', key: 'inventories', label: 'Inventories', groups: ['inventories'] },
    {
      head: 'Current assets',
      key: 'trade_receivables',
      label: 'Trade receivables',
      groups: ['sundry_debtors'],
    },
    {
      head: 'Current assets',
      key: 'cash',
      label: 'Cash and cash equivalents',
      groups: ['cash_and_bank'],
    },
    {
      head: 'Current assets',
      key: 'loans_and_advances',
      label: 'Short-term loans and advances',
      groups: ['loans_and_advances'],
    },
    {
      head: 'Current assets',
      key: 'other_current_assets',
      label: 'Other current assets',
      groups: [],
    },
  ],
  profitAndLoss: [
    { head: 'Income', key: 'revenue', label: 'Revenue from operations', groups: ['revenue'] },
    { head: 'Income', key: 'other_income', label: 'Other income', groups: ['other_income'] },
    {
      head: 'Expenses',
      key: 'materials',
      label: 'Cost of materials consumed',
      groups: ['materials_consumed'],
    },
    {
      head: 'Expenses',
      key: 'subcontract',
      label: 'Subcontract and labour',
      groups: ['subcontract_and_labour'],
    },
    {
      head: 'Expenses',
      key: 'employee',
      label: 'Employee benefits expense',
      groups: ['employee_benefits'],
    },
    { head: 'Expenses', key: 'finance', label: 'Finance costs', groups: ['finance_costs'] },
    {
      head: 'Expenses',
      key: 'depreciation',
      label: 'Depreciation and amortisation',
      groups: ['depreciation_group'],
    },
    {
      head: 'Expenses',
      key: 'other_expenses',
      label: 'Other expenses',
      groups: ['site_expenses', 'other_expenses'],
    },
  ],
} as const;
/** A top group the admin added falls under its nature's catch-all line. */
const BY_NATURE: Record<string, string> = {
  equity: 'other_equity',
  liability: 'other_current_liabilities',
  asset: 'other_current_assets',
  income: 'other_income',
  expense: 'other_expenses',
};
const WORKING_CAPITAL = [
  'inventories',
  'sundry_debtors',
  'loans_and_advances',
  'sundry_creditors',
  'other_current_liabilities',
  'duties_and_taxes',
  'provisions',
];
const FINANCING = ['capital', 'reserves', 'long_term_borrowings', 'short_term_borrowings'];

const yearBefore = (d: string) => {
  const y = Number(d.slice(0, 4)) - 1;
  const md = d.slice(5) === '02-29' ? '02-28' : d.slice(5);
  return `${y}-${md}`;
};
const dayAfter = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
};

interface Acct {
  id: string;
  parent_id: string | null;
  system_key: string | null;
  nature: string;
  code: string;
  name: string;
}

@Injectable()
export class StatementService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
  ) {}

  private async may(claims: TenantClaims) {
    if (!(await this.permissions.can(claims, 'accounts.view')))
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Statements need the accounts permission.',
      });
  }

  /** Each account's top group (the child of a root) by its system key, or its code where the admin added it. */
  private async tops(db: Db) {
    const all = await db<
      Acct[]
    >`SELECT id, parent_id, system_key, nature, code, name FROM acc.account`;
    const byId = new Map(all.map((a) => [a.id, a]));
    const top = new Map<string, Acct>();
    for (const a of all) {
      let x = a;
      while (x.parent_id && byId.get(x.parent_id)?.parent_id) x = byId.get(x.parent_id)!;
      if (x.parent_id) top.set(a.id, x);
    }
    const lineOf = (accountId: string) => {
      const t = top.get(accountId);
      if (!t) return null;
      for (const l of [...SCHEDULE_III.balanceSheet, ...SCHEDULE_III.profitAndLoss])
        if ((l.groups as readonly string[]).includes(t.system_key ?? '')) return l.key;
      return BY_NATURE[t.nature]!;
    };
    return { top, lineOf, byId };
  }

  /** Net debits per account between two dates (or from the start), optionally leaving the year-end close out. */
  private movement(db: Db, entityId: string, from: string | null, to: string, withClose: boolean) {
    return db<{ account_id: string; net: string }[]>`
      SELECT l.account_id, sum(l.debit - l.credit)::text AS net FROM acc.voucher_line l
      JOIN acc.voucher v ON v.id = l.voucher_id
      WHERE v.entity_id = ${entityId} AND v.voucher_date <= ${to} ${from ? db`AND v.voucher_date >= ${from}` : db``}
        ${withClose ? db`` : db`AND v.source_kind IS DISTINCT FROM ${YEAR_END}`}
      GROUP BY l.account_id`;
  }

  private async plFigures(db: Db, entityId: string, from: string, to: string) {
    const { lineOf } = await this.tops(db);
    const sums = new Map<string, Dec>();
    for (const m of await this.movement(db, entityId, from, to, false)) {
      const k = lineOf(m.account_id);
      if (k && SCHEDULE_III.profitAndLoss.some((l) => l.key === k))
        sums.set(k, (sums.get(k) ?? 0n) + dec(m.net));
    }
    const lines = SCHEDULE_III.profitAndLoss.map((l) => ({
      key: l.key,
      head: l.head,
      label: l.label,
      // Income credit-positive, expenses debit-positive.
      amount: l.head === 'Income' ? -(sums.get(l.key) ?? 0n) : (sums.get(l.key) ?? 0n),
    }));
    const income = lines.filter((l) => l.head === 'Income').reduce((s, l) => s + l.amount, 0n);
    const expenses = lines.filter((l) => l.head === 'Expenses').reduce((s, l) => s + l.amount, 0n);
    return { lines, income, expenses, profit: income - expenses };
  }

  async profitAndLoss(claims: TenantClaims, q: { entityId: string; from: string; to: string }) {
    await this.may(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const now = await this.plFigures(db, q.entityId, q.from, q.to);
    const before = await this.plFigures(db, q.entityId, yearBefore(q.from), yearBefore(q.to));
    return {
      ...q,
      lines: now.lines.map((l, i) => ({
        key: l.key,
        head: l.head,
        label: l.label,
        amount: money(l.amount),
        previous: money(before.lines[i]!.amount),
      })),
      income: money(now.income),
      expenses: money(now.expenses),
      profit: money(now.profit),
      previous: {
        income: money(before.income),
        expenses: money(before.expenses),
        profit: money(before.profit),
      },
    };
  }

  private async bsFigures(db: Db, entityId: string, asOf: string) {
    const { lineOf } = await this.tops(db);
    const sums = new Map<string, Dec>();
    let unclosed = 0n;
    for (const m of await this.movement(db, entityId, null, asOf, true)) {
      const k = lineOf(m.account_id);
      if (!k) continue;
      if (SCHEDULE_III.profitAndLoss.some((l) => l.key === k)) unclosed -= dec(m.net);
      else sums.set(k, (sums.get(k) ?? 0n) + dec(m.net));
    }
    const lines = SCHEDULE_III.balanceSheet.map((l) => {
      const debit = sums.get(l.key) ?? 0n;
      const isAsset = l.head.endsWith('assets');
      // Assets debit-positive; equity and liabilities credit-positive; the profit not yet closed in other equity.
      const amount = isAsset ? debit : -debit + (l.key === 'other_equity' ? unclosed : 0n);
      return { key: l.key, head: l.head, label: l.label, amount };
    });
    const assets = lines
      .filter((l) => l.head.endsWith('assets'))
      .reduce((s, l) => s + l.amount, 0n);
    const liabilities = lines
      .filter((l) => !l.head.endsWith('assets'))
      .reduce((s, l) => s + l.amount, 0n);
    return { lines, assets, liabilities, unclosed };
  }

  async balanceSheet(claims: TenantClaims, q: { entityId: string; asOf: string }) {
    await this.may(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const now = await this.bsFigures(db, q.entityId, q.asOf);
    const before = await this.bsFigures(db, q.entityId, yearBefore(q.asOf));
    return {
      ...q,
      lines: now.lines.map((l, i) => ({
        key: l.key,
        head: l.head,
        label: l.label,
        amount: money(l.amount),
        previous: money(before.lines[i]!.amount),
      })),
      profitNotClosed: money(now.unclosed),
      equityAndLiabilities: money(now.liabilities),
      assets: money(now.assets),
      balanced: now.assets === now.liabilities,
      previous: { equityAndLiabilities: money(before.liabilities), assets: money(before.assets) },
    };
  }

  /** The indirect method: profit, depreciation back, working capital, investing, financing; equal to cash's change. */
  async cashFlow(claims: TenantClaims, q: { entityId: string; from: string; to: string }) {
    await this.may(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const { top } = await this.tops(db);
    const by = new Map<string, Dec>();
    for (const m of await this.movement(db, q.entityId, q.from, q.to, false)) {
      const t = top.get(m.account_id);
      const k = t ? (t.system_key ?? `other.${t.nature}`) : 'none';
      by.set(k, (by.get(k) ?? 0n) + dec(m.net));
    }
    const pl = await this.plFigures(db, q.entityId, q.from, q.to);
    const mv = (k: string) => by.get(k) ?? 0n;
    const depreciation = mv('depreciation_group');
    const workingCapital = WORKING_CAPITAL.map((k) => ({ group: k, change: -mv(k) }));
    const plGroups = new Set<string>(SCHEDULE_III.profitAndLoss.flatMap((l) => [...l.groups]));
    // Anything else (a top group the admin added) is taken with operating activities.
    const known = new Set([
      ...WORKING_CAPITAL,
      ...FINANCING,
      'fixed_assets',
      'cash_and_bank',
      ...plGroups,
    ]);
    const others = [...by.entries()].filter(
      ([k]) => !known.has(k) && !k.startsWith('other.income') && !k.startsWith('other.expense'),
    );
    const otherChange = others.reduce((s, [, v]) => s - v, 0n);
    const operating =
      pl.profit + depreciation + workingCapital.reduce((s, w) => s + w.change, 0n) + otherChange;
    const investing = -(mv('fixed_assets') + depreciation);
    const financing = FINANCING.reduce((s, k) => s - mv(k), 0n);
    const net = operating + investing + financing;
    const [open] = await db<{ v: string }[]>`
      SELECT coalesce(sum(l.debit - l.credit), 0)::text AS v FROM acc.voucher_line l
      JOIN acc.voucher v ON v.id = l.voucher_id
      WHERE v.entity_id = ${q.entityId} AND v.voucher_date < ${q.from}
        AND l.account_id IN (SELECT a.id FROM acc.account a WHERE a.kind IN ('bank', 'cash'))`;
    return {
      ...q,
      profit: money(pl.profit),
      depreciation: money(depreciation),
      workingCapital: workingCapital.map((w) => ({ group: w.group, change: money(w.change) })),
      otherOperating: money(otherChange),
      operating: money(operating),
      investing: money(investing),
      financing: money(financing),
      netChange: money(net),
      cashChange: money(mv('cash_and_bank')),
      openingCash: money(dec(open!.v)),
      closingCash: money(dec(open!.v) + mv('cash_and_bank')),
      agrees: net === mv('cash_and_bank'),
    };
  }

  /** Every project of the company: revenue, costs by line and by cost code, margin; invoiced, received, outstanding. */
  async projects(claims: TenantClaims, q: { entityId: string; from: string; to: string }) {
    await this.may(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const { lineOf } = await this.tops(db);
    const rows = await db<
      { project_id: string; account_id: string; cost_code: string | null; net: string }[]
    >`
      SELECT l.project_id, l.account_id, cc.code || ' ' || cc.name AS cost_code, sum(l.debit - l.credit)::text AS net
      FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id
      LEFT JOIN platform.cost_code cc ON cc.id = l.cost_code_id
      WHERE v.entity_id = ${q.entityId} AND v.voucher_date BETWEEN ${q.from} AND ${q.to}
        AND v.source_kind IS DISTINCT FROM ${YEAR_END} AND l.project_id IS NOT NULL
      GROUP BY l.project_id, l.account_id, cc.code, cc.name`;
    const projects = await db<{ id: string; number: string; name: string }[]>`
      SELECT id, number, name FROM proj.project WHERE entity_id = ${q.entityId} ORDER BY number`;
    const billing = await db<
      {
        project_id: string;
        invoiced: string;
        credited: string;
        received: string;
        outstanding: string;
      }[]
    >`
      SELECT p.id AS project_id,
        coalesce((SELECT sum((b.certified ->> 'invoiceTotal')::numeric) FROM acc.client_bill b WHERE b.project_id = p.id
          AND b.status = 'certified' AND b.invoice_date BETWEEN ${q.from} AND ${q.to}), 0)::text AS invoiced,
        coalesce((SELECT sum(n.total) FROM acc.credit_note n JOIN acc.client_bill b ON b.id = n.bill_id
          WHERE b.project_id = p.id AND n.note_date BETWEEN ${q.from} AND ${q.to}), 0)::text AS credited,
        coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id
          WHERE a.project_id = p.id AND r.status = 'posted' AND r.received_on BETWEEN ${q.from} AND ${q.to}), 0)::text
          AS received,
        coalesce((SELECT sum((b.certified ->> 'net')::numeric) FROM acc.client_bill b WHERE b.project_id = p.id
          AND b.status = 'certified' AND b.invoice_date <= ${q.to}), 0)
        - coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id
          WHERE a.project_id = p.id AND a.kind = 'bill' AND r.status = 'posted' AND r.received_on <= ${q.to}), 0)
        - coalesce((SELECT sum(n.total) FROM acc.credit_note n JOIN acc.client_bill b ON b.id = n.bill_id
          WHERE b.project_id = p.id AND n.note_date <= ${q.to}), 0) AS outstanding
      FROM proj.project p WHERE p.entity_id = ${q.entityId}`;
    const plKeys = new Map<string, { head: string; label: string }>(
      SCHEDULE_III.profitAndLoss.map((l) => [l.key, { head: l.head, label: l.label }]),
    );
    return {
      ...q,
      projects: projects
        .map((p) => {
          const mine = rows.filter((r) => r.project_id === p.id);
          const lines = new Map<string, Dec>();
          const codes = new Map<string, Dec>();
          let revenue = 0n;
          let costs = 0n;
          for (const r of mine) {
            const k = lineOf(r.account_id);
            const meta = k ? plKeys.get(k) : undefined;
            if (!meta) continue;
            if (meta.head === 'Income') revenue -= dec(r.net);
            else {
              costs += dec(r.net);
              lines.set(meta.label, (lines.get(meta.label) ?? 0n) + dec(r.net));
              const c = r.cost_code ?? 'No cost code';
              codes.set(c, (codes.get(c) ?? 0n) + dec(r.net));
            }
          }
          const b = billing.find((x) => x.project_id === p.id)!;
          return {
            project: p,
            revenue: money(revenue),
            costs: money(costs),
            margin: money(revenue - costs),
            marginPct: revenue
              ? ((Number(money(revenue - costs)) / Number(money(revenue))) * 100).toFixed(1)
              : null,
            byLine: [...lines.entries()].map(([label, v]) => ({ label, amount: money(v) })),
            byCostCode: [...codes.entries()]
              .sort(([a], [b2]) => a.localeCompare(b2))
              .map(([costCode, v]) => ({ costCode, amount: money(v) })),
            invoiced: b.invoiced,
            credited: b.credited,
            received: b.received,
            outstanding: money(dec(b.outstanding)),
            active: mine.length > 0 || dec(b.invoiced) !== 0n,
          };
        })
        .filter((p) => p.active)
        .map(({ active: _, ...p }) => p),
    };
  }

  // --- year end ---

  async yearEnd(claims: TenantClaims, entityId: string) {
    await this.may(claims);
    const db = await this.tenants.forTenant(claims.ten);
    const closed = await db<{ fy: string; date: string; number: string }[]>`
      SELECT to_char(voucher_date, 'YYYY-MM-DD') AS date, number, '' AS fy FROM acc.voucher
      WHERE entity_id = ${entityId} AND source_kind = ${YEAR_END} AND reverses_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM acc.voucher r WHERE r.reverses_id = acc.voucher.id)
      ORDER BY voucher_date`;
    return { closed: closed.map((c) => ({ ...c, fy: fyOf(c.date).label })) };
  }

  /**
   * Closes a financial year: the closing stock (if any) as stock Dr, changes in inventories Cr on the last day and
   * reversed on the next; each income and expense ledger's year (by project) closed into the profit and loss account;
   * then the twelve months locked. Once a year.
   */
  async closeYear(
    claims: TenantClaims,
    input: { entityId: string; fy: string; closingStock: string },
  ) {
    if (claims.role !== 'admin')
      throw new ForbiddenException({ code: 'forbidden', message: 'Only an admin closes a year.' });
    const m = /^(\d{4})-(\d{2})$/.exec(input.fy);
    if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2]))
      throw new BadRequestException({ code: 'bad_year', message: 'A financial year: 2026-27.' });
    const from = `${m[1]}-04-01`;
    const to = `${Number(m[1]) + 1}-03-31`;
    const db = await this.tenants.forTenant(claims.ten);
    const result = await db
      .begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${'year-end ' + input.entityId}))`;
        const [done] = await tx`
          SELECT 1 FROM acc.voucher v WHERE v.entity_id = ${input.entityId} AND v.source_kind = ${YEAR_END}
            AND v.voucher_date = ${to} AND v.reverses_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM acc.voucher r WHERE r.reverses_id = v.id)`;
        if (done)
          throw new ConflictException({
            code: 'year_closed',
            message: `${input.fy} is already closed.`,
          });
        const role = (r: Parameters<LedgerService['roleAccount']>[2]) =>
          this.ledger.roleAccount(tx, input.entityId, r);
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
        const stock = dec(input.closingStock);
        const vouchers: string[] = [];
        if (stock > 0n) {
          const [s, c] = [await role('stock'), await role('inventory_change')];
          const v1 = await this.ledger.post(
            tx,
            claims,
            {
              entityId: input.entityId,
              type: 'journal',
              date: to,
              narration: `Closing stock, ${input.fy}`,
              reference: `Closing stock ${input.fy}`,
              lines: [
                line(s, money(stock), '0', null, 'Closing stock'),
                line(c, '0', money(stock), null, 'Closing stock'),
              ],
            },
            { kind: 'closing_stock', id: input.entityId },
          );
          const v2 = await this.ledger.post(
            tx,
            claims,
            {
              entityId: input.entityId,
              type: 'journal',
              date: dayAfter(to),
              narration: `Opening stock, from ${input.fy}`,
              reference: `Closing stock ${input.fy}`,
              lines: [
                line(c, money(stock), '0', null, 'Opening stock'),
                line(s, '0', money(stock), null, 'Opening stock'),
              ],
            },
            { kind: 'closing_stock', id: input.entityId },
          );
          vouchers.push(v1!.number, v2!.number);
        }
        const { lineOf } = await this.tops(tx);
        const plKeys = new Set<string>(SCHEDULE_III.profitAndLoss.map((l) => l.key));
        const balances = await tx<{ account_id: string; project_id: string | null; net: string }[]>`
          SELECT l.account_id, l.project_id, sum(l.debit - l.credit)::text AS net FROM acc.voucher_line l
          JOIN acc.voucher v ON v.id = l.voucher_id
          WHERE v.entity_id = ${input.entityId} AND v.voucher_date BETWEEN ${from} AND ${to}
            AND v.source_kind IS DISTINCT FROM ${YEAR_END}
          GROUP BY l.account_id, l.project_id HAVING sum(l.debit - l.credit) <> 0
          ORDER BY l.account_id, l.project_id`;
        const closing = balances.filter((b) => plKeys.has(lineOf(b.account_id) ?? ''));
        let profit = 0n;
        const lines: LineInput[] = closing.map((b) => {
          const net = dec(b.net);
          profit -= net;
          return net > 0n
            ? line(b.account_id, '0', money(net), b.project_id, 'Closed for the year')
            : line(b.account_id, money(-net), '0', b.project_id, 'Closed for the year');
        });
        if (profit !== 0n) {
          const pl = await role('profit_and_loss');
          lines.push(
            profit > 0n
              ? line(pl, '0', money(profit), null, `Profit for ${input.fy}`)
              : line(pl, money(-profit), '0', null, `Loss for ${input.fy}`),
          );
        }
        if (lines.length < 2)
          throw new BadRequestException({
            code: 'nothing_to_close',
            message: `${input.fy} has no income or expenses.`,
          });
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId: input.entityId,
            type: 'journal',
            date: to,
            narration: `Income and expenses closed for ${input.fy}`,
            reference: `Year end ${input.fy}`,
            lines,
          },
          { kind: YEAR_END, id: input.entityId },
        );
        vouchers.push(v!.number);
        // The year's twelve months locked.
        for (let i = 0; i < 12; i++) {
          const d = new Date(Date.UTC(Number(m[1]), 3 + i, 1)).toISOString().slice(0, 10);
          const [made] = await tx`
            INSERT INTO acc.period_lock (entity_id, month, locked_by) VALUES (${input.entityId}, ${d}, ${claims.sub})
            ON CONFLICT DO NOTHING RETURNING 1`;
          if (made)
            await tx`INSERT INTO acc.period_event (entity_id, month, action, by_user)
              VALUES (${input.entityId}, ${d}, 'locked', ${claims.sub})`;
        }
        await audit(tx, claims.sub, 'year.close', 'entity', input.entityId, {
          fy: input.fy,
          profit: money(profit),
          closingStock: money(stock),
        });
        return { fy: input.fy, profit: money(profit), closingStock: money(stock), vouchers };
      })
      .catch(fromDb);
    return result;
  }
}
