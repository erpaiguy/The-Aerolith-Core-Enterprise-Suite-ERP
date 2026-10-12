// Cash flow (docs/wave4-plan.md step 2): a project's and the company's money in and out, actual back and forecast
// ahead, by month or week. Nothing recorded when money is expected, so each project's cash terms (or the defaults)
// move every date: a bill certified and paid so many days after it is raised, suppliers paid so many days after
// delivery, cost not yet ordered paid so many days after the work.
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Sql, TransactionSql } from 'postgres';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { cents, fromCents } from '../project/money.js';
import { ProjectService } from '../project/project.service.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';
import { audit } from '../tender/tender-records.js';
import {
  addDays,
  addMonths,
  billCash,
  gstPayments,
  monthEnd,
  monthStart,
  periods,
  placeActual,
  placeForecast,
  spreadBy,
  spreadEven,
  type By,
  type Flow,
  type Period,
} from './cash-rules.js';
import { CostControlService } from './cost-control.service.js';

type Db = Sql | TransactionSql;

export interface CashTerms {
  certifyDays: number;
  clientPayDays: number;
  clientTdsPct: string;
  supplierDays: number;
  costDays: number;
}
export const DEFAULT_TERMS: CashTerms = {
  certifyDays: 30,
  clientPayDays: 30,
  clientTdsPct: '2.00',
  supplierDays: 30,
  costDays: 30,
};
export const KINDS: Record<string, { direction: 'in' | 'out'; label: string; actual: boolean }> = {
  received: { direction: 'in', label: 'Received from clients', actual: true },
  certified: { direction: 'in', label: 'Certified bills due', actual: false },
  submitted: { direction: 'in', label: 'Bills awaiting certification', actual: false },
  unbilled: { direction: 'in', label: 'Work done, not billed', actual: false },
  work: { direction: 'in', label: 'Work to come', actual: false },
  bank_in: { direction: 'in', label: 'Into bank and cash', actual: true },
  paid: { direction: 'out', label: 'Paid to suppliers', actual: true },
  payroll: { direction: 'out', label: 'Salaries paid', actual: true },
  wages: { direction: 'out', label: 'Contract wages paid', actual: true },
  other_paid: { direction: 'out', label: 'Other payments', actual: true },
  bank_out: { direction: 'out', label: 'Out of bank and cash', actual: true },
  bills: { direction: 'out', label: 'Supplier bills due', actual: false },
  orders: { direction: 'out', label: 'Open orders', actual: false },
  uncommitted: { direction: 'out', label: 'Cost not yet ordered', actual: false },
  overheads: { direction: 'out', label: 'Company overheads', actual: false },
  gst: { direction: 'out', label: 'GST to the government', actual: false },
};

const asFlow = (
  kind: string,
  date: string,
  amount: bigint,
  label: string,
  gst = 0n,
  gstMonth = date.slice(0, 7),
): Flow => ({ kind, date, amount, label, gst, gstMonth, direction: KINDS[kind]!.direction });

@Injectable()
export class CashFlowService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly projects: ProjectService,
    private readonly cost: CostControlService,
  ) {}

  private async terms(
    db: Db,
    projectId: string,
  ): Promise<CashTerms & { set: boolean; rowVersion: number | null }> {
    const [t] = await db<(CashTerms & { rowVersion: number })[]>`
      SELECT certify_days AS "certifyDays", client_pay_days AS "clientPayDays", client_tds_pct::text AS "clientTdsPct",
        supplier_days AS "supplierDays", cost_days AS "costDays", row_version AS "rowVersion"
      FROM ctl.cash_terms WHERE project_id = ${projectId}`;
    return t ? { ...t, set: true } : { ...DEFAULT_TERMS, set: false, rowVersion: null };
  }

  /** Every flow of one project: actual before `asOf`, forecast from it. */
  private async projectFlows(db: Db, projectId: string, asOf: string) {
    const t = await this.terms(db, projectId);
    const notes: string[] = [];
    const flows: Flow[] = [];
    const [bt] = await db<{ gst: string; retention: string; advance: string }[]>`
      SELECT gst_pct::text AS gst, retention_pct::text AS retention,
        CASE WHEN advance_amount > 0 THEN advance_recovery_pct ELSE 0 END::text AS advance
      FROM acc.bill_terms WHERE project_id = ${projectId}`;
    const billTerms = {
      gstPct: bt?.gst ?? '18',
      retentionPct: bt?.retention ?? '0',
      advancePct: bt?.advance ?? '0',
      tdsPct: t.clientTdsPct,
    };
    const lag = t.certifyDays + t.clientPayDays;

    // In: certified bills still owed, due their payment days after the invoice (GST owed in the invoice's month).
    const bills = await db<
      {
        ra: number;
        status: string;
        upto: string;
        invoice: string | null;
        net: string;
        gross: string;
        gst: string;
        owed: string;
      }[]
    >`
      SELECT b.ra_no AS ra, b.status, to_char(b.upto, 'YYYY-MM-DD') AS upto,
        to_char(b.invoice_date, 'YYYY-MM-DD') AS invoice,
        coalesce(b.certified ->> 'net', b.submitted ->> 'net', '0') AS net,
        coalesce(b.certified ->> 'gross', b.submitted ->> 'gross', '0') AS gross,
        (coalesce((coalesce(b.certified, b.submitted) ->> 'cgst')::numeric, 0)
          + coalesce((coalesce(b.certified, b.submitted) ->> 'sgst')::numeric, 0)
          + coalesce((coalesce(b.certified, b.submitted) ->> 'igst')::numeric, 0))::text AS gst,
        ((coalesce(b.certified ->> 'net', '0'))::numeric
          - coalesce((SELECT sum(a.amount) FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id
              WHERE a.bill_id = b.id AND a.kind = 'bill' AND r.status = 'posted' AND r.received_on < ${asOf}), 0)
          - coalesce((SELECT sum(n.total) FROM acc.credit_note n WHERE n.bill_id = b.id AND n.note_date < ${asOf}), 0))::text
          AS owed
      FROM acc.client_bill b
      WHERE b.project_id = ${projectId} AND b.status IN ('pending', 'submitted', 'certified')`;
    let billed = 0n;
    for (const b of bills) {
      billed += cents(b.gross);
      if (b.status === 'certified' && b.invoice) {
        if (cents(b.owed) > 0n)
          flows.push(
            asFlow(
              'certified',
              addDays(b.invoice, t.clientPayDays),
              cents(b.owed),
              `RA ${b.ra}`,
              cents(b.gst),
              b.invoice.slice(0, 7),
            ),
          );
      } else {
        const certified = addDays(b.upto, t.certifyDays);
        flows.push(
          asFlow(
            'submitted',
            addDays(certified, t.clientPayDays),
            cents(b.net),
            `RA ${b.ra}`,
            cents(b.gst),
            certified.slice(0, 7),
          ),
        );
      }
    }

    // In: work done and not billed (earned at contract rates less what bills claimed), billed at this month's end.
    const [w] = await db<{ contract: string; earned: string }[]>`
      WITH items AS (
        SELECT n.line_key, n.rate, n.amount FROM est.boq b
        JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item'
        WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL)
      SELECT coalesce((SELECT sum(amount) FROM items), 0)::text AS contract,
        coalesce((SELECT sum(round(m.qty * i.rate, 2)) FROM proj.measurement m JOIN items i ON i.line_key = m.line_key
          WHERE m.project_id = ${projectId} AND m.measured_on < ${asOf}), 0)::text AS earned`;
    const earned = cents(w!.earned);
    const billNow = (
      value: bigint,
      workMonth: string,
      kind: 'unbilled' | 'work',
      label: string,
    ) => {
      if (value <= 0n) return;
      const raised = monthEnd(workMonth);
      const c = billCash(value, billTerms);
      flows.push(
        asFlow(
          kind,
          addDays(raised, lag),
          c.amount,
          label,
          c.gst,
          addDays(raised, t.certifyDays).slice(0, 7),
        ),
      );
    };
    billNow(earned - billed, asOf, 'unbilled', 'Measured, not yet billed');

    // In: the work still to do, month by month: by the schedule's forecast dates where activities are linked to the
    // contract BOQ, else spread evenly to the planned finish.
    const months = Array.from({ length: 12 }, (_, i) => addMonths(asOf, i));
    const remaining = cents(w!.contract) - (earned > billed ? earned : billed);
    const weights = await this.scheduleWeights(db, projectId, asOf, months);
    let shares: bigint[] = [];
    if (weights.some((x) => x > 0n)) shares = spreadBy(remaining > 0n ? remaining : 0n, weights);
    else {
      const [p] = await db<{ finish: string | null }[]>`
        SELECT to_char(planned_finish_on, 'YYYY-MM-DD') AS finish FROM proj.project WHERE id = ${projectId}`;
      if (remaining > 0n) {
        if (p?.finish && p.finish >= asOf) {
          const n = months.filter((m) => m <= monthStart(p.finish!)).length || 1;
          shares = [...spreadEven(remaining, n), ...Array<bigint>(12 - n).fill(0n)];
          notes.push(
            'No schedule is linked to the contract BOQ: the work still to do is spread evenly to the planned finish.',
          );
        } else
          notes.push(
            'No schedule is linked to the contract BOQ and there is no planned finish ahead: the work still to do is not forecast.',
          );
      }
    }
    shares.forEach((v, i) => billNow(v, months[i]!, 'work', `Work in ${months[i]!.slice(0, 7)}`));

    // Out: supplier bills not fully paid, on their due dates (input GST in the bill's month). A bill's lines say
    // which projects it is for: each project takes its lines' share of what is owed.
    const vb = await db<
      { bill: string; party: string; due: string; date: string; gst: string; owed: string }[]
    >`
      WITH share AS (
        SELECT l.bill_id, sum(l.amount + l.gst) / nullif((SELECT sum(x.amount + x.gst) FROM acc.vendor_bill_line x
          WHERE x.bill_id = l.bill_id), 0) AS s
        FROM acc.vendor_bill_line l WHERE coalesce(l.project_id, (SELECT project_id FROM acc.vendor_bill WHERE id = l.bill_id)) = ${projectId}
        GROUP BY l.bill_id)
      SELECT b.bill_no AS bill, p.name AS party, to_char(b.due_date, 'YYYY-MM-DD') AS due,
        to_char(b.bill_date, 'YYYY-MM-DD') AS date, round((b.cgst + b.sgst + b.igst) * sh.s, 2)::text AS gst,
        round(sh.s * (b.payable
          - coalesce((SELECT sum(l.amount) FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id
              WHERE l.bill_id = b.id AND r.status = 'paid' AND r.paid_on < ${asOf}), 0)
          - coalesce((SELECT sum(a.amount) FROM acc.advance_application a WHERE a.bill_id = b.id AND a.applied_on < ${asOf}), 0)
          - coalesce((SELECT sum(d.total) FROM acc.debit_note d WHERE d.bill_id = b.id AND d.note_date < ${asOf}), 0)), 2)::text
          AS owed
      FROM share sh JOIN acc.vendor_bill b ON b.id = sh.bill_id JOIN platform.party p ON p.id = b.party_id
      WHERE b.status = 'posted' AND b.bill_date < ${asOf}`;
    for (const b of vb)
      if (cents(b.owed) > 0n)
        flows.push(
          asFlow(
            'bills',
            b.due,
            cents(b.owed),
            `${b.party} ${b.bill}`,
            cents(b.gst),
            b.date.slice(0, 7),
          ),
        );

    // Out: what is still open on orders, with its GST, paid the supplier days after delivery; then the cost to
    // complete not yet ordered, spread like the work and paid the cost days after it.
    const cost = await this.cost.work(db, projectId);
    for (const o of cost.orderCharges) {
      if (o.committed <= 0n) continue;
      const delivered = o.deliverBy && o.deliverBy > asOf ? o.deliverBy : asOf;
      const gst = (o.committed * BigInt(Math.round(Number(o.gstPct) * 100)) + 5_000n) / 10_000n;
      flows.push(
        asFlow(
          'orders',
          addDays(delivered, t.supplierDays),
          o.committed + gst,
          `${o.number} ${o.description}`,
          gst,
          delivered.slice(0, 7),
        ),
      );
    }
    const uncommitted = cost.worked.reduce(
      (a, r) => a + (r.ctc > r.committed ? r.ctc - r.committed : 0n),
      0n,
    );
    if (uncommitted > 0n) {
      const ws = shares.some((x) => x > 0n) ? shares : weights;
      const parts = ws.some((x) => x > 0n) ? spreadBy(uncommitted, ws) : spreadEven(uncommitted, 1);
      parts.forEach((v, i) => {
        if (v > 0n)
          flows.push(
            asFlow(
              'uncommitted',
              addDays(monthEnd(months[i]!), t.costDays),
              v,
              `Cost in ${months[i]!.slice(0, 7)}`,
            ),
          );
      });
    }

    // Actual: receipts (each project's share of the cash, its allocation less TDS and deductions in proportion).
    const rec = await db<{ date: string; amount: string; label: string }[]>`
      SELECT to_char(r.received_on, 'YYYY-MM-DD') AS date, p.name AS label,
        round(a.amount * r.amount / nullif((SELECT sum(x.amount) FROM acc.client_receipt_alloc x WHERE x.receipt_id = r.id), 0), 2)::text
          AS amount
      FROM acc.client_receipt_alloc a JOIN acc.client_receipt r ON r.id = a.receipt_id JOIN platform.party p ON p.id = r.party_id
      WHERE a.project_id = ${projectId} AND r.status = 'posted' AND r.received_on < ${asOf}`;
    for (const r of rec) flows.push(asFlow('received', r.date, cents(r.amount), r.label));
    const paid = await db<{ date: string; amount: string; label: string; kind: string }[]>`
      SELECT to_char(r.paid_on, 'YYYY-MM-DD') AS date,
        round(sum(l.amount * CASE WHEN l.kind = 'advance' THEN 1 ELSE coalesce((
          SELECT sum(x.amount + x.gst) FILTER (WHERE coalesce(x.project_id, b.project_id) = ${projectId})
            / nullif(sum(x.amount + x.gst), 0)
          FROM acc.vendor_bill_line x WHERE x.bill_id = l.bill_id), 0) END), 2)::text AS amount,
        p.name AS label, 'paid' AS kind
      FROM acc.payment_run_line l JOIN acc.payment_run r ON r.id = l.run_id JOIN platform.party p ON p.id = l.party_id
      LEFT JOIN acc.vendor_bill b ON b.id = l.bill_id
      WHERE r.status = 'paid' AND r.paid_on < ${asOf}
        AND (CASE WHEN l.kind = 'advance' THEN l.project_id = ${projectId} ELSE EXISTS (SELECT 1 FROM acc.vendor_bill_line x
          WHERE x.bill_id = l.bill_id AND coalesce(x.project_id, b.project_id) = ${projectId}) END)
      GROUP BY r.paid_on, p.name
      UNION ALL
      SELECT to_char(v.voucher_date, 'YYYY-MM-DD'), round(sum(
          rl.net * (s.e ->> 'days')::numeric / nullif((SELECT sum((x ->> 'days')::numeric) FROM jsonb_array_elements(rl.split) x), 0)
        ), 2)::text, 'Salaries ' || to_char(pr.month, 'Mon YYYY'), 'payroll'
      FROM pay.run pr JOIN acc.voucher v ON v.id = pr.payment_voucher_id
      JOIN pay.run_line rl ON rl.run_id = pr.id
      CROSS JOIN LATERAL jsonb_array_elements(rl.split) AS s(e)
      WHERE pr.status = 'paid' AND s.e ->> 'projectId' = ${projectId}::text AND v.voucher_date < ${asOf}
      GROUP BY v.voucher_date, pr.month
      UNION ALL
      SELECT to_char(ws.paid_on, 'YYYY-MM-DD'), sum(ws.total)::text, p.name, 'wages'
      FROM lab.wage_sheet ws JOIN proj.site st ON st.id = ws.site_id JOIN platform.party p ON p.id = ws.party_id
      WHERE st.project_id = ${projectId} AND ws.status = 'verified' AND ws.paid_on < ${asOf}
      GROUP BY ws.paid_on, p.name
      UNION ALL
      SELECT to_char(v.voucher_date, 'YYYY-MM-DD'), sum(l.debit - l.credit)::text, v.number, 'other_paid'
      FROM acc.voucher v JOIN acc.voucher_line l ON l.voucher_id = v.id
      WHERE v.type = 'payment' AND v.source_kind IS NULL AND l.project_id = ${projectId} AND v.voucher_date < ${asOf}
      GROUP BY v.voucher_date, v.number`;
    for (const x of paid)
      if (cents(x.amount) !== 0n) flows.push(asFlow(x.kind, x.date, cents(x.amount), x.label));
    return { flows, notes, terms: t };
  }

  /** Contract value of linked work the schedule puts in each month from `asOf` (calendar days, forecast dates). */
  private async scheduleWeights(db: Db, projectId: string, asOf: string, months: string[]) {
    const spans = await db<{ start: string; finish: string; value: string }[]>`
      WITH p AS (
        SELECT id FROM sched.plan WHERE project_id = ${projectId} AND kind = 'project_schedule' AND archived_at IS NULL),
      items AS (
        SELECT n.line_key, n.amount FROM est.boq b
        JOIN est.boq_node n ON n.boq_id = b.id AND n.node_type = 'item' AND n.amount IS NOT NULL
        WHERE b.project_id = ${projectId} AND b.kind = 'contract' AND b.archived_at IS NULL),
      links AS (
        SELECT al.plan_id, al.activity_id, al.line_key, count(*) OVER (PARTITION BY al.line_key) AS shared
        FROM sched.activity_line al JOIN p ON p.id = al.plan_id)
      SELECT to_char(a.early_start, 'YYYY-MM-DD') AS start, to_char(a.early_finish, 'YYYY-MM-DD') AS finish,
        sum(i.amount / l.shared)::text AS value
      FROM links l JOIN items i ON i.line_key = l.line_key
      JOIN sched.activity a ON a.plan_id = l.plan_id AND a.id = l.activity_id
      WHERE a.early_start IS NOT NULL AND a.early_finish IS NOT NULL
      GROUP BY 1, 2`;
    const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    return months.map((m, i) => {
      const from = i ? m : asOf;
      const to = monthEnd(m);
      let w = 0n;
      for (const s of spans) {
        const len = day(s.finish) - day(s.start) + 1;
        const a = Math.max(day(s.start), day(from));
        const b = Math.min(day(s.finish), day(to));
        if (b >= a && len > 0) w += (cents(s.value) * BigInt(b - a + 1)) / BigInt(len);
      }
      return w;
    });
  }

  /** Flows into rows by kind and period; totals, net and the running position. */
  private table(flows: Flow[], ps: Period[], opening: bigint | null) {
    const rows = new Map<string, Map<string, bigint>>();
    const detail: { date: string; kind: string; label: string; amount: string; period: string }[] =
      [];
    for (const f of flows) {
      const actual = KINDS[f.kind]!.actual;
      const p = actual ? placeActual(f.date, ps) : placeForecast(f.date, ps);
      if (actual && !p) continue; // before the periods shown: in the opening position
      const key = p?.key ?? 'later';
      const r = rows.get(f.kind) ?? new Map<string, bigint>();
      r.set(key, (r.get(key) ?? 0n) + f.amount);
      rows.set(f.kind, r);
      if (!actual)
        detail.push({
          date: f.date,
          kind: f.kind,
          label: f.label,
          amount: fromCents(f.amount),
          period: key,
        });
    }
    const keys = [...ps.map((p) => p.key), 'later'];
    const sum = (dir: 'in' | 'out', k: string) =>
      [...rows.entries()]
        .filter(([kind]) => KINDS[kind]!.direction === dir)
        .reduce((a, [, r]) => a + (r.get(k) ?? 0n), 0n);
    const str = (m: (k: string) => bigint) =>
      Object.fromEntries(keys.map((k) => [k, fromCents(m(k))]));
    let run = opening ?? 0n;
    const position: Record<string, string> = {};
    for (const k of keys) {
      run += sum('in', k) - sum('out', k);
      position[k] = fromCents(run);
    }
    return {
      lines: Object.keys(KINDS)
        .filter((k) => rows.has(k))
        .map((k) => ({
          kind: k,
          direction: KINDS[k]!.direction,
          label: KINDS[k]!.label,
          values: str((p) => rows.get(k)!.get(p) ?? 0n),
        })),
      totals: {
        in: str((k) => sum('in', k)),
        out: str((k) => sum('out', k)),
        net: str((k) => sum('in', k) - sum('out', k)),
      },
      position,
      detail: detail.sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  private static today() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  }

  async project(claims: TenantClaims, projectId: string, q: { asOf?: string; by: By }) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    const asOf = q.asOf ?? CashFlowService.today();
    const ps = periods(asOf, q.by);
    const { flows, notes, terms } = await this.projectFlows(db, projectId, asOf);
    const startActual = ps[0]!.from;
    // The position starts from the project's net cash before the first period shown.
    const before = flows.filter((f) => KINDS[f.kind]!.actual && f.date < startActual);
    const opening = before.reduce((a, f) => a + (f.direction === 'in' ? f.amount : -f.amount), 0n);
    return {
      asOf,
      by: q.by,
      periods: [
        ...ps,
        { key: 'later', label: 'Later', from: addDays(ps.at(-1)!.to, 1), to: '', actual: false },
      ],
      ...this.table(flows, ps, opening),
      opening: fromCents(opening),
      terms,
      notes,
      mayEdit: await this.permissions.can(claims, 'cost.forecast'),
    };
  }

  async company(claims: TenantClaims, q: { entityId: string; asOf?: string; by: By }) {
    if (!(await this.permissions.can(claims, 'accounts.view')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'accounts.view',
        message: "The company's cash flow needs the accounts permission.",
      });
    const db = await this.tenants.forTenant(claims.ten);
    const [e] = await db<{ id: string }[]>`SELECT id FROM platform.entity WHERE id = ${q.entityId}`;
    if (!e) throw new NotFoundException({ code: 'not_found', message: 'No such company.' });
    const asOf = q.asOf ?? CashFlowService.today();
    const ps = periods(asOf, q.by);
    const projects = await db<{ id: string; number: string; name: string }[]>`
      SELECT id, number, name FROM proj.project WHERE entity_id = ${q.entityId} AND actual_finish_on IS NULL ORDER BY number`;
    const flows: Flow[] = [];
    const byProject: {
      project: { id: string; number: string; name: string };
      in: string;
      out: string;
      net: string;
    }[] = [];
    const notes: string[] = [];
    for (const p of projects) {
      const pf = await this.projectFlows(db, p.id, asOf);
      const ahead = pf.flows.filter((f) => !KINDS[f.kind]!.actual);
      flows.push(...ahead);
      const i = ahead.filter((f) => f.direction === 'in').reduce((a, f) => a + f.amount, 0n);
      const o = ahead.filter((f) => f.direction === 'out').reduce((a, f) => a + f.amount, 0n);
      byProject.push({ project: p, in: fromCents(i), out: fromCents(o), net: fromCents(i - o) });
      for (const n of pf.notes) notes.push(`${p.number}: ${n}`);
    }
    const [set] = await db<{ overheads: string }[]>`
      SELECT overheads_monthly::text AS overheads FROM ctl.cash_settings WHERE entity_id = ${q.entityId}`;
    const overheads = cents(set?.overheads ?? '0');
    if (overheads > 0n)
      for (let i = 0; i < 12; i++) {
        const m = addMonths(asOf, i);
        flows.push(asFlow('overheads', i ? m : asOf, overheads, `Overheads ${m.slice(0, 7)}`));
      }
    flows.push(...gstPayments(flows, asOf));
    // Actual: the bank and cash ledgers, contras left out.
    const bank = await db<{ date: string; inflow: string; outflow: string }[]>`
      SELECT to_char(v.voucher_date, 'YYYY-MM-DD') AS date, sum(l.debit)::text AS inflow, sum(l.credit)::text AS outflow
      FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id JOIN acc.account a ON a.id = l.account_id
      WHERE v.entity_id = ${q.entityId} AND a.kind IN ('bank', 'cash') AND v.type <> 'contra'
        AND v.voucher_date >= ${ps[0]!.from} AND v.voucher_date < ${asOf}
      GROUP BY v.voucher_date`;
    for (const b of bank) {
      if (cents(b.inflow)) flows.push(asFlow('bank_in', b.date, cents(b.inflow), 'Bank and cash'));
      if (cents(b.outflow))
        flows.push(asFlow('bank_out', b.date, cents(b.outflow), 'Bank and cash'));
    }
    const [open] = await db<{ start: string; now: string }[]>`
      SELECT coalesce(sum(l.debit - l.credit) FILTER (WHERE v.voucher_date < ${ps[0]!.from}), 0)::text AS start,
        coalesce(sum(l.debit - l.credit), 0)::text AS now
      FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id JOIN acc.account a ON a.id = l.account_id
      WHERE v.entity_id = ${q.entityId} AND a.kind IN ('bank', 'cash') AND v.voucher_date < ${asOf}`;
    return {
      asOf,
      by: q.by,
      periods: [
        ...ps,
        { key: 'later', label: 'Later', from: addDays(ps.at(-1)!.to, 1), to: '', actual: false },
      ],
      ...this.table(flows, ps, cents(open!.start)),
      opening: fromCents(cents(open!.start)),
      cashNow: fromCents(cents(open!.now)),
      projects: byProject,
      overheadsMonthly: set?.overheads ?? '0.00',
      notes,
      mayEdit: await this.permissions.can(claims, 'cost.forecast'),
    };
  }

  async setTerms(
    claims: TenantClaims,
    projectId: string,
    input: CashTerms & { rowVersion: number | null },
  ) {
    const db = await this.tenants.forTenant(claims.ten);
    await this.projects.access(db, claims, projectId);
    if (!(await this.permissions.can(claims, 'cost.forecast')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'cost.forecast',
        message: 'This needs the cost forecasting permission.',
      });
    await db.begin(async (tx) => {
      const r =
        input.rowVersion === null
          ? await tx`
              INSERT INTO ctl.cash_terms (project_id, certify_days, client_pay_days, client_tds_pct, supplier_days, cost_days, updated_by)
              VALUES (${projectId}, ${input.certifyDays}, ${input.clientPayDays}, ${input.clientTdsPct}, ${input.supplierDays},
                ${input.costDays}, ${claims.sub})
              ON CONFLICT (project_id) DO NOTHING RETURNING 1`
          : await tx`
              UPDATE ctl.cash_terms SET certify_days = ${input.certifyDays}, client_pay_days = ${input.clientPayDays},
                client_tds_pct = ${input.clientTdsPct}, supplier_days = ${input.supplierDays}, cost_days = ${input.costDays},
                updated_at = now(), updated_by = ${claims.sub}, row_version = row_version + 1
              WHERE project_id = ${projectId} AND row_version = ${input.rowVersion} RETURNING 1`;
      if (!r.length)
        throw new ConflictException({
          code: 'stale',
          message: 'Someone else changed the terms; reload and try again.',
        });
      await audit(tx, claims.sub, 'cash.terms', 'project', projectId, { ...input });
    });
    return this.terms(db, projectId);
  }

  async setOverheads(claims: TenantClaims, entityId: string, amount: string) {
    if (!(await this.permissions.can(claims, 'cost.forecast')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'cost.forecast',
        message: 'This needs the cost forecasting permission.',
      });
    const db = await this.tenants.forTenant(claims.ten);
    await db.begin(async (tx) => {
      await tx`
        INSERT INTO ctl.cash_settings (entity_id, overheads_monthly, updated_by) VALUES (${entityId}, ${amount}, ${claims.sub})
        ON CONFLICT (entity_id) DO UPDATE SET overheads_monthly = EXCLUDED.overheads_monthly, updated_at = now(),
          updated_by = EXCLUDED.updated_by`;
      await audit(tx, claims.sub, 'cash.overheads', 'entity', entityId, { amount });
    });
    return { entityId, overheadsMonthly: amount };
  }
}
