// Revenue on work done (docs/wave8-plan.md step 8a.1, Ind AS 115). For a company and a month, per project: the
// share complete — cost to date over the estimated total cost (cost control's forecast), or, where a project has no
// cost estimate, the value measured at contract rates over the contract value — the revenue that share earns, and the
// difference from the revenue its bills have taken: unbilled revenue (a contract asset) or billing in excess (a
// contract liability). Where the estimate passes the contract value the rest of the loss is provided for at once.
// Accounts post the month as one journal on its last day, reversed on the next month's first.
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
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { cents, fromCents } from '../project/money.js';
import { CostControlService } from './cost-control.service.js';

type Db = Sql | TransactionSql;
export const SOURCE = 'revenue_recognition';

export interface WorkDone {
  project: { id: string; number: string; name: string };
  method: 'cost' | 'measured';
  contractValue: string;
  estimatedCost: string;
  costToDate: string;
  measuredValue: string;
  pctComplete: number;
  recognised: string;
  billed: string;
  adjustment: string;
  lossProvision: string;
  margin: string;
  posted: { voucher: string | null; reversal: string | null } | null;
}

const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const nextFirst = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};
/** a × num / den, rounded to the paisa (half away from zero). */
const share = (a: bigint, num: bigint, den: bigint) => {
  if (den === 0n) return 0n;
  const x = a * num * 2n;
  const d = den * 2n;
  const q = x / d;
  const r = x % d;
  return (r * 2n >= d ? q + 1n : r * 2n <= -d ? q - 1n : q) as bigint;
};

/** The arithmetic, apart from the books, so it can be tested on its own. Amounts in paise. */
export function workDone(f: {
  contract: bigint;
  estimate: bigint;
  cost: bigint;
  measured: bigint;
  billed: bigint;
}) {
  const estimate = f.estimate > f.cost ? f.estimate : f.cost;
  const byCost = estimate > 0n && f.contract > 0n;
  const [num, den] = byCost ? [f.cost, estimate] : [f.measured, f.contract];
  const capped = den > 0n && num > den ? den : num;
  const recognised = den > 0n ? share(f.contract, capped, den) : 0n;
  const loss = byCost && estimate > f.contract ? estimate - f.contract : 0n;
  // The part of the loss not yet in cost less revenue: (1 − share complete) × total loss.
  const lossProvision = loss > 0n && den > 0n ? share(loss, den - capped, den) : 0n;
  return {
    method: (byCost ? 'cost' : 'measured') as 'cost' | 'measured',
    estimate,
    pct: den > 0n ? Number((capped * 1_000_000n) / den) / 1_000_000 : 0,
    recognised,
    adjustment: recognised - f.billed,
    lossProvision,
    margin: recognised - f.cost - lossProvision,
  };
}

@Injectable()
export class RevenueRecognitionService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly ledger: LedgerService,
    private readonly costs: CostControlService,
  ) {}

  private async may(claims: TenantClaims, p: 'accounts.view' | 'accounts.post') {
    if (!(await this.permissions.can(claims, p)))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: p,
        message:
          p === 'accounts.view'
            ? 'Revenue on work done needs the accounts permission.'
            : 'Posting it needs the permission to post.',
      });
  }

  /** Each live project's work done as at a day (the month's last day, or today for the dashboard). */
  async compute(db: Db, entityId: string, asOf: string): Promise<WorkDone[]> {
    const projects = await db<
      { id: string; number: string; name: string; contract: string; variations: string }[]
    >`
      SELECT p.id, p.number, p.name, coalesce(p.contract_value, 0)::text AS contract,
        coalesce((SELECT sum(v.approved_value) FROM ctl.variation v
          WHERE v.project_id = p.id AND v.status = 'approved'), 0)::text AS variations
      FROM proj.project p
      WHERE p.entity_id = ${entityId} AND p.status <> 'cancelled'
        AND (p.start_on IS NULL OR p.start_on <= ${asOf})
      ORDER BY p.number`;
    const out: WorkDone[] = [];
    for (const p of projects) {
      const [books] = await db<{ cost: string; billed: string }[]>`
        SELECT coalesce(sum(l.debit - l.credit) FILTER (WHERE a.nature = 'expense'
            AND a.system_key IS DISTINCT FROM 'contract_loss_expense'), 0)::text AS cost,
          coalesce(sum(l.credit - l.debit) FILTER (WHERE a.nature = 'income'), 0)::text AS billed
        FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id JOIN acc.account a ON a.id = l.account_id
        WHERE l.project_id = ${p.id} AND v.voucher_date <= ${asOf} AND v.source_kind IS DISTINCT FROM ${SOURCE}
          AND NOT EXISTS (SELECT 1 FROM acc.voucher o WHERE o.id = v.reverses_id AND o.source_kind = ${SOURCE})`;
      const [m] = await db<{ contract: string; measured: string }[]>`
        WITH items AS (
          SELECT n.line_key, n.rate, n.amount FROM est.boq b
          JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
          WHERE b.project_id = ${p.id} AND b.kind = 'contract' AND b.archived_at IS NULL)
        SELECT coalesce((SELECT sum(amount) FROM items), 0)::text AS contract,
          coalesce((SELECT sum(round(m.qty * i.rate, 2)) FROM proj.measurement m JOIN items i ON i.line_key = m.line_key
            WHERE m.project_id = ${p.id} AND m.measured_on <= ${asOf}), 0)::text AS measured`;
      const contract =
        (cents(p.contract) > 0n ? cents(p.contract) : cents(m!.contract)) + cents(p.variations);
      if (contract <= 0n) continue;
      const w = await this.costs.work(db, p.id);
      const estimate = w.worked.reduce((t, r) => t + r.forecast, 0n);
      const cost = cents(books!.cost);
      const billed = cents(books!.billed);
      if (cost === 0n && billed === 0n && cents(m!.measured) === 0n) continue;
      const r = workDone({ contract, estimate, cost, measured: cents(m!.measured), billed });
      out.push({
        project: { id: p.id, number: p.number, name: p.name },
        method: r.method,
        contractValue: fromCents(contract),
        estimatedCost: fromCents(r.estimate),
        costToDate: fromCents(cost),
        measuredValue: fromCents(cents(m!.measured)),
        pctComplete: r.pct,
        recognised: fromCents(r.recognised),
        billed: fromCents(billed),
        adjustment: fromCents(r.adjustment),
        lossProvision: fromCents(r.lossProvision),
        margin: fromCents(r.margin),
        posted: null,
      });
    }
    return out;
  }

  async month(claims: TenantClaims, entityId: string, month: string) {
    await this.may(claims, 'accounts.view');
    const db = await this.tenants.forTenant(claims.ten);
    const rows = await this.compute(db, entityId, lastDay(month));
    const posted = await db<
      { projectId: string; voucher: string | null; reversal: string | null }[]
    >`
      SELECT r.project_id AS "projectId", v.number AS voucher, x.number AS reversal
      FROM acc.revenue_recognition r LEFT JOIN acc.voucher v ON v.id = r.voucher_id
      LEFT JOIN acc.voucher x ON x.id = r.reversal_id
      WHERE r.entity_id = ${entityId} AND r.month = ${`${month}-01`}`;
    const byProject = new Map(posted.map((p) => [p.projectId, p]));
    const sum = (k: 'recognised' | 'billed' | 'adjustment' | 'lossProvision' | 'costToDate') =>
      fromCents(rows.reduce((t, r) => t + cents(r[k]), 0n));
    return {
      month,
      asOf: lastDay(month),
      rows: rows.map((r) => ({ ...r, posted: byProject.get(r.project.id) ?? null })),
      totals: {
        recognised: sum('recognised'),
        billed: sum('billed'),
        adjustment: sum('adjustment'),
        lossProvision: sum('lossProvision'),
        costToDate: sum('costToDate'),
      },
      posted: posted.length > 0,
      mayPost: await this.permissions.can(claims, 'accounts.post'),
    };
  }

  /** The month's journal (unbilled revenue or billing in excess, and the loss provision), reversed next month. */
  async post(claims: TenantClaims, entityId: string, month: string) {
    await this.may(claims, 'accounts.post');
    const db = await this.tenants.forTenant(claims.ten);
    const asOf = lastDay(month);
    const rows = (await this.compute(db, entityId, asOf)).filter(
      (r) => cents(r.adjustment) !== 0n || cents(r.lossProvision) !== 0n,
    );
    if (!rows.length)
      throw new BadRequestException({
        code: 'nothing_to_post',
        message: 'No project has work done apart from what its bills took.',
      });
    await db
      .begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`revrec ${entityId} ${month}`}))`;
        const [done] = await tx`
          SELECT 1 FROM acc.revenue_recognition WHERE entity_id = ${entityId} AND month = ${`${month}-01`}`;
        if (done)
          throw new ConflictException({
            code: 'already_posted',
            message: 'This month is already posted.',
          });
        const role = (r: Parameters<LedgerService['roleAccount']>[2]) =>
          this.ledger.roleAccount(tx, entityId, r);
        const [revenue, asset, liability, provision, lossExpense] = await Promise.all([
          role('sales_works_contract'),
          role('unbilled_revenue'),
          role('billing_in_excess'),
          role('contract_loss_provision'),
          role('contract_loss_expense'),
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
          const a = cents(r.adjustment);
          const l = cents(r.lossProvision);
          const pct = `${(r.pctComplete * 100).toFixed(1)}% complete by ${r.method}`;
          const out = [];
          if (a > 0n)
            out.push(
              line(asset, a, 0n, r.project.id, `${r.project.number}: ${pct}`),
              line(revenue, 0n, a, r.project.id, `${r.project.number}: work done, not billed`),
            );
          if (a < 0n)
            out.push(
              line(revenue, -a, 0n, r.project.id, `${r.project.number}: billed ahead of work done`),
              line(liability, 0n, -a, r.project.id, `${r.project.number}: ${pct}`),
            );
          if (l > 0n)
            out.push(
              line(lossExpense, l, 0n, r.project.id, `${r.project.number}: expected loss`),
              line(provision, 0n, l, r.project.id, `${r.project.number}: expected loss`),
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
            narration: `Revenue on work done, ${month} (Ind AS 115)`,
            reference: `REVREC/${month}`,
            lines,
          },
          { kind: SOURCE, id: entityId },
        );
        const back = await this.ledger.post(
          tx,
          claims,
          {
            entityId,
            type: 'journal',
            date: nextFirst(month),
            narration: `Reversal of revenue on work done, ${month}`,
            reference: v!.number,
            lines: lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
          },
          null,
          v!.id,
        );
        for (const r of rows)
          await tx`
            INSERT INTO acc.revenue_recognition (entity_id, project_id, month, method, contract_value, estimated_cost,
              cost_to_date, measured_value, pct_complete, recognised, billed, adjustment, loss_provision, voucher_id,
              reversal_id, created_by)
            VALUES (${entityId}, ${r.project.id}, ${`${month}-01`}, ${r.method}, ${r.contractValue},
              ${r.estimatedCost}, ${r.costToDate}, ${r.measuredValue}, ${r.pctComplete}, ${r.recognised},
              ${r.billed}, ${r.adjustment}, ${r.lossProvision}, ${v!.id}, ${back!.id}, ${claims.sub})`;
      })
      .catch(fromDb);
    return this.month(claims, entityId, month);
  }
}
