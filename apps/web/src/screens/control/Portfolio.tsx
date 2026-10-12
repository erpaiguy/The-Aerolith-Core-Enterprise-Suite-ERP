// The portfolio and a project's monthly review (docs/wave4-plan.md step 7): every project's margin, performance, cash,
// variations, claims and risks on one page; and one project's month, from cost to risks, ready to print.
import {
  Alert,
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
} from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';

interface Tile {
  project: { id: string; number: string; name: string };
  contract: string;
  forecastCost: string;
  forecastMargin: string;
  forecastMarginPct: string | null;
  tenderMarginPct: string | null;
  spi: string | null;
  cpi: string | null;
  cashToDate: string;
  overdueReceivables: string;
  openVariations: { count: number; value: string; atRisk: string };
  openClaims: string;
  worstRisk: { number: string; event: string; score: number; band: string } | null;
  openRiskValue: string;
  contingencyRemaining: string;
}
const idx = (v: string | null) =>
  v === null ? (
    <span className="text-fg-muted">—</span>
  ) : (
    <span className={Number(v) >= 1 ? 'text-success' : 'text-danger'}>{v}</span>
  );

export function PortfolioScreen() {
  const q = useQuery({
    queryKey: ['portfolio'],
    queryFn: () =>
      api.request<{ asOf: string; tiles: Tile[]; totals: Record<string, string> }>(
        '/api/tenant/portfolio',
      ),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Portfolio"
        subtitle="Every project: margin, performance, cash, variations, claims and risks."
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        <>
          <Card title={`As of ${q.data.asOf}`}>
            <dl className="grid gap-3 text-sm sm:grid-cols-4" data-testid="portfolio-totals">
              {(
                [
                  ['Contracts', q.data.totals.contract],
                  ['Forecast cost', q.data.totals.forecastCost],
                  ['Forecast margin', q.data.totals.forecastMargin],
                  ['Cash so far', q.data.totals.cashToDate],
                  ['Overdue from clients', q.data.totals.overdueReceivables],
                  ['Open claims', q.data.totals.openClaims],
                  ['Variations at risk', q.data.totals.variationsAtRisk],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-fg-muted">{k}</dt>
                  <dd className="font-medium">{formatInr(v ?? '0')}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card title="Projects">
            <Table minWidth="72rem">
              <thead>
                <tr>
                  <th>Project</th>
                  <th className="text-right">Contract</th>
                  <th className="text-right">Margin (tender)</th>
                  <th>SPI</th>
                  <th>CPI</th>
                  <th className="text-right">Cash so far</th>
                  <th className="text-right">Overdue</th>
                  <th>Variations</th>
                  <th className="text-right">Claims</th>
                  <th>Worst risk</th>
                  <th className="text-right">Contingency left</th>
                </tr>
              </thead>
              <tbody>
                {q.data.tiles.map((t) => (
                  <tr key={t.project.id} aria-label={t.project.number}>
                    <td>
                      {t.project.number} {t.project.name}
                    </td>
                    <td className="text-right tabular-nums">{formatInr(t.contract)}</td>
                    <td className="text-right tabular-nums">
                      {formatInr(t.forecastMargin)}
                      <span className="block text-xs text-fg-muted">
                        {t.forecastMarginPct ?? '—'}% ({t.tenderMarginPct ?? '—'}%)
                      </span>
                    </td>
                    <td>{idx(t.spi)}</td>
                    <td>{idx(t.cpi)}</td>
                    <td className="text-right tabular-nums">{formatInr(t.cashToDate)}</td>
                    <td className="text-right tabular-nums">{formatInr(t.overdueReceivables)}</td>
                    <td>
                      {t.openVariations.count} open, {formatInr(t.openVariations.value)}
                      {Number(t.openVariations.atRisk) > 0 && (
                        <Badge tone="danger">{formatInr(t.openVariations.atRisk)} at risk</Badge>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{formatInr(t.openClaims)}</td>
                    <td>{t.worstRisk ? `${t.worstRisk.number} (${t.worstRisk.score})` : '—'}</td>
                    <td className="text-right tabular-nums">{formatInr(t.contingencyRemaining)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

interface Review {
  project: { number: string; name: string };
  month: string;
  asOf: string;
  summary: Tile;
  cost: {
    totals: Record<string, string>;
    worst: {
      key: string;
      costCode: { code: string; name: string } | null;
      wbs: { code: string } | null;
      budget: string;
      forecast: string;
      variance: string;
    }[];
  };
  earnedValue: {
    bac: string;
    pv: string | null;
    ev: string;
    ac: string;
    spi: string | null;
    cpi: string | null;
    baseline: string | null;
  };
  cash: {
    month: { in: string; out: string };
    next: { month: string; in: string; out: string; position: string }[];
  };
  variations: {
    totals: Record<string, { count: number; value: string }>;
    atRisk: string;
    open: { number: string; title: string; status: string; value: string }[];
  };
  contracts: { calendar: { date: string; what: string; contract: string; overdue: boolean }[] };
  risks: {
    top: { number: string; event: string; score: number; expectedValue: string }[];
    openExpectedValue: string;
    contingency: { held: string; drawn: string; remaining: string } | null;
  };
}

export function MonthlyReviewScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useState('');
  const [month, setMonth] = useState(today().slice(0, 7));
  const q = useQuery({
    queryKey: ['review', projectId, month],
    enabled: !!projectId && !!month,
    queryFn: () => api.request<Review>(`/api/tenant/projects/${projectId}/review?month=${month}`),
  });
  const d = q.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title="Monthly review"
        subtitle="A project's month: planned against actual against forecast, cash, variations, contracts and risks."
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Select
              aria-label="Project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">Choose a project…</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} {p.name}
                </option>
              ))}
            </Select>
            <Input
              type="month"
              aria-label="Month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
            />
            <Button type="button" variant="secondary" onClick={() => window.print()}>
              Print
            </Button>
          </div>
        }
      />
      {q.isError && <Alert tone="danger">{describeError(q.error)}</Alert>}
      {q.isFetching && !d && <Spinner />}
      {d && (
        <div className="space-y-5" data-testid="review">
          <Card title={`${d.project.number} ${d.project.name}: ${d.month} (as of ${d.asOf})`}>
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              {(
                [
                  ['Contract', formatInr(d.summary.contract)],
                  ['Forecast cost', formatInr(d.summary.forecastCost)],
                  [
                    'Forecast margin',
                    `${formatInr(d.summary.forecastMargin)} (${d.summary.forecastMarginPct ?? '—'}%)`,
                  ],
                  ['Tender margin', `${d.summary.tenderMarginPct ?? '—'}%`],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-fg-muted">{k}</dt>
                  <dd className="font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card title="Cost: planned, actual, forecast">
            <dl className="grid gap-3 text-sm sm:grid-cols-4">
              {[
                'original',
                'changes',
                'budget',
                'committed',
                'actual',
                'ctc',
                'forecast',
                'variance',
              ].map((k) => (
                <div key={k}>
                  <dt className="text-xs text-fg-muted">{k}</dt>
                  <dd className="font-medium">{formatInr(d.cost.totals[k] ?? '0')}</dd>
                </div>
              ))}
            </dl>
            {d.cost.worst.length > 0 && (
              <ul className="mt-2 text-sm">
                {d.cost.worst.map((w) => (
                  <li key={w.key}>
                    {w.costCode ? `${w.costCode.code} ${w.costCode.name}` : 'No cost code'}
                    {w.wbs && ` · ${w.wbs.code}`}: variance {formatInr(w.variance)}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Earned value">
            <p className="text-sm" data-testid="review-ev">
              BAC {formatInr(d.earnedValue.bac)} · PV{' '}
              {d.earnedValue.pv ? formatInr(d.earnedValue.pv) : '—'} · EV{' '}
              {formatInr(d.earnedValue.ev)} · AC {formatInr(d.earnedValue.ac)} · SPI{' '}
              {d.earnedValue.spi ?? '—'} · CPI {d.earnedValue.cpi ?? '—'}
            </p>
          </Card>
          <Card title="Cash">
            <p className="text-sm">
              This month: in {formatInr(d.cash.month.in)}, out {formatInr(d.cash.month.out)}.
            </p>
            <ul className="text-sm">
              {d.cash.next.map((n) => (
                <li key={n.month}>
                  {n.month}: in {formatInr(n.in)}, out {formatInr(n.out)}, position{' '}
                  {formatInr(n.position)}
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Variations">
            <p className="text-sm">
              {Object.entries(d.variations.totals)
                .map(([s, t]) => `${s} ${t.count} (${formatInr(t.value)})`)
                .join(' · ') || 'None.'}
              {Number(d.variations.atRisk) > 0 &&
                ` · ${formatInr(d.variations.atRisk)} executed, not approved`}
            </p>
          </Card>
          <Card title="Contracts: the next 30 days">
            <ul className="text-sm">
              {d.contracts.calendar.map((c, i) => (
                <li key={i} className={c.overdue ? 'text-danger' : ''}>
                  {c.date} · {c.what} ({c.contract})
                </li>
              ))}
              {d.contracts.calendar.length === 0 && <li className="text-fg-muted">Nothing due.</li>}
            </ul>
          </Card>
          <Card title="Risks">
            <ul className="text-sm">
              {d.risks.top.map((r) => (
                <li key={r.number}>
                  {r.number} {r.event} ({r.score}) · {formatInr(r.expectedValue)} expected
                </li>
              ))}
            </ul>
            <p className="mt-1 text-sm">
              Open expected value {formatInr(d.risks.openExpectedValue)}
              {d.risks.contingency &&
                ` · contingency remaining ${formatInr(d.risks.contingency.remaining)} of ${formatInr(d.risks.contingency.held)}`}
            </p>
          </Card>
        </div>
      )}
    </div>
  );
}
