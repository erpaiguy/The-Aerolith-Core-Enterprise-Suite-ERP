// Cost control (docs/wave4-plan.md step 1): per project, by WBS element and cost code, the original and current
// budget, what is committed on orders, what the ledger has as actual, cost to complete, forecast and variance.
//
// Orders, bills and automatic postings carry no WBS element or cost code, so each cost is charged by rules, in order:
// an allocation made here; a cost code typed on a manual voucher; for an order line (and the bills and debit notes
// against it), the requisition line behind it, through its RFQ line; the company's default for its source; otherwise
// it is unallocated, and shown as such.
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
import { treeOrder } from '../project/cost-code.service.js';
import { cents, fromCents } from '../project/money.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import {
  FIELDS,
  rollUp,
  rowKey,
  splitKey,
  work,
  zero,
  addInto,
  type Sums,
} from './control-rules.js';

type Db = Sql | TransactionSql;

export const SOURCES = [
  'material',
  'labour',
  'equipment',
  'subcontract',
  'other',
  'payroll',
  'equipment_costing',
  'bocw_cess',
  'depreciation',
  'unordered_bill',
  'other_entry',
] as const;
export type Source = (typeof SOURCES)[number];
export const SOURCE_LABELS: Record<Source, string> = {
  material: 'Order lines for materials',
  labour: 'Order lines for labour',
  equipment: 'Order lines for equipment',
  subcontract: 'Work orders and subcontract lines',
  other: 'Other order lines',
  payroll: 'Payroll',
  equipment_costing: 'Own equipment charged to projects',
  bocw_cess: 'BOCW cess',
  depreciation: 'Depreciation',
  unordered_bill: 'Bills without an order',
  other_entry: 'Other ledger entries',
};
const SOURCE_OF_ENTRY: Record<string, Source> = {
  payroll_run: 'payroll',
  payroll_settlement: 'payroll',
  equipment_costing: 'equipment_costing',
  bocw_cess: 'bocw_cess',
  depreciation_run: 'depreciation',
  asset_disposal: 'depreciation',
};

export type How = 'allocated' | 'voucher' | 'requisition' | 'default' | 'unallocated';
interface Charge {
  wbsId: string | null;
  costCodeId: string | null;
  how: How;
}

interface OrderLine {
  poId: string;
  number: string;
  kind: 'purchase' | 'work';
  status: string;
  party: string;
  lineKey: string;
  description: string;
  resourceId: string | null;
  resourceKind: string | null;
  amount: string;
  gstPct: string;
  deliverBy: string | null;
  billed: string;
  reqWbs: string | null;
  reqCost: string | null;
  allocWbs: string | null;
  allocCost: string | null;
}
interface LedgerLine {
  voucherId: string;
  position: number;
  number: string;
  date: string;
  sourceKind: string | null;
  account: string;
  note: string;
  amount: string;
  costCodeId: string | null;
  poId: string | null;
  lineKey: string | null;
  billNo: string | null;
  orderless: boolean;
  allocWbs: string | null;
  allocCost: string | null;
}

const monthOf = (d: string) => `${d.slice(0, 7)}-01`;
/** Codes in natural order, with nothing (not placed) last. */
const lastNull = (a: string | undefined, b: string | undefined) =>
  a === b
    ? 0
    : a === undefined
      ? 1
      : b === undefined
        ? -1
        : a.localeCompare(b, 'en', { numeric: true });

@Injectable()
export class CostControlService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
  ) {}

  private async forecaster(db: Db, claims: TenantClaims, projectId: string) {
    await this.projects.access(db, claims, projectId);
    if (!(await this.permissions.can(claims, 'cost.forecast')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'cost.forecast',
        message: 'This needs the cost forecasting permission.',
      });
  }

  private async defaults(db: Db) {
    const rows = await db<{ source: Source; cost_code_id: string }[]>`
      SELECT source, cost_code_id FROM ctl.default_charge`;
    return new Map(rows.map((r) => [r.source, r.cost_code_id]));
  }

  /** Approved order lines of the project, with what is billed on each and the requisition behind it. */
  private async orderLines(db: Db, projectId: string) {
    return db<OrderLine[]>`
      SELECT o.id AS "poId", o.number, o.kind, o.status, p.name AS party, l.line_key AS "lineKey", l.description,
        l.resource_id AS "resourceId", r.kind AS "resourceKind", l.amount::text, l.gst_pct::text AS "gstPct",
        to_char(v.deliver_by, 'YYYY-MM-DD') AS "deliverBy",
        coalesce((SELECT sum(bl.amount) FROM acc.vendor_bill b JOIN acc.vendor_bill_line bl ON bl.bill_id = b.id
          WHERE b.order_id = o.id AND b.status = 'posted' AND bl.line_key = l.line_key), 0)::text AS billed,
        q.wbs_id AS "reqWbs", q.cost_code_id AS "reqCost", a.wbs_id AS "allocWbs", a.cost_code_id AS "allocCost"
      FROM proc.purchase_order o
      JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
      JOIN proc.po_line l ON l.revision_id = v.id
      JOIN platform.party p ON p.id = o.party_id
      LEFT JOIN est.resource r ON r.id = l.resource_id
      LEFT JOIN LATERAL (
        SELECT coalesce(rl.wbs_id, m.wbs_id) AS wbs_id, m.cost_code_id
        FROM proc.rfq_requisition_line x
        JOIN proc.requisition_line rl ON rl.requisition_id = x.requisition_id AND rl.position = x.position
        LEFT JOIN proj.boq_line_map m ON m.project_id = o.project_id AND m.line_key = rl.line_key
        WHERE x.rfq_line_id = l.rfq_line_id
        ORDER BY (coalesce(rl.wbs_id, m.wbs_id) IS NULL), (m.cost_code_id IS NULL), x.requisition_id, x.position
        LIMIT 1) q ON true
      LEFT JOIN ctl.allocation a ON a.po_id = o.id AND a.line_key = l.line_key
      WHERE o.project_id = ${projectId} AND o.status <> 'cancelled'
      ORDER BY o.number, l.position`;
  }

  /**
   * The project's lines on expense ledgers. A bill's voucher has its items first, one line for each bill line with an
   * amount, in order: so the n-th voucher line is the n-th such bill line, and through its line key, the order line.
   * A debit note credits the bill's first line's ledger: it follows that line.
   */
  private async ledgerLines(db: Db, projectId: string) {
    return db<LedgerLine[]>`
      WITH bill_items AS (
        SELECT b.voucher_id, b.id AS bill_id, b.order_id, b.bill_no, bl.line_key,
          row_number() OVER (PARTITION BY b.id ORDER BY bl.position)::int AS n
        FROM acc.vendor_bill b JOIN acc.vendor_bill_line bl ON bl.bill_id = b.id
        WHERE b.project_id = ${projectId} AND b.voucher_id IS NOT NULL AND bl.amount <> 0
      )
      SELECT l.voucher_id AS "voucherId", l.position, v.number, to_char(v.voucher_date, 'YYYY-MM-DD') AS date,
        v.source_kind AS "sourceKind", acct.name AS account, l.note, (l.debit - l.credit)::text AS amount,
        l.cost_code_id AS "costCodeId",
        coalesce(bi.order_id, dn.order_id) AS "poId", coalesce(bi.line_key, dn.line_key) AS "lineKey",
        coalesce(bi.bill_no, dn.bill_no) AS "billNo",
        (coalesce(bi.bill_id, dn.bill_id) IS NOT NULL AND coalesce(bi.order_id, dn.order_id) IS NULL) AS orderless,
        a.wbs_id AS "allocWbs", a.cost_code_id AS "allocCost"
      FROM acc.voucher_line l
      JOIN acc.voucher v ON v.id = l.voucher_id
      JOIN acc.account acct ON acct.id = l.account_id AND acct.nature = 'expense'
      LEFT JOIN bill_items bi ON bi.voucher_id = v.id AND bi.n = l.position
      LEFT JOIN LATERAL (
        SELECT b.id AS bill_id, b.order_id, b.bill_no, bl.line_key FROM acc.debit_note d
        JOIN acc.vendor_bill b ON b.id = d.bill_id
        JOIN acc.vendor_bill_line bl ON bl.bill_id = b.id AND bl.position = 1
        WHERE d.voucher_id = v.id) dn ON true
      LEFT JOIN ctl.allocation a ON a.voucher_id = l.voucher_id AND a.position = l.position
      WHERE l.project_id = ${projectId} AND coalesce(v.source_kind, '') NOT IN ('year_end', 'closing_stock')
      ORDER BY v.voucher_date, v.number, l.position`; // year-end and closing stock are not cost, as in the project P&L
  }

  private chargeOrder(
    l: Pick<OrderLine, 'kind' | 'resourceKind' | 'reqWbs' | 'reqCost' | 'allocWbs' | 'allocCost'>,
    defaults: Map<Source, string>,
  ): Charge & { source: Source } {
    const source = (
      l.resourceKind && SOURCES.includes(l.resourceKind as Source)
        ? l.resourceKind
        : l.kind === 'work'
          ? 'subcontract'
          : 'other'
    ) as Source;
    const wbsId = l.allocWbs ?? l.reqWbs;
    const costCodeId = l.allocCost ?? l.reqCost ?? defaults.get(source) ?? null;
    const how: How =
      l.allocWbs || l.allocCost
        ? 'allocated'
        : l.reqWbs || l.reqCost
          ? 'requisition'
          : costCodeId
            ? 'default'
            : 'unallocated';
    return { wbsId, costCodeId, how, source };
  }

  /** Every figure, worked now (also read by cash flow, step 2). */
  async work(db: Db, projectId: string) {
    const defaults = await this.defaults(db);
    const orders = await this.orderLines(db, projectId);
    const byOrderLine = new Map(orders.map((o) => [`${o.poId}|${o.lineKey}`, o]));
    const ledger = await this.ledgerLines(db, projectId);
    const budget = await db<
      { wbs_id: string | null; cost_code_id: string | null; amount: string }[]
    >`
      SELECT m.wbs_id, m.cost_code_id, coalesce(sum(n.amount), 0)::text AS amount
      FROM est.boq b
      JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
      LEFT JOIN proj.boq_line_map m ON m.project_id = b.project_id AND m.line_key = n.line_key
      WHERE b.project_id = ${projectId} AND b.kind = 'budget' AND b.archived_at IS NULL
      GROUP BY m.wbs_id, m.cost_code_id`;
    const [base] = await db<{ rows: Record<string, string>; taken_at: string }[]>`
      SELECT rows, to_char(taken_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS taken_at
      FROM ctl.baseline WHERE project_id = ${projectId}`;
    const ctc = await db<{ row_key: string; amount: string; note: string }[]>`
      SELECT row_key, amount::text, note FROM ctl.ctc WHERE project_id = ${projectId}`;

    const rows = new Map<
      string,
      { budget: bigint; committed: bigint; actual: bigint; original: bigint }
    >();
    const row = (k: string) => {
      let r = rows.get(k);
      if (!r) rows.set(k, (r = { budget: 0n, committed: 0n, actual: 0n, original: 0n }));
      return r;
    };
    for (const b of budget) row(rowKey(b.wbs_id, b.cost_code_id)).budget += cents(b.amount);
    if (base) for (const [k, v] of Object.entries(base.rows)) row(k).original += cents(v);
    else for (const r of rows.values()) r.original = r.budget;

    const orderCharges = orders.map((o) => {
      const c = this.chargeOrder(o, defaults);
      const open =
        o.status === 'closed'
          ? 0n
          : cents(o.amount) - cents(o.billed) > 0n
            ? cents(o.amount) - cents(o.billed)
            : 0n;
      row(rowKey(c.wbsId, c.costCodeId)).committed += open;
      return { ...o, ...c, committed: open };
    });

    const ledgerCharges = ledger.map((l) => {
      let wbsId = l.allocWbs;
      let costCodeId = l.allocCost;
      let how: How = wbsId || costCodeId ? 'allocated' : 'unallocated';
      let source: Source;
      if (!costCodeId && l.costCodeId) {
        costCodeId = l.costCodeId;
        if (how !== 'allocated') how = 'voucher';
      }
      const o = l.poId && l.lineKey ? byOrderLine.get(`${l.poId}|${l.lineKey}`) : undefined;
      if (o) {
        const c = this.chargeOrder(o, defaults);
        source = c.source;
        wbsId ??= c.wbsId;
        costCodeId ??= c.costCodeId;
        if (how === 'unallocated') how = c.how;
      } else {
        source = l.orderless
          ? 'unordered_bill'
          : (SOURCE_OF_ENTRY[l.sourceKind ?? ''] ?? 'other_entry');
        if (!costCodeId && l.sourceKind) {
          costCodeId = defaults.get(source) ?? null;
          if (costCodeId && how === 'unallocated') how = 'default';
        }
      }
      row(rowKey(wbsId, costCodeId)).actual += cents(l.amount);
      return { ...l, wbsId, costCodeId, how, source };
    });

    const entered = new Map(ctc.map((c) => [c.row_key, c]));
    const worked = [...rows.entries()].map(([key, f]) => {
      const e = entered.get(key);
      return { key, ...work(f, e ? cents(e.amount) : null), note: e?.note ?? '' };
    });
    for (const [key, e] of entered)
      if (!rows.has(key))
        worked.push({
          key,
          ...work({ original: 0n, budget: 0n, committed: 0n, actual: 0n }, cents(e.amount)),
          note: e.note,
        });
    return { worked, orderCharges, ledgerCharges, defaults, baseline: base ?? null };
  }

  private static str(s: Partial<Record<(typeof FIELDS)[number], bigint>>) {
    return Object.fromEntries(FIELDS.map((k) => [k, fromCents(s[k] ?? 0n)])) as Record<
      (typeof FIELDS)[number],
      string
    >;
  }

  async report(claims: TenantClaims, projectId: string, compare?: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const w = await this.work(db, projectId);
    const wbs = treeOrder(
      await db<
        { id: string; parentId: string | null; code: string; name: string; position: number }[]
      >`
        SELECT id, parent_id AS "parentId", code, name, position FROM proj.wbs WHERE project_id = ${projectId}`,
      (a, b) => a.position - b.position || a.code.localeCompare(b.code, 'en', { numeric: true }),
    );
    const codes = treeOrder(
      await db<{ id: string; parentId: string | null; code: string; name: string; kind: string }[]>`
        SELECT id, parent_id AS "parentId", code, name, kind FROM platform.cost_code`,
    );
    const wbsById = new Map(wbs.map((x) => [x.id, x]));
    const codeById = new Map(codes.map((x) => [x.id, x]));
    const ref = <T extends { id: string; code: string; name: string }>(
      m: Map<string, T>,
      id: string | null,
    ) => {
      const x = id ? m.get(id) : undefined;
      return x ? { id: x.id, code: x.code, name: x.name } : null;
    };
    const sumsOf = (r: (typeof w.worked)[number]): Partial<Sums> =>
      Object.fromEntries(FIELDS.map((k) => [k, r[k]]));
    const rows = w.worked
      .map((r) => {
        const { wbsId, costCodeId } = splitKey(r.key);
        return {
          key: r.key,
          wbs: ref(wbsById, wbsId),
          costCode: ref(codeById, costCodeId),
          ...CostControlService.str(sumsOf(r)),
          ctcComputed: r.ctcComputed,
          note: r.note,
        };
      })
      .sort(
        (a, b) =>
          lastNull(a.costCode?.code, b.costCode?.code) || lastNull(a.wbs?.code, b.wbs?.code),
      );
    const tree = <
      N extends { id: string; parentId: string | null; code: string; name: string; depth: number },
    >(
      nodes: N[],
      by: 'wbs' | 'cost',
    ) => {
      const r = rollUp(
        nodes,
        w.worked.map((x) => {
          const k = splitKey(x.key);
          return { key: by === 'wbs' ? k.wbsId : k.costCodeId, sums: sumsOf(x) };
        }),
      );
      return {
        nodes: r.nodes
          .filter((n) => FIELDS.some((k) => n.sums[k] !== 0n))
          .map((n) => ({
            id: n.node.id,
            parentId: n.node.parentId,
            code: n.node.code,
            name: n.node.name,
            depth: n.node.depth,
            ...CostControlService.str(n.sums),
          })),
        none: CostControlService.str(r.none),
      };
    };
    const totals = zero();
    for (const r of w.worked) addInto(totals, sumsOf(r));

    // Alerts: a cost code (with what is under it) committed and spent beyond its budget; a resource billed above
    // its rate in the approved material budget.
    const byCode = tree(codes, 'cost');
    // The most specific code only: a parent over because its child is over says nothing more.
    const over = byCode.nodes.filter((n) => cents(n.actual) + cents(n.committed) > cents(n.budget));
    const overParents = new Set(over.map((n) => n.parentId));
    const overBudget = over
      .filter((n) => !overParents.has(n.id))
      .map((n) => ({
        costCode: { id: n.id, code: n.code, name: n.name },
        budget: n.budget,
        exposure: fromCents(cents(n.actual) + cents(n.committed)),
        over: fromCents(cents(n.actual) + cents(n.committed) - cents(n.budget)),
      }));
    const rates = await db<
      {
        code: string;
        name: string;
        unit: string;
        budget_rate: string;
        billed_rate: string;
        qty: string;
      }[]
    >`
      WITH billed AS (
        SELECT l.resource_id, sum(bl.amount) AS amount, sum(bl.qty) AS qty
        FROM acc.vendor_bill b
        JOIN acc.vendor_bill_line bl ON bl.bill_id = b.id
        JOIN proc.po_revision v ON v.po_id = b.order_id AND v.status = 'approved'
        JOIN proc.po_line l ON l.revision_id = v.id AND l.line_key = bl.line_key
        WHERE b.project_id = ${projectId} AND b.status = 'posted' AND l.resource_id IS NOT NULL AND bl.qty > 0
        GROUP BY l.resource_id)
      SELECT ml.code, ml.name, ml.unit, round(ml.rate, 2)::text AS budget_rate,
        round(bd.amount / bd.qty, 2)::text AS billed_rate, bd.qty::text AS qty
      FROM proj.material_budget mb
      JOIN proj.material_budget_line ml ON ml.budget_id = mb.id
      JOIN billed bd ON bd.resource_id = ml.resource_id
      WHERE mb.project_id = ${projectId} AND mb.status = 'approved' AND round(bd.amount / bd.qty, 2) > ml.rate
      ORDER BY ml.code`;

    const unallocated = {
      orderLines: w.orderCharges.filter((o) => o.how === 'unallocated' && o.committed !== 0n)
        .length,
      ledgerLines: w.ledgerCharges.filter((l) => l.how === 'unallocated').length,
    };
    const usedSources = new Set<Source>([
      ...w.orderCharges.map((o) => o.source),
      ...w.ledgerCharges.map((l) => l.source).filter((s): s is Source => s !== null),
    ]);
    const months = (
      await db<{ m: string }[]>`
        SELECT to_char(month, 'YYYY-MM') AS m FROM ctl.snapshot WHERE project_id = ${projectId} ORDER BY month DESC`
    ).map((x) => x.m);
    let compared = null;
    if (compare) {
      const [s] = await db<
        { rows: Record<string, Record<string, string>>; totals: Record<string, string> }[]
      >`
        SELECT rows, totals FROM ctl.snapshot WHERE project_id = ${projectId} AND month = ${`${compare}-01`}`;
      if (!s)
        throw new NotFoundException({ code: 'not_found', message: `${compare} was not closed.` });
      compared = { month: compare, rows: s.rows, totals: s.totals };
    }
    return {
      baseline: w.baseline ? { takenOn: w.baseline.taken_at } : null,
      rows,
      byCostCode: byCode,
      byWbs: tree(wbs, 'wbs'),
      totals: CostControlService.str(totals),
      alerts: {
        overBudget,
        rates: rates.map((r) => ({
          resource: `${r.code} ${r.name}`,
          unit: r.unit,
          budgetRate: r.budget_rate,
          billedRate: r.billed_rate,
          qty: r.qty,
        })),
      },
      unallocated,
      defaults: SOURCES.map((s) => ({
        source: s,
        label: SOURCE_LABELS[s],
        costCode: ref(codeById, w.defaults.get(s) ?? null),
        used: usedSources.has(s),
      })),
      months,
      compared,
      mayForecast: await this.permissions.can(claims, 'cost.forecast'),
    };
  }

  /** The order lines and ledger lines behind one row (or, with `unallocated`, everything not placed). */
  async documents(
    claims: TenantClaims,
    projectId: string,
    q: { key?: string; unallocated?: boolean },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const w = await this.work(db, projectId);
    const pick = (x: { wbsId: string | null; costCodeId: string | null; how: How }) =>
      q.unallocated ? x.how === 'unallocated' : rowKey(x.wbsId, x.costCodeId) === q.key;
    return {
      orderLines: w.orderCharges
        .filter((o) => pick(o) && (o.committed !== 0n || !q.unallocated))
        .map((o) => ({
          poId: o.poId,
          number: o.number,
          party: o.party,
          lineKey: o.lineKey,
          description: o.description,
          amount: o.amount,
          billed: o.billed,
          committed: fromCents(o.committed),
          how: o.how,
          source: o.source,
        })),
      ledgerLines: w.ledgerCharges.filter(pick).map((l) => ({
        voucherId: l.voucherId,
        position: l.position,
        number: l.number,
        date: l.date,
        account: l.account,
        note: l.note,
        billNo: l.billNo,
        amount: l.amount,
        how: l.how,
        source: l.source,
        viaOrder: l.poId !== null && l.lineKey !== null,
      })),
    };
  }

  private async checkPlace(
    db: Db,
    projectId: string,
    wbsId: string | null,
    costCodeId: string | null,
  ) {
    if (!wbsId && !costCodeId)
      throw new BadRequestException({
        code: 'nothing_chosen',
        message: 'Choose a WBS element, a cost code or both.',
      });
    if (wbsId) {
      const [x] =
        await db`SELECT 1 FROM proj.wbs WHERE id = ${wbsId} AND project_id = ${projectId}`;
      if (!x)
        throw new BadRequestException({
          code: 'not_this_project',
          message: "The WBS element is not this project's.",
        });
    }
    if (costCodeId) {
      const [x] = await db`SELECT 1 FROM platform.cost_code WHERE id = ${costCodeId} AND active`;
      if (!x)
        throw new BadRequestException({
          code: 'not_a_cost_code',
          message: 'Choose an active cost code.',
        });
    }
  }

  async allocate(
    claims: TenantClaims,
    projectId: string,
    input: {
      target: { poId: string; lineKey: string } | { voucherId: string; position: number };
      wbsId: string | null;
      costCodeId: string | null;
      note: string;
    },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.forecaster(db, claims, projectId);
    await this.checkPlace(db, projectId, input.wbsId, input.costCodeId);
    await db.begin(async (tx) => {
      const t = input.target;
      if ('poId' in t) {
        const [x] = await tx`
          SELECT 1 FROM proc.purchase_order o JOIN proc.po_revision v ON v.po_id = o.id AND v.status = 'approved'
          JOIN proc.po_line l ON l.revision_id = v.id
          WHERE o.id = ${t.poId} AND o.project_id = ${projectId} AND l.line_key = ${t.lineKey}`;
        if (!x)
          throw new NotFoundException({
            code: 'not_found',
            message: 'No such line on an approved order of this project.',
          });
        await tx`
          INSERT INTO ctl.allocation (project_id, po_id, line_key, wbs_id, cost_code_id, note, updated_by)
          VALUES (${projectId}, ${t.poId}, ${t.lineKey}, ${input.wbsId}, ${input.costCodeId}, ${input.note}, ${claims.sub})
          ON CONFLICT (po_id, line_key) WHERE po_id IS NOT NULL DO UPDATE SET wbs_id = EXCLUDED.wbs_id,
            cost_code_id = EXCLUDED.cost_code_id, note = EXCLUDED.note, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      } else {
        const [x] = await tx`
          SELECT 1 FROM acc.voucher_line l JOIN acc.account a ON a.id = l.account_id AND a.nature = 'expense'
          WHERE l.voucher_id = ${t.voucherId} AND l.position = ${t.position} AND l.project_id = ${projectId}`;
        if (!x)
          throw new NotFoundException({
            code: 'not_found',
            message: "No such cost line on this project's books.",
          });
        await tx`
          INSERT INTO ctl.allocation (project_id, voucher_id, position, wbs_id, cost_code_id, note, updated_by)
          VALUES (${projectId}, ${t.voucherId}, ${t.position}, ${input.wbsId}, ${input.costCodeId}, ${input.note}, ${claims.sub})
          ON CONFLICT (voucher_id, position) WHERE voucher_id IS NOT NULL DO UPDATE SET wbs_id = EXCLUDED.wbs_id,
            cost_code_id = EXCLUDED.cost_code_id, note = EXCLUDED.note, updated_at = now(), updated_by = EXCLUDED.updated_by`;
      }
      await audit(tx, claims.sub, 'cost.allocate', 'project', projectId, {
        ...t,
        wbsId: input.wbsId,
        costCodeId: input.costCodeId,
      });
    });
    return this.report(claims, projectId);
  }

  async setDefault(claims: TenantClaims, source: Source, costCodeId: string | null) {
    if (!(await this.permissions.can(claims, 'cost.forecast')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'cost.forecast',
        message: 'This needs the cost forecasting permission.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      if (costCodeId === null) await tx`DELETE FROM ctl.default_charge WHERE source = ${source}`;
      else {
        const [x] = await tx`SELECT 1 FROM platform.cost_code WHERE id = ${costCodeId} AND active`;
        if (!x)
          throw new BadRequestException({
            code: 'not_a_cost_code',
            message: 'Choose an active cost code.',
          });
        await tx`
          INSERT INTO ctl.default_charge (source, cost_code_id, updated_by) VALUES (${source}, ${costCodeId}, ${claims.sub})
          ON CONFLICT (source) DO UPDATE SET cost_code_id = EXCLUDED.cost_code_id, updated_at = now(),
            updated_by = EXCLUDED.updated_by`;
      }
      await audit(tx, claims.sub, 'cost.default', 'cost_code', costCodeId ?? source, { source });
    });
    return { source, costCodeId };
  }

  /** Cost to complete entered for a row; null clears it (the computed figure applies again). */
  async setCtc(
    claims: TenantClaims,
    projectId: string,
    key: string,
    amount: string | null,
    note: string,
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.forecaster(db, claims, projectId);
    const { wbsId, costCodeId } = splitKey(key);
    if (wbsId || costCodeId) {
      if (wbsId) {
        const [x] =
          await db`SELECT 1 FROM proj.wbs WHERE id = ${wbsId} AND project_id = ${projectId}`;
        if (!x)
          throw new BadRequestException({
            code: 'not_this_project',
            message: "The WBS element is not this project's.",
          });
      }
      if (costCodeId) {
        const [x] = await db`SELECT 1 FROM platform.cost_code WHERE id = ${costCodeId}`;
        if (!x)
          throw new BadRequestException({ code: 'not_a_cost_code', message: 'No such cost code.' });
      }
    }
    await db.begin(async (tx) => {
      if (amount === null)
        await tx`DELETE FROM ctl.ctc WHERE project_id = ${projectId} AND row_key = ${key}`;
      else
        await tx`
          INSERT INTO ctl.ctc (project_id, row_key, amount, note, updated_by)
          VALUES (${projectId}, ${key}, ${amount}, ${note}, ${claims.sub})
          ON CONFLICT (project_id, row_key) DO UPDATE SET amount = EXCLUDED.amount, note = EXCLUDED.note,
            updated_at = now(), updated_by = EXCLUDED.updated_by`;
      await audit(tx, claims.sub, 'cost.ctc', 'project', projectId, { key, amount });
    });
    return this.report(claims, projectId);
  }

  private async takeBaseline(tx: TransactionSql, claims: TenantClaims, projectId: string) {
    const budget = await tx<
      { wbs_id: string | null; cost_code_id: string | null; amount: string }[]
    >`
      SELECT m.wbs_id, m.cost_code_id, coalesce(sum(n.amount), 0)::text AS amount
      FROM est.boq b
      JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
      LEFT JOIN proj.boq_line_map m ON m.project_id = b.project_id AND m.line_key = n.line_key
      WHERE b.project_id = ${projectId} AND b.kind = 'budget' AND b.archived_at IS NULL
      GROUP BY m.wbs_id, m.cost_code_id`;
    const rows = Object.fromEntries(
      budget.map((b) => [rowKey(b.wbs_id, b.cost_code_id), b.amount]),
    );
    const total = fromCents(budget.reduce((s, b) => s + cents(b.amount), 0n));
    await tx`INSERT INTO ctl.baseline (project_id, rows, total, taken_by)
      VALUES (${projectId}, ${tx.json(rows)}, ${total}, ${claims.sub})`;
    await audit(tx, claims.sub, 'cost.baseline', 'project', projectId, { total });
  }

  /** The original budget: the budget as it stands now, taken once. */
  async baseline(claims: TenantClaims, projectId: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.forecaster(db, claims, projectId);
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      const [b] = await tx`SELECT 1 FROM ctl.baseline WHERE project_id = ${projectId}`;
      if (b)
        throw new ConflictException({
          code: 'baselined',
          message: 'The original budget was already taken.',
        });
      await this.takeBaseline(tx, claims, projectId);
    });
    return this.report(claims, projectId);
  }

  /** A month closed: every row stored as it stands (the original budget taken first if it was not). */
  async closeMonth(claims: TenantClaims, projectId: string, month: string) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.forecaster(db, claims, projectId);
    const first = `${month}-01`;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    if (first > monthOf(today))
      throw new BadRequestException({
        code: 'future_month',
        message: 'A month is closed once it has begun.',
      });
    await db.begin(async (tx) => {
      await tx`SELECT 1 FROM proj.project WHERE id = ${projectId} FOR UPDATE`;
      const [s] =
        await tx`SELECT 1 FROM ctl.snapshot WHERE project_id = ${projectId} AND month = ${first}`;
      if (s)
        throw new ConflictException({
          code: 'month_closed',
          message: `${month} is already closed.`,
        });
      const [b] = await tx`SELECT 1 FROM ctl.baseline WHERE project_id = ${projectId}`;
      if (!b) await this.takeBaseline(tx, claims, projectId);
      const w = await this.work(tx, projectId);
      const totals = zero();
      const rows: Record<string, Record<string, string>> = {};
      for (const r of w.worked) {
        const s2: Partial<Sums> = Object.fromEntries(FIELDS.map((k) => [k, r[k]]));
        addInto(totals, s2);
        rows[r.key] = CostControlService.str(s2);
      }
      await tx`INSERT INTO ctl.snapshot (project_id, month, rows, totals, taken_by)
        VALUES (${projectId}, ${first}, ${tx.json(rows)}, ${tx.json(CostControlService.str(totals))}, ${claims.sub})`;
      await audit(tx, claims.sub, 'cost.close_month', 'project', projectId, { month });
    });
    return this.report(claims, projectId, month);
  }
}
