// Company dashboard (docs/wave7-plan.md step 7d.9): one company at a glance, from the books and the registers. The
// order book (each running project's contract value less the revenue booked on it); revenue this financial year by
// month against plan (each project's contract value spread evenly over its start to planned finish); margin by
// project (revenue less cost booked to it); cash and bank in hand and the guarantees out; receivables over 90 days;
// tenders due in the next fortnight; and safety incidents in the last 90 days.
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantClaims } from '../auth/auth.service.js';
import { PermissionsService } from '../auth/permissions.js';
import { ReceivableService } from '../accounts/receivable.service.js';
import { fyOf } from '../accounts/accounts-rules.js';
import { TenantConnections } from '../provisioning/tenant-connections.js';

const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const n = (v: string | number | null | undefined) => Number(v ?? 0);
const r2 = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
const months = (from: string, to: string) => {
  const out: string[] = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  for (let i = 0; i < 24; i++) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    if (k > to.slice(0, 7)) break;
    out.push(k);
    m += 1;
    if (m > 12) [y, m] = [y + 1, 1];
  }
  return out;
};
/** The days of a span that fall in a month. */
const overlap = (from: string, to: string, month: string) => {
  const ms = Date.parse(`${month}-01T00:00:00Z`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const me = Date.UTC(y, m, 1) - 86_400_000;
  const a = Math.max(ms, Date.parse(`${from}T00:00:00Z`));
  const b = Math.min(me, Date.parse(`${to}T00:00:00Z`));
  return b < a ? 0 : (b - a) / 86_400_000 + 1;
};

@Injectable()
export class CompanyDashboardService {
  constructor(
    private readonly tenants: TenantConnections,
    private readonly permissions: PermissionsService,
    private readonly receivables: ReceivableService,
  ) {}

  async get(claims: TenantClaims, entityId: string, asOf = indiaToday()) {
    if (!(await this.permissions.can(claims, 'accounts.view')))
      throw new ForbiddenException({
        code: 'forbidden',
        permission: 'accounts.view',
        message: "The company's dashboard needs the accounts permission.",
      });
    const db = await this.tenants.forTenant(claims.ten);
    const [entity] = await db<
      { name: string }[]
    >`SELECT name FROM platform.entity WHERE id = ${entityId}`;
    if (!entity) throw new NotFoundException({ code: 'not_found', message: 'No such company.' });
    const fy = fyOf(asOf);

    // Revenue (income ledgers) and cost (expense ledgers) booked to each project, to date and this year.
    const projects = await db<
      {
        id: string;
        number: string;
        name: string;
        status: string;
        contractValue: string | null;
        startOn: string | null;
        finishOn: string | null;
        revenue: string;
        cost: string;
      }[]
    >`
      SELECT p.id, p.number, p.name, p.status, p.contract_value::text AS "contractValue",
        to_char(p.start_on, 'YYYY-MM-DD') AS "startOn", to_char(p.planned_finish_on, 'YYYY-MM-DD') AS "finishOn",
        coalesce(sum(l.credit - l.debit) FILTER (WHERE a.nature = 'income'), 0)::text AS revenue,
        coalesce(sum(l.debit - l.credit) FILTER (WHERE a.nature = 'expense'), 0)::text AS cost
      FROM proj.project p
      LEFT JOIN acc.voucher_line l ON l.project_id = p.id
        AND EXISTS (SELECT 1 FROM acc.voucher v WHERE v.id = l.voucher_id AND v.voucher_date <= ${asOf})
      LEFT JOIN acc.account a ON a.id = l.account_id
      WHERE p.entity_id = ${entityId} AND p.status <> 'cancelled'
      GROUP BY p.id ORDER BY p.number`;
    const running = projects.filter((p) => ['planned', 'active', 'on_hold'].includes(p.status));
    const orderBook = running
      .filter((p) => n(p.contractValue) > 0)
      .map((p) => ({
        project: { id: p.id, number: p.number, name: p.name },
        contractValue: r2(n(p.contractValue)),
        revenue: r2(n(p.revenue)),
        toDo: r2(Math.max(n(p.contractValue) - n(p.revenue), 0)),
      }));

    // This year's revenue by month, against the plan.
    const ms = months(fy.from, fy.to);
    const actual = await db<{ month: string; revenue: string }[]>`
      SELECT to_char(v.voucher_date, 'YYYY-MM') AS month, sum(l.credit - l.debit)::text AS revenue
      FROM acc.voucher_line l JOIN acc.voucher v ON v.id = l.voucher_id JOIN acc.account a ON a.id = l.account_id
      WHERE v.entity_id = ${entityId} AND a.nature = 'income' AND v.voucher_date BETWEEN ${fy.from} AND ${asOf}
      GROUP BY 1`;
    const byMonth = new Map(actual.map((a) => [a.month, n(a.revenue)]));
    const revenue = ms.map((m) => {
      let plan = 0;
      for (const p of projects)
        if (n(p.contractValue) > 0 && p.startOn && p.finishOn) {
          const days =
            (Date.parse(`${p.finishOn}T00:00:00Z`) - Date.parse(`${p.startOn}T00:00:00Z`)) /
              86_400_000 +
            1;
          plan += (n(p.contractValue) * overlap(p.startOn, p.finishOn, m)) / days;
        }
      return {
        month: m,
        plan: r2(plan),
        actual: m <= asOf.slice(0, 7) ? r2(byMonth.get(m) ?? 0) : null,
      };
    });

    const margin = projects
      .filter((p) => n(p.revenue) !== 0 || n(p.cost) !== 0)
      .map((p) => ({
        project: { id: p.id, number: p.number, name: p.name },
        revenue: r2(n(p.revenue)),
        cost: r2(n(p.cost)),
        margin: r2(n(p.revenue) - n(p.cost)),
        marginPct: n(p.revenue) ? r2(((n(p.revenue) - n(p.cost)) / n(p.revenue)) * 100) : null,
      }))
      .sort((a, b) => n(a.marginPct ?? -1e9) - n(b.marginPct ?? -1e9));

    const cash = await db<{ id: string; name: string; kind: string; balance: string }[]>`
      SELECT a.id, a.name, a.kind, coalesce(sum(l.debit - l.credit), 0)::text AS balance
      FROM acc.account a
      LEFT JOIN acc.voucher_line l ON l.account_id = a.id
        AND EXISTS (SELECT 1 FROM acc.voucher v WHERE v.id = l.voucher_id AND v.entity_id = ${entityId}
          AND v.voucher_date <= ${asOf})
      WHERE a.kind IN ('bank', 'cash') AND NOT a.is_group AND a.closed_at IS NULL
      GROUP BY a.id ORDER BY a.code`;
    const [guarantees] = await db<{ tender: string; contract: string }[]>`
      SELECT
        (SELECT coalesce(sum(s.amount), 0) FROM tender.security_instrument s JOIN tender.tender t ON t.id = s.tender_id
          WHERE t.entity_id = ${entityId} AND s.form = 'bank_guarantee' AND s.status IN ('issued', 'submitted'))::text
          AS tender,
        (SELECT coalesce(sum(s.amount), 0) FROM ctl.security s JOIN ctl.contract c ON c.id = s.contract_id
          JOIN proj.project p ON p.id = c.project_id
          WHERE p.entity_id = ${entityId} AND s.status = 'held')::text AS contract`;

    const rec = await this.receivables.receivables(claims, { entityId, asOf });
    const over90 = rec.clients
      .filter((c) => n(c.buckets[3]) > 0)
      .map((c) => ({ party: c.party, amount: c.buckets[3]!, outstanding: c.outstanding }))
      .sort((a, b) => n(b.amount) - n(a.amount));

    const tenders = await db`
      SELECT t.id, t.number, t.title, t.estimated_value::text AS value, t.status,
        to_char(t.submission_due_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS "dueAt"
      FROM tender.tender t
      WHERE t.entity_id = ${entityId} AND t.status IN ('lead', 'evaluating', 'bidding')
        AND t.submission_due_at >= ${asOf}::date AND t.submission_due_at < ${asOf}::date + 15
      ORDER BY t.submission_due_at`;

    const incidents = await db<{ kind: string; count: number; open: number; daysLost: number }[]>`
      SELECT i.kind, count(*)::int AS count, count(*) FILTER (WHERE i.status <> 'closed')::int AS open,
        coalesce(sum(i.days_lost), 0)::int AS "daysLost"
      FROM hse.incident i JOIN proj.project p ON p.id = i.project_id
      WHERE p.entity_id = ${entityId}
        AND (i.occurred_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${asOf}::date - 90 AND ${asOf}::date
      GROUP BY i.kind ORDER BY i.kind`;

    const sum = (xs: { [k: string]: unknown }[], k: string) =>
      r2(xs.reduce((t, x) => t + n(x[k] as string), 0));
    return {
      company: entity.name,
      asOf,
      fy: fy.label,
      orderBook: { projects: orderBook, total: sum(orderBook, 'toDo') },
      revenue: {
        months: revenue,
        plan: sum(
          revenue.filter((m) => m.actual !== null),
          'plan',
        ),
        actual: sum(revenue, 'actual'),
      },
      margin,
      cash: {
        ledgers: cash.map((c) => ({ ...c, balance: r2(n(c.balance)) })),
        total: sum(cash, 'balance'),
        guarantees: r2(n(guarantees!.tender) + n(guarantees!.contract)),
      },
      receivablesOver90: { clients: over90, total: rec.totals.buckets[3]! },
      tendersDue: tenders,
      incidents: {
        kinds: incidents,
        total: incidents.reduce((t, i) => t + i.count, 0),
        open: incidents.reduce((t, i) => t + i.open, 0),
        daysLost: incidents.reduce((t, i) => t + i.daysLost, 0),
      },
    };
  }
}
