// Company dashboard (docs/wave7-plan.md step 7d.9): one company at a glance: order book, revenue this year against
// plan, margin by project, cash and guarantees, receivables over 90 days, tenders due and safety incidents.
import { Alert, Badge, Card, Input, PageHeader, Spinner, Table } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { useCompany } from '../accounts/model';
import { EChart, type ChartOption } from '../charts/EChart';
import { describeError, formatInr } from '../lib/format';
import { CompanyPicker } from './accounts/Vouchers';

interface Ref {
  id: string;
  number: string;
  name: string;
}
interface Dashboard {
  company: string;
  asOf: string;
  fy: string;
  orderBook: {
    projects: { project: Ref; contractValue: string; revenue: string; toDo: string }[];
    total: string;
  };
  revenue: {
    months: { month: string; plan: string; actual: string | null }[];
    plan: string;
    actual: string;
  };
  margin: {
    project: Ref;
    revenue: string;
    cost: string;
    margin: string;
    marginPct: string | null;
  }[];
  cash: {
    ledgers: { id: string; name: string; kind: string; balance: string }[];
    total: string;
    guarantees: string;
  };
  receivablesOver90: {
    clients: { party: { id: string; name: string }; amount: string; outstanding: string }[];
    total: string;
  };
  tendersDue: {
    id: string;
    number: string;
    title: string;
    value: string | null;
    status: string;
    dueAt: string;
  }[];
  incidents: {
    kinds: { kind: string; count: number; open: number; daysLost: number }[];
    total: number;
    open: number;
    daysLost: number;
  };
}

const lakh = (v: string) => Math.round(Number(v) / 1000) / 100;
const right = 'text-right';

export function CompanyDashboardScreen() {
  const { company, choose } = useCompany();
  const [asOf, setAsOf] = useState('');
  const q = useQuery({
    queryKey: ['company-dashboard', company?.id, asOf],
    queryFn: () =>
      api.request<Dashboard>(
        `/api/tenant/company-dashboard?entityId=${company!.id}${asOf ? `&asOf=${asOf}` : ''}`,
      ),
    enabled: !!company,
  });
  const option = useMemo<ChartOption | null>(() => {
    if (!q.data) return null;
    const m = q.data.revenue.months;
    return {
      tooltip: { trigger: 'axis' },
      legend: { data: ['Plan', 'Booked'] },
      grid: { left: 48, right: 16, top: 32, bottom: 24 },
      xAxis: { type: 'category', data: m.map((x) => x.month.slice(5)) },
      yAxis: { type: 'value', name: '₹ lakh' },
      series: [
        { name: 'Plan', type: 'line', data: m.map((x) => lakh(x.plan)) },
        {
          name: 'Booked',
          type: 'bar',
          data: m.map((x) => (x.actual === null ? null : lakh(x.actual))),
        },
      ],
    } as ChartOption;
  }, [q.data]);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Company dashboard"
        subtitle={q.data ? `${q.data.company} · FY ${q.data.fy}` : undefined}
        actions={
          <div className="flex flex-wrap gap-2">
            {company ? <CompanyPicker value={company.id} onChange={choose} /> : null}
            <Input
              type="date"
              aria-label="As of"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </div>
        }
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" aria-label="Headline figures">
            {[
              ['Order book', formatInr(q.data.orderBook.total)],
              ['Revenue this year', formatInr(q.data.revenue.actual)],
              ['Plan to date', formatInr(q.data.revenue.plan)],
              ['Cash and bank', formatInr(q.data.cash.total)],
              ['Receivables over 90 days', formatInr(q.data.receivablesOver90.total)],
              ['Incidents, 90 days', String(q.data.incidents.total)],
            ].map(([k, v]) => (
              <div key={k} className="rounded border border-line p-3">
                <dt className="text-xs text-fg-muted">{k}</dt>
                <dd className="text-lg font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card title={`Revenue against plan, FY ${q.data.fy}`}>
              {option ? (
                <EChart option={option} label="Revenue booked by month against plan" />
              ) : null}
              <p className="mt-1 text-xs text-fg-muted">
                Plan: each project's contract value spread evenly from its start to its planned
                finish.
              </p>
            </Card>
            <Card title="Order book">
              {q.data.orderBook.projects.length === 0 ? (
                <p className="text-sm text-fg-muted">No running project with a contract value.</p>
              ) : (
                <Table minWidth="30rem">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th className={right}>Contract</th>
                      <th className={right}>Booked</th>
                      <th className={right}>To do</th>
                    </tr>
                  </thead>
                  <tbody aria-label="Order book">
                    {q.data.orderBook.projects.map((p) => (
                      <tr key={p.project.id}>
                        <td>
                          <ProjectLink p={p.project} />
                        </td>
                        <td className={right}>{formatInr(p.contractValue)}</td>
                        <td className={right}>{formatInr(p.revenue)}</td>
                        <td className={right}>{formatInr(p.toDo)}</td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card title="Margin by project">
              {q.data.margin.length === 0 ? (
                <p className="text-sm text-fg-muted">Nothing booked to a project yet.</p>
              ) : (
                <Table minWidth="30rem">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th className={right}>Revenue</th>
                      <th className={right}>Cost</th>
                      <th className={right}>Margin</th>
                    </tr>
                  </thead>
                  <tbody aria-label="Margin by project">
                    {q.data.margin.map((m) => (
                      <tr key={m.project.id}>
                        <td>
                          <ProjectLink p={m.project} />
                        </td>
                        <td className={right}>{formatInr(m.revenue)}</td>
                        <td className={right}>{formatInr(m.cost)}</td>
                        <td
                          className={`${right} ${Number(m.margin) < 0 ? 'font-medium text-danger' : ''}`}
                        >
                          {formatInr(m.margin)}
                          {m.marginPct !== null ? ` (${Number(m.marginPct)}%)` : ''}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Card>
            <Card title="Cash and credit">
              <ul className="divide-y divide-line text-sm" aria-label="Cash and bank">
                {q.data.cash.ledgers.map((l) => (
                  <li key={l.id} className="flex justify-between py-1">
                    <span>{l.name}</span>
                    <span className={Number(l.balance) < 0 ? 'text-danger' : ''}>
                      {formatInr(l.balance)}
                    </span>
                  </li>
                ))}
                <li className="flex justify-between py-1 font-semibold">
                  <span>In hand</span>
                  <span>{formatInr(q.data.cash.total)}</span>
                </li>
                <li className="flex justify-between py-1">
                  <span>Bank guarantees out (tenders and contracts)</span>
                  <span>{formatInr(q.data.cash.guarantees)}</span>
                </li>
              </ul>
            </Card>
            <Card title="Receivables over 90 days">
              {q.data.receivablesOver90.clients.length === 0 ? (
                <p className="text-sm text-fg-muted">None.</p>
              ) : (
                <ul className="divide-y divide-line text-sm" aria-label="Receivables over 90 days">
                  {q.data.receivablesOver90.clients.map((c) => (
                    <li key={c.party.id} className="flex justify-between py-1">
                      <span>{c.party.name}</span>
                      <span>
                        {formatInr(c.amount)}{' '}
                        <span className="text-xs text-fg-muted">of {formatInr(c.outstanding)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs">
                <Link to="/accounts/receivables" className="hover:underline">
                  All receivables
                </Link>
              </p>
            </Card>
            <Card title="Tenders due in a fortnight">
              {q.data.tendersDue.length === 0 ? (
                <p className="text-sm text-fg-muted">None due.</p>
              ) : (
                <ul className="divide-y divide-line text-sm" aria-label="Tenders due">
                  {q.data.tendersDue.map((t) => (
                    <li key={t.id} className="flex flex-wrap justify-between gap-2 py-1">
                      <Link
                        to="/tenders/$tenderId"
                        params={{ tenderId: t.id }}
                        className="hover:underline"
                      >
                        {t.number} {t.title}
                      </Link>
                      <span className="text-fg-muted">
                        {t.dueAt}
                        {t.value ? ` · ${formatInr(t.value)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Safety, last 90 days">
              {q.data.incidents.total === 0 ? (
                <p className="text-sm text-fg-muted">No incident reported.</p>
              ) : (
                <ul className="divide-y divide-line text-sm" aria-label="Incidents">
                  {q.data.incidents.kinds.map((i) => (
                    <li key={i.kind} className="flex justify-between py-1">
                      <span>{i.kind.replace('_', ' ')}</span>
                      <span>
                        {i.count}
                        {i.open ? (
                          <span className="ml-1">
                            <Badge tone="warning">{i.open} open</Badge>
                          </span>
                        ) : null}
                        {i.daysLost ? ` · ${i.daysLost} days lost` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function ProjectLink({ p }: { p: Ref }) {
  return (
    <Link to="/projects/$projectId" params={{ projectId: p.id }} className="hover:underline">
      <span className="font-mono text-xs">{p.number}</span> {p.name}
    </Link>
  );
}
