// Material at site and accruals (docs/wave8-plan.md step 8a.2). At a month's end, per project:
// - goods received and accepted but not yet on a posted supplier bill, at the order's rate: material cost incurred
//   that the books do not yet have (debit material consumption, credit goods received not invoiced);
// - subcontract work measured but not yet in a certified bill, at the work order's rate (debit subcontract cost,
//   credit subcontract work accrued);
// - the stock lying in the project's stores, at its stock-ledger value: bought and expensed, but not yet used (debit
//   stock, credit changes in inventories). Skipped on a day the year-end closing stock is already posted.
// One journal on the month's last day, reversed on the next month's first, so each month stands on its own.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { fromDb } from '../accounts/accounts-rules.js';
import { LedgerService } from '../accounts/ledger.service.js';
import { cents, fromCents } from '../project/money.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

type Db = Sql | TransactionSql;
export const ACCRUAL_SOURCE = 'month_end_accrual';

const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const nextFirst = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};

export interface AccrualRow {
  project: { id: string; number: string; name: string };
  goodsNotInvoiced: string;
  workNotBilled: string;
  siteStock: string;
  orders: { number: string; kind: 'purchase' | 'work'; amount: string }[];
  posted: { voucher: string | null; reversal: string | null } | null;
}

@Injectable()
export class MonthEndAccrualsService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: p,
        message:
          p === 'accounts.view'
            ? 'Month-end accruals need the accounts permission.'
            : 'Posting them needs the permission to post.',
      });
  }

  async compute(db: Db, entityId: string, asOf: string) {
    // Received and accepted against each purchase order line, less what posted bills invoiced, at the order rate.
    const goods = await db<{ projectId: string; number: string; amount: string }[]>`
      WITH lines AS (
        SELECT o.id AS po_id, o.project_id, o.number, l.line_key, l.rate
        FROM proc.purchase_order o
        JOIN proc.po_revision r ON r.po_id = o.id AND r.status = 'approved'
        JOIN proc.po_line l ON l.revision_id = r.id
        JOIN proj.project p ON p.id = o.project_id
        WHERE o.kind = 'purchase' AND p.entity_id = ${entityId}),
      got AS (
        SELECT g.line_key, sum(g.accepted_qty) AS qty FROM proc.grn_line g
        JOIN proc.goods_receipt h ON h.id = g.receipt_id
        WHERE h.status = 'posted' AND h.received_on <= ${asOf} GROUP BY g.line_key),
      billed AS (
        SELECT bl.line_key, sum(bl.qty) AS qty FROM acc.vendor_bill_line bl
        JOIN acc.vendor_bill b ON b.id = bl.bill_id
        WHERE b.status = 'posted' AND b.bill_date <= ${asOf} AND bl.line_key IS NOT NULL GROUP BY bl.line_key)
      SELECT l.project_id AS "projectId", l.number,
        sum(round(greatest(coalesce(got.qty, 0) - coalesce(billed.qty, 0), 0) * l.rate, 2))::text AS amount
      FROM lines l LEFT JOIN got ON got.line_key = l.line_key LEFT JOIN billed ON billed.line_key = l.line_key
      GROUP BY l.project_id, l.number
      HAVING sum(round(greatest(coalesce(got.qty, 0) - coalesce(billed.qty, 0), 0) * l.rate, 2)) > 0`;
    // Measured on each work order line, less the quantity in its last certified bill by then, at the order rate.
    const work = await db<{ projectId: string; number: string; amount: string }[]>`
      WITH lines AS (
        SELECT o.id AS po_id, o.project_id, o.number, l.line_key, l.rate
        FROM proc.purchase_order o
        JOIN proc.po_revision r ON r.po_id = o.id AND r.status = 'approved'
        JOIN proc.po_line l ON l.revision_id = r.id
        JOIN proj.project p ON p.id = o.project_id
        WHERE o.kind = 'work' AND p.entity_id = ${entityId}),
      measured AS (
        SELECT m.order_id, m.line_key, sum(m.qty) AS qty FROM acc.wo_measurement m
        WHERE m.measured_on <= ${asOf} GROUP BY m.order_id, m.line_key),
      billed AS (
        SELECT DISTINCT ON (b.order_id, bl.line_key) b.order_id, bl.line_key, bl.cum_qty AS qty
        FROM acc.subcontract_bill b JOIN acc.subcontract_bill_line bl ON bl.bill_id = b.id
        JOIN acc.vendor_bill v ON v.id = b.vendor_bill_id
        WHERE b.status = 'certified' AND v.bill_date <= ${asOf}
        ORDER BY b.order_id, bl.line_key, b.upto DESC, b.ra_no DESC)
      SELECT l.project_id AS "projectId", l.number,
        sum(round(greatest(coalesce(m.qty, 0) - coalesce(b.qty, 0), 0) * l.rate, 2))::text AS amount
      FROM lines l
      LEFT JOIN measured m ON m.order_id = l.po_id AND m.line_key = l.line_key
      LEFT JOIN billed b ON b.order_id = l.po_id AND b.line_key = l.line_key
      GROUP BY l.project_id, l.number
      HAVING sum(round(greatest(coalesce(m.qty, 0) - coalesce(b.qty, 0), 0) * l.rate, 2)) > 0`;
    const [closing] = await db`
      SELECT 1 FROM acc.voucher WHERE entity_id = ${entityId} AND source_kind = 'closing_stock'
        AND voucher_date = ${asOf} AND reverses_id IS NULL`;
    const stock = closing
      ? []
      : await db<{ projectId: string; amount: string }[]>`
          SELECT s.project_id AS "projectId", sum(m.value)::text AS amount
          FROM proc.stock_move m JOIN proc.store s ON s.id = m.store_id
          JOIN proj.project p ON p.id = s.project_id
          WHERE p.entity_id = ${entityId} AND m.moved_on <= ${asOf}
          GROUP BY s.project_id HAVING sum(m.value) > 0`;
    const projects = await db<{ id: string; number: string; name: string }[]>`
      SELECT id, number, name FROM proj.project WHERE entity_id = ${entityId} ORDER BY number`;
    const rows: AccrualRow[] = [];
    for (const p of projects) {
      const g = goods.filter((x) => x.projectId === p.id);
      const w = work.filter((x) => x.projectId === p.id);
      const s = stock.find((x) => x.projectId === p.id);
      const sum = (xs: { amount: string }[]) => xs.reduce((t, x) => t + cents(x.amount), 0n);
      if (!g.length && !w.length && !s) continue;
      rows.push({
        project: p,
        goodsNotInvoiced: fromCents(sum(g)),
        workNotBilled: fromCents(sum(w)),
        siteStock: fromCents(s ? cents(s.amount) : 0n),
        orders: [
          ...g.map((x) => ({ number: x.number, kind: 'purchase' as const, amount: x.amount })),
          ...w.map((x) => ({ number: x.number, kind: 'work' as const, amount: x.amount })),
        ],
        posted: null,
      });
    }
    return { rows, closingStockPosted: !!closing };
  }

  async month(claims: TenantClaims, entityId: string, month: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const { rows, closingStockPosted } = await this.compute(db, entityId, lastDay(month));
    const posted = await db<
      { projectId: string; voucher: string | null; reversal: string | null }[]
    >`
      SELECT a.project_id AS "projectId", v.number AS voucher, x.number AS reversal
      FROM acc.month_end_accrual a LEFT JOIN acc.voucher v ON v.id = a.voucher_id
      LEFT JOIN acc.voucher x ON x.id = a.reversal_id
      WHERE a.entity_id = ${entityId} AND a.month = ${`${month}-01`}`;
    const byProject = new Map(posted.map((p) => [p.projectId, p]));
    const sum = (k: 'goodsNotInvoiced' | 'workNotBilled' | 'siteStock') =>
      fromCents(rows.reduce((t, r) => t + cents(r[k]), 0n));
    return {
      month,
      asOf: lastDay(month),
      rows: rows.map((r) => ({ ...r, posted: byProject.get(r.project.id) ?? null })),
      totals: {
        goodsNotInvoiced: sum('goodsNotInvoiced'),
        workNotBilled: sum('workNotBilled'),
        siteStock: sum('siteStock'),
      },
      closingStockPosted,
      posted: posted.length > 0,
      mayPost: await this.permissions.can(claims, 'accounts.post'),
    };
  }

  async post(claims: TenantClaims, entityId: string, month: string) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const asOf = lastDay(month);
    const { rows } = await this.compute(db, entityId, asOf);
    if (!rows.length)
      throw new BadRequestException({
        code: 'nothing_to_post',
        message: 'Nothing received unbilled, measured unbilled or in stock at the month end.',
      });
    await db
      .begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`accrual ${entityId} ${month}`}))`;
        const [done] = await tx`
          SELECT 1 FROM acc.month_end_accrual WHERE entity_id = ${entityId} AND month = ${`${month}-01`}`;
        if (done)
          throw new ConflictException({
            code: 'already_posted',
            message: 'This month is already posted.',
          });
        const role = (r: Parameters<LedgerService['roleAccount']>[2]) =>
          this.ledger.roleAccount(tx, entityId, r);
        const [material, grni, subcontract, accrued, stock, change] = await Promise.all([
          role('material_consumption'),
          role('grn_clearing'),
          role('subcontract_cost'),
          role('subcontract_accrued'),
          role('stock'),
          role('inventory_change'),
        ]);
        const line = (
          accountId: string,
          dr: bigint,
          cr: bigint,
          projectId: string,
          note: string,
        ) => ({
          accountId,
          partyId: null,
          debit: fromCents(dr),
          credit: fromCents(cr),
          projectId,
          siteId: null,
          costCodeId: null,
          note,
        });
        const lines = rows.flatMap((r) => {
          const out = [];
          const [g, w, s] = [cents(r.goodsNotInvoiced), cents(r.workNotBilled), cents(r.siteStock)];
          const p = r.project;
          if (g > 0n)
            out.push(
              line(material, g, 0n, p.id, `${p.number}: received, not invoiced`),
              line(grni, 0n, g, p.id, `${p.number}: received, not invoiced`),
            );
          if (w > 0n)
            out.push(
              line(subcontract, w, 0n, p.id, `${p.number}: measured, not billed`),
              line(accrued, 0n, w, p.id, `${p.number}: measured, not billed`),
            );
          if (s > 0n)
            out.push(
              line(stock, s, 0n, p.id, `${p.number}: stock at site`),
              line(change, 0n, s, p.id, `${p.number}: stock at site`),
            );
          return out;
        });
        const v = await this.ledger.post(
          tx,
          claims,
          {
            entityId,
            type: 'journal',
            date: asOf,
            narration: `Month-end accruals and stock at site, ${month}`,
            reference: `ACCR/${month}`,
            lines,
          },
          { kind: ACCRUAL_SOURCE, id: entityId },
        );
        const back = await this.ledger.post(
          tx,
          claims,
          {
            entityId,
            type: 'journal',
            date: nextFirst(month),
            narration: `Reversal of month-end accruals, ${month}`,
            reference: v!.number,
            lines: lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
          },
          null,
          v!.id,
        );
        for (const r of rows)
          await tx`
            INSERT INTO acc.month_end_accrual (entity_id, project_id, month, goods_not_invoiced, work_not_billed,
              site_stock, voucher_id, reversal_id, created_by)
            VALUES (${entityId}, ${r.project.id}, ${`${month}-01`}, ${r.goodsNotInvoiced}, ${r.workNotBilled},
              ${r.siteStock}, ${v!.id}, ${back!.id}, ${claims.sub})`;
      })
      .catch(fromDb);
    return this.month(claims, entityId, month);
  }
}
