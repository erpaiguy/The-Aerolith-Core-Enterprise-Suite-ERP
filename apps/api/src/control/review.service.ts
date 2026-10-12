// The portfolio dashboard and a project's monthly review (docs/wave4-plan.md step 7): one place for what Wave 4 works
// out — cost against budget and forecast, earned value, cash, variations, contracts and risks — from the services
// that work it, so the figures always agree with their own screens.
import { Injectable } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { cents, fromCents } from '../project/money.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { addMonths, monthEnd } from './cash-rules.js';
import { CashFlowService } from './cash-flow.service.js';
import { ContractsService } from './contracts.service.js';
import { CostControlService } from './cost-control.service.js';
import { EarnedValueService } from './earned-value.service.js';
import { RisksService } from './risks.service.js';
import { VariationService } from './variation.service.js';

const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

@Injectable()
export class ReviewService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly projects: ProjectService,
    private readonly cost: CostControlService,
    private readonly ev: EarnedValueService,
    private readonly cash: CashFlowService,
    private readonly variations: VariationService,
    private readonly contracts: ContractsService,
    private readonly risks: RisksService,
  ) {}

  /** One project's figures for a tile or a review, as of a date. */
  private async figures(claims: TenantClaims, projectId: string, asOf: string) {
    const db = await this.tenants.forTenant(claims.ten);
    const [c] = await db<{ contract: string }[]>`
      SELECT coalesce(sum(n.amount), 0)::text AS contract FROM est.boq b
      JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
      WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL`;
    const [cost, ev, cash, vo, ct, rk] = await Promise.all([
      this.cost.report(claims, projectId),
      this.ev.report(claims, projectId, { asOf }),
      this.cash.project(claims, projectId, { asOf, by: 'month' }),
      this.variations.register(claims, projectId),
      this.contracts.register(claims, projectId, asOf),
      this.risks.register(claims, projectId),
    ]);
    const contract = cents(c!.contract);
    const approvedVariations = cents(vo.totals.approved?.value ?? '0.00');
    const forecastMargin = contract - cents(cost.totals.forecast);
    const tenderMargin = contract - approvedVariations - cents(cost.totals.original);
    const actualCash = cash.periods
      .filter((p) => p.actual)
      .reduce((a, p) => a + cents(cash.totals.net[p.key] ?? '0.00'), cents(cash.opening));
    const overdue = await db<{ owed: string }[]>`
      SELECT coalesce(sum((b.certified ->> 'net')::numeric
        - coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id
            WHERE a.bill_id = b.id AND a.kind = 'bill' AND r.status = 'posted' AND r.received_on <= ${asOf}), 0)
        - coalesce((SELECT sum(n.total) FROM acc.credit_note n WHERE n.bill_id = b.id AND n.note_date <= ${asOf}), 0)), 0)::text AS owed
      FROM acc.client_bill b
      LEFT JOIN ctl.cash_terms t ON t.project_id = b.project_id
      WHERE b.project_id = ${projectId} AND b.status = 'certified'
        AND b.invoice_date + coalesce(t.client_pay_days, 30) < ${asOf}::date`;
    const open = (s: string) => vo.totals[s] ?? { count: 0, value: '0.00' };
    const pct = (a: bigint, b: bigint) =>
      b === 0n ? null : ((Number(a) / Number(b)) * 100).toFixed(1);
    return {
      contract: fromCents(contract),
      budget: cost.totals.budget,
      forecastCost: cost.totals.forecast,
      actualCost: cost.totals.actual,
      committed: cost.totals.committed,
      forecastMargin: fromCents(forecastMargin),
      forecastMarginPct: pct(forecastMargin, contract),
      tenderMargin: fromCents(tenderMargin),
      tenderMarginPct: pct(tenderMargin, contract - approvedVariations),
      spi: ev.project.spi,
      cpi: ev.project.cpi,
      eac: ev.project.eac[ev.method as keyof typeof ev.project.eac],
      cashToDate: fromCents(actualCash),
      overdueReceivables: fromCents(cents(overdue[0]!.owed)),
      openVariations: {
        count: open('draft').count + open('pending').count + open('submitted').count,
        value: fromCents(
          cents(open('draft').value) +
            cents(open('pending').value) +
            cents(open('submitted').value),
        ),
        atRisk: vo.atRisk,
      },
      openClaims: fromCents(
        (ct.claims as unknown as { status: string; amount: string }[])
          .filter((x) => ['submitted', 'negotiation'].includes(x.status))
          .reduce((a, x) => a + cents(x.amount), 0n),
      ),
      worstRisk: rk.top[0] ?? null,
      openRiskValue: rk.openExpectedValue,
      contingencyRemaining: rk.contingency?.remaining ?? '0.00',
      parts: { cost, ev, cash, vo, ct, rk },
    };
  }

  async portfolio(claims: TenantClaims, asOf = todayIst()) {
    const db = await this.tenants.forTenant(claims.ten);
    const all = await db<{ id: string; number: string; name: string }[]>`
      SELECT id, number, name FROM proj.project WHERE status NOT IN ('closed', 'cancelled') ORDER BY number`;
    type Tile = { project: { id: string; number: string; name: string } } & Omit<
      Awaited<ReturnType<ReviewService['figures']>>,
      'parts'
    >;
    const tiles: Tile[] = [];
    for (const p of all) {
      const seen = await this.projects.access(db, claims, p.id).then(
        () => true,
        () => false,
      );
      if (!seen) continue;
      const { parts: _parts, ...f } = await this.figures(claims, p.id, asOf);
      tiles.push({ project: p, ...f });
    }
    const sum = (
      k:
        | 'contract'
        | 'forecastCost'
        | 'forecastMargin'
        | 'cashToDate'
        | 'overdueReceivables'
        | 'openClaims',
    ) => fromCents(tiles.reduce((a, t) => a + cents(t[k]), 0n));
    return {
      asOf,
      tiles,
      totals: {
        contract: sum('contract'),
        forecastCost: sum('forecastCost'),
        forecastMargin: sum('forecastMargin'),
        cashToDate: sum('cashToDate'),
        overdueReceivables: sum('overdueReceivables'),
        openClaims: sum('openClaims'),
        variationsAtRisk: fromCents(tiles.reduce((a, t) => a + cents(t.openVariations.atRisk), 0n)),
      },
    };
  }

  /** A project's monthly review: everything as of the month's end (or today, for the current month). */
  async review(claims: TenantClaims, projectId: string, month: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const end = monthEnd(`${month}-01`);
    const today = todayIst();
    const asOf = end < today ? end : today;
    const f = await this.figures(claims, projectId, asOf);
    const { cost, ev, cash, vo, ct, rk } = f.parts;
    const nextKeys = [1, 2, 3].map((i) => `f${addMonths(`${month}-01`, i).slice(0, 7)}`);
    const thisKey = (k: string) => cash.periods.find((p) => p.key === k);
    const [p] = await db<
      { number: string; name: string }[]
    >`SELECT number, name FROM proj.project WHERE id = ${projectId}`;
    const in30 = new Date(Date.parse(`${asOf}T00:00:00Z`) + 30 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return {
      project: p,
      month,
      asOf,
      summary: { ...f, parts: undefined },
      cost: {
        totals: cost.totals,
        worst: [...cost.rows].sort((a, b) => Number(a.variance) - Number(b.variance)).slice(0, 5),
        alerts: cost.alerts,
      },
      earnedValue: { ...ev.project, method: ev.method, baseline: ev.baseline },
      cash: {
        month: {
          in: cash.totals.in[`a${month}`] ?? cash.totals.in[`f${month}`] ?? '0.00',
          out: cash.totals.out[`a${month}`] ?? cash.totals.out[`f${month}`] ?? '0.00',
        },
        next: nextKeys.map((k) => ({
          month: thisKey(k)?.label ?? k.slice(1),
          in: cash.totals.in[k] ?? '0.00',
          out: cash.totals.out[k] ?? '0.00',
          position: cash.position[k] ?? '0.00',
        })),
      },
      variations: {
        totals: vo.totals,
        atRisk: vo.atRisk,
        open: vo.variations.filter((v) => ['draft', 'pending', 'submitted'].includes(v.status)),
      },
      contracts: { calendar: ct.calendar.filter((x) => x.date <= in30) },
      risks: { top: rk.top, openExpectedValue: rk.openExpectedValue, contingency: rk.contingency },
    };
  }
}
