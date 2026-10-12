// Earned value (docs/wave4-plan.md step 3): PV from the baseline schedule cost-loaded by the budget, EV from the
// measurement book at budget rates, AC from the ledger (step 1's actual); indices, the usual estimates at completion
// side by side, by WBS element, and monthly S-curves.
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { treeOrder } from '../project/cost-code.service.js';
import { cents, fromCents } from '../project/money.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import { addMonths, monthEnd, monthStart } from './cash-rules.js';
import { CostControlService } from './cost-control.service.js';
import { earnedValue, METHOD_LABELS, METHODS, type Method } from './ev-rules.js';

type Db = Sql | TransactionSql;
const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
/** A decimal as an integer × 10⁴. */
const r4 = (v: string) => {
  const neg = v.startsWith('-');
  const [i = '0', f = ''] = (neg ? v.slice(1) : v).split('.');
  const x = BigInt(i) * 10_000n + BigInt((f + '0000').slice(0, 4));
  return neg ? -x : x;
};
const money = (v: bigint | null) => (v === null ? null : fromCents(v));

interface Item {
  lineKey: string;
  wbsId: string | null;
  value: bigint; // the contract quantity at the budget rate
  rate: bigint; // the budget rate (or the contract rate scaled), × 10⁴
}

@Injectable()
export class EarnedValueService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly cost: CostControlService,
  ) {}

  /**
   * Each contract item at budget value: its budget line's rate (sharing its key), or else its contract rate scaled
   * by the project's budget ÷ contract.
   */
  private async items(db: Db, projectId: string) {
    const rows = await db<
      {
        line_key: string;
        wbs_id: string | null;
        qty: string | null;
        rate: string | null;
        budget_rate: string | null;
      }[]
    >`
      WITH budget AS (
        SELECT DISTINCT ON (bn.line_key) bn.line_key, bn.rate
        FROM est.boq bb JOIN est.boq_node bn ON bn.boq_id = bb.id AND bn.node_type = 'item'
        WHERE bb.project_id = ${projectId} AND bb.kind = 'budget' AND bb.archived_at IS NULL
        ORDER BY bn.line_key, bb.created_at)
      SELECT n.line_key, m.wbs_id, n.qty::text, n.rate::text, bu.rate::text AS budget_rate
      FROM est.boq b
      JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
      LEFT JOIN budget bu ON bu.line_key = n.line_key
      LEFT JOIN proj.boq_line_map m ON m.project_id = b.project_id AND m.line_key = n.line_key
      WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL`;
    const [t] = await db<{ contract: string; budget: string }[]>`
      SELECT coalesce(sum(n.amount) FILTER (WHERE b.kind = 'contract'), 0)::text AS contract,
        coalesce(sum(n.amount) FILTER (WHERE b.kind = 'budget'), 0)::text AS budget
      FROM est.boq b JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
      WHERE b.project_id = ${projectId} AND b.archived_at IS NULL`;
    const [contract, budget] = [cents(t!.contract), cents(t!.budget)];
    // Rates to 4 decimals as integers (× 10⁴) so value = qty × rate stays exact before rounding to the paisa.
    const items: Item[] = rows.map((r) => {
      let rate: bigint;
      if (r.budget_rate !== null) rate = r4(r.budget_rate);
      else if (r.rate !== null && contract !== 0n) rate = (r4(r.rate) * budget) / contract;
      else rate = 0n;
      const qty = r.qty === null ? 0n : r4(r.qty);
      // qty (×10⁴) × rate (×10⁴) ÷ 10⁶ = paise, rounded.
      const value = (qty * rate + 500_000n) / 1_000_000n;
      return { lineKey: r.line_key, wbsId: r.wbs_id, value, rate };
    });
    return { items, bac: budget };
  }

  async report(claims: TenantClaims, projectId: string, q: { asOf?: string }) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const asOf = q.asOf ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const { items, bac } = await this.items(db, projectId);
    const byKey = new Map(items.map((i) => [i.lineKey, i]));

    // PV: each linked item's budget value over the baseline span of each activity carrying it (shared equally),
    // spread evenly over calendar days.
    const spans = await db<
      { line_key: string; start: string; finish: string; shared: number; baseline: string }[]
    >`
      WITH p AS (
        SELECT id, baseline_id FROM sched.plan
        WHERE project_id = ${projectId} AND kind = 'project_schedule' AND archived_at IS NULL AND baseline_id IS NOT NULL),
      links AS (
        SELECT al.plan_id, al.activity_id, al.line_key, count(*) OVER (PARTITION BY al.line_key)::int AS shared
        FROM sched.activity_line al JOIN p ON p.id = al.plan_id)
      SELECT l.line_key, to_char(b.start_on, 'YYYY-MM-DD') AS start, to_char(b.finish_on, 'YYYY-MM-DD') AS finish,
        l.shared, bl.name AS baseline
      FROM links l JOIN p ON p.id = l.plan_id
      JOIN sched.baseline_activity b ON b.plan_id = l.plan_id AND b.baseline_id = p.baseline_id AND b.activity_id = l.activity_id
      JOIN sched.baseline bl ON bl.id = p.baseline_id
      WHERE b.start_on IS NOT NULL AND b.finish_on IS NOT NULL`;
    const pvAt = (d: string, wbs?: string | null) => {
      let v = 0n;
      for (const s of spans) {
        const it = byKey.get(s.line_key);
        if (!it || (wbs !== undefined && it.wbsId !== wbs)) continue;
        const len = day(s.finish) - day(s.start) + 1;
        const done = Math.min(Math.max(day(d) - day(s.start) + 1, 0), len);
        v += (it.value * BigInt(done)) / (BigInt(len) * BigInt(s.shared));
      }
      return v;
    };
    const baselined = spans.length > 0;

    // EV: measured quantities to each date at budget rates.
    const measured = await db<{ line_key: string; on: string; qty: string }[]>`
      SELECT line_key, to_char(measured_on, 'YYYY-MM-DD') AS on, sum(qty)::text AS qty
      FROM proj.measurement WHERE project_id = ${projectId} GROUP BY line_key, measured_on`;
    const evAt = (d: string, wbs?: string | null) => {
      const done = new Map<string, bigint>();
      for (const m of measured)
        if (m.on <= d) done.set(m.line_key, (done.get(m.line_key) ?? 0n) + r4(m.qty));
      let v = 0n;
      for (const [k, qty] of done) {
        const it = byKey.get(k);
        if (!it || (wbs !== undefined && it.wbsId !== wbs)) continue;
        const x = qty * it.rate; // × 10⁸; rounded half away from zero to the paisa (× 10²)
        v += (x + (x < 0n ? -500_000n : 500_000n)) / 1_000_000n;
      }
      return v;
    };

    // AC: the ledger's actual (step 1), each line on its WBS element where it has one.
    const w = await this.cost.work(db, projectId);
    const acAt = (d: string, wbs?: string | null) =>
      w.ledgerCharges
        .filter((l) => l.date <= d && (wbs === undefined || l.wbsId === wbs))
        .reduce((a, l) => a + cents(l.amount), 0n);
    const bottomUp = w.worked.reduce((a, r) => a + r.forecast, 0n);

    const [s] = await db<
      { method: Method }[]
    >`SELECT method FROM ctl.ev_settings WHERE project_id = ${projectId}`;
    const method = s?.method ?? 'cpi';
    const at = (d: string, wbs?: string | null, bacOf = bac, bottom = bottomUp) => {
      const pv = baselined ? pvAt(d, wbs) : null;
      const ev = evAt(d, wbs);
      const ac = acAt(d, wbs);
      const r = earnedValue({ bac: bacOf, pv, ev, ac, bottomUp: bottom });
      const eac = r.eac[method];
      return {
        bac: fromCents(bacOf),
        pv: money(pv),
        ev: fromCents(ev),
        ac: fromCents(ac),
        sv: money(r.sv),
        cv: fromCents(r.cv),
        spi: r.spi,
        cpi: r.cpi,
        eac: Object.fromEntries(METHODS.map((m) => [m, money(r.eac[m])])) as Record<
          Method,
          string | null
        >,
        etc: eac === null ? null : fromCents(eac - ac),
        vac: eac === null ? null : fromCents(bacOf - eac),
        pctPlanned:
          pv === null || bacOf === 0n ? null : ((Number(pv) / Number(bacOf)) * 100).toFixed(1),
        pctDone: bacOf === 0n ? null : ((Number(ev) / Number(bacOf)) * 100).toFixed(1),
        pctSpent: bacOf === 0n ? null : ((Number(ac) / Number(bacOf)) * 100).toFixed(1),
      };
    };

    // By WBS element: its budget (from the budget's own mapping) and step 1's forecast for its rows.
    const wbs = treeOrder(
      await db<
        { id: string; parentId: string | null; code: string; name: string; position: number }[]
      >`
        SELECT id, parent_id AS "parentId", code, name, position FROM proj.wbs WHERE project_id = ${projectId}`,
      (a, b) => a.position - b.position || a.code.localeCompare(b.code, 'en', { numeric: true }),
    );
    const wbsBudget = new Map<string | null, bigint>();
    const wbsForecast = new Map<string | null, bigint>();
    for (const r of w.worked) {
      const id = r.key.split('|')[0] || null;
      wbsBudget.set(id, (wbsBudget.get(id) ?? 0n) + r.budget);
      wbsForecast.set(id, (wbsForecast.get(id) ?? 0n) + r.forecast);
    }
    const byWbs = [
      ...wbs.map((x) => ({
        id: x.id as string | null,
        code: x.code,
        name: x.name,
        depth: x.depth,
      })),
      { id: null, code: '', name: 'Not on a WBS element', depth: 0 },
    ]
      .map((x) => ({
        ...x,
        ...at(asOf, x.id, wbsBudget.get(x.id) ?? 0n, wbsForecast.get(x.id) ?? 0n),
      }))
      .filter(
        (x) =>
          x.bac !== '0.00' || x.ev !== '0.00' || x.ac !== '0.00' || (x.pv ?? '0.00') !== '0.00',
      );

    // S-curves: month ends from the first date anything happened or was planned to the later of the baseline finish
    // and the date, cumulative.
    const dates = [
      ...spans.flatMap((x) => [x.start, x.finish]),
      ...measured.map((m) => m.on),
      ...w.ledgerCharges.map((l) => l.date),
      asOf,
    ].sort();
    const first = monthStart(dates[0]!);
    const last = dates.at(-1)!;
    const months: string[] = [];
    for (let m = first; m <= last && months.length < 120; m = addMonths(m, 1)) months.push(m);
    const curve = {
      months: months.map((m) => m.slice(0, 7)),
      pv: baselined ? months.map((m) => fromCents(pvAt(monthEnd(m)))) : null,
      ev: months.map((m) =>
        monthStart(m) > asOf ? null : fromCents(evAt(monthEnd(m) < asOf ? monthEnd(m) : asOf)),
      ),
      ac: months.map((m) =>
        monthStart(m) > asOf ? null : fromCents(acAt(monthEnd(m) < asOf ? monthEnd(m) : asOf)),
      ),
    };
    return {
      asOf,
      baseline: spans[0]?.baseline ?? null,
      method,
      methods: METHODS.map((m) => ({ method: m, label: METHOD_LABELS[m] })),
      project: at(asOf),
      byWbs,
      curve,
      mayChoose: await this.permissions.can(claims, 'cost.forecast'),
    };
  }

  async choose(claims: TenantClaims, projectId: string, method: Method) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    if (!(await this.permissions.can(claims, 'cost.forecast')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'cost.forecast',
        message: 'This needs the cost forecasting permission.',
      });
    if (!METHODS.includes(method))
      throw new BadRequestException({ code: 'bad_method', message: 'No such method.' });
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO ctl.ev_settings (project_id, method, updated_by) VALUES (${projectId}, ${method}, ${claims.sub})
        ON CONFLICT (project_id) DO UPDATE SET method = EXCLUDED.method, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await audit(tx, claims.sub, 'ev.method', 'project', projectId, { method });
    });
    return this.report(claims, projectId, {});
  }
}
