// Reports for people outside the site office (docs/wave7-plan.md step 7b.5): the directors' monthly MIS pack (every
// project's margin, performance, cash and exposure, and the company's cash ahead) and a project's monthly progress
// report to the client (progress three ways, the programme, milestones and the weeks ahead).
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useCompany } from '../accounts/model';
import { formatInr } from './money';
import type { ProjectDetail } from '../api/types';
import type { ProjectDashboard } from '../screens/ProjectDashboard';
import { shortDate } from '../schedule/model';
import { Particulars, PrintSheet, PrintTable } from './Letterhead';
import { Loading } from './PurchaseDocs';

interface Tile {
  project: { id: string; number: string; name: string };
  contract: string;
  forecastMargin: string;
  forecastMarginPct: string | null;
  spi: string | null;
  cpi: string | null;
  cashToDate: string;
  overdueReceivables: string;
  openVariations: { count: number; value: string; atRisk: string };
  openClaims: string;
  worstRisk: { number: string; event: string; score: number; band: string } | null;
  openRiskValue: string;
}
interface CompanyCash {
  cashNow: string;
  periods: { key: string; label: string; actual: boolean }[];
  totals: { in: Record<string, string>; out: Record<string, string>; net: Record<string, string> };
  position: Record<string, string>;
}

const right = 'text-right';
const pct = (v: string | null) => (v === null ? '—' : `${Number(v).toLocaleString('en-IN')}%`);
const idx = (v: string | null) => v ?? '—';

export function MisPackPrint() {
  const { company } = useCompany();
  const portfolio = useQuery({
    queryKey: ['portfolio'],
    queryFn: () =>
      api.request<{ asOf: string; tiles: Tile[]; totals: Record<string, string> }>(
        '/api/tenant/portfolio',
      ),
  });
  const today = new Date().toISOString().slice(0, 10);
  const cash = useQuery({
    queryKey: ['cash-flow', 'company', company?.id, 'month', today],
    enabled: !!company,
    retry: false,
    queryFn: () =>
      api.request<CompanyCash>(
        `/api/tenant/accounts/cash-flow?entityId=${company!.id}&by=month&asOf=${today}`,
      ),
  });
  if (!portfolio.data) return <Loading q={portfolio} />;
  const p = portfolio.data;
  const month = new Date(`${p.asOf}T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const ahead = cash.data?.periods.filter((x) => !x.actual).slice(0, 3) ?? [];
  const sum = (k: keyof Tile) => p.tiles.reduce((n, t) => n + Number(t[k] as string), 0);
  return (
    <PrintSheet
      entityId={company?.id}
      title={`MIS: ${month}`}
      meta={<div>As of {shortDate(p.asOf)}</div>}
      signature={false}
    >
      <section>
        <h2 className="mb-1 text-sm font-bold uppercase">Projects</h2>
        <PrintTable>
          <thead>
            <tr>
              <th>Project</th>
              <th className={right}>Contract</th>
              <th className={right}>Forecast margin</th>
              <th className={right}>SPI</th>
              <th className={right}>CPI</th>
              <th className={right}>Cash to date</th>
              <th className={right}>Overdue from client</th>
              <th className={right}>Open variations</th>
              <th className={right}>Open claims</th>
            </tr>
          </thead>
          <tbody>
            {p.tiles.map((t) => (
              <tr key={t.project.id}>
                <td>
                  {t.project.number} {t.project.name}
                  {t.worstRisk ? (
                    <div className="text-[8pt] italic">
                      Top risk {t.worstRisk.number}: {t.worstRisk.event} ({t.worstRisk.band})
                    </div>
                  ) : null}
                </td>
                <td className={right}>{formatInr(t.contract)}</td>
                <td className={right}>
                  {formatInr(t.forecastMargin)}{' '}
                  <div className="text-[8pt]">{pct(t.forecastMarginPct)}</div>
                </td>
                <td className={right}>{idx(t.spi)}</td>
                <td className={right}>{idx(t.cpi)}</td>
                <td className={right}>{formatInr(t.cashToDate)}</td>
                <td className={right}>{formatInr(t.overdueReceivables)}</td>
                <td className={right}>
                  {t.openVariations.count
                    ? `${t.openVariations.count} · ${formatInr(t.openVariations.value)}`
                    : '—'}
                </td>
                <td className={right}>{Number(t.openClaims) ? formatInr(t.openClaims) : '—'}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold">
              <td>All projects</td>
              <td className={right}>{formatInr(String(sum('contract')))}</td>
              <td className={right}>{formatInr(String(sum('forecastMargin')))}</td>
              <td />
              <td />
              <td className={right}>{formatInr(String(sum('cashToDate')))}</td>
              <td className={right}>{formatInr(String(sum('overdueReceivables')))}</td>
              <td />
              <td className={right}>{formatInr(String(sum('openClaims')))}</td>
            </tr>
          </tfoot>
        </PrintTable>
        <p className="mt-1 text-[8pt]">
          SPI and CPI: schedule and cost performance (1 is on plan; below 1 is behind or over).
        </p>
      </section>
      {cash.data && company ? (
        <section className="break-inside-avoid">
          <h2 className="mb-1 text-sm font-bold uppercase">Cash: {company.name}</h2>
          <Particulars rows={[['Bank and cash now', formatInr(cash.data.cashNow)]]} />
          {ahead.length ? (
            <PrintTable>
              <thead>
                <tr>
                  <th>Month ahead</th>
                  <th className={right}>Money in</th>
                  <th className={right}>Money out</th>
                  <th className={right}>Net</th>
                  <th className={right}>Position</th>
                </tr>
              </thead>
              <tbody>
                {ahead.map((m) => (
                  <tr key={m.key}>
                    <td>{m.label}</td>
                    <td className={right}>{formatInr(cash.data.totals.in[m.key] ?? '0')}</td>
                    <td className={right}>{formatInr(cash.data.totals.out[m.key] ?? '0')}</td>
                    <td className={right}>{formatInr(cash.data.totals.net[m.key] ?? '0')}</td>
                    <td className={right}>{formatInr(cash.data.position[m.key] ?? '0')}</td>
                  </tr>
                ))}
              </tbody>
            </PrintTable>
          ) : null}
        </section>
      ) : null}
    </PrintSheet>
  );
}

export function ProgressReportPrint({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const dash = useQuery({
    queryKey: ['project-dashboard', projectId],
    queryFn: () => api.request<ProjectDashboard>(`/api/tenant/projects/${projectId}/dashboard`),
  });
  if (!project.data) return <Loading q={project} />;
  if (!dash.data) return <Loading q={dash} />;
  const p = project.data;
  const d = dash.data;
  const t = d.progress.total;
  const month = new Date(`${d.asOf}T00:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <PrintSheet
      entityId={p.entity.id}
      title={`Monthly progress report: ${month}`}
      meta={<div>As of {shortDate(d.asOf)}</div>}
    >
      <Particulars
        rows={[
          ['Project', `${p.number} ${p.name}`],
          ['Client', p.client?.name ?? ''],
          ['Work order', p.clientRef ?? ''],
          ['Location', p.location ?? ''],
          ['Contract value', p.contractValue ? formatInr(p.contractValue) : ''],
          ['Planned finish', p.plannedFinishOn ? shortDate(p.plannedFinishOn) : ''],
        ]}
      />
      <section>
        <h2 className="mb-1 text-sm font-bold uppercase">Work done</h2>
        <PrintTable>
          <thead>
            <tr>
              <th>Section</th>
              <th className={right}>Value</th>
              <th className={right}>Done to date</th>
              <th className={right}>This period</th>
              <th className={right}>%</th>
            </tr>
          </thead>
          <tbody>
            {d.progress.sections.map((s) => (
              <tr key={`${s.boq}-${s.code ?? s.description}`}>
                <td>
                  {s.code ? `${s.code} ` : ''}
                  {s.description}
                </td>
                <td className={right}>{formatInr(s.value)}</td>
                <td className={right}>{formatInr(s.done)}</td>
                <td className={right}>{formatInr(s.period)}</td>
                <td className={right}>{s.pct === null ? '—' : `${s.pct}%`}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="font-bold">
              <td>All work</td>
              <td className={right}>{formatInr(t.value)}</td>
              <td className={right}>{formatInr(t.done)}</td>
              <td className={right}>{formatInr(t.period)}</td>
              <td className={right}>{t.pct === null ? '—' : `${t.pct}%`}</td>
            </tr>
          </tfoot>
        </PrintTable>
        <p className="mt-1 text-[8pt]">
          This period: {shortDate(d.progress.from)} to {shortDate(d.progress.to)}.
        </p>
      </section>
      {d.schedules.length ? (
        <section className="break-inside-avoid">
          <h2 className="mb-1 text-sm font-bold uppercase">Programme</h2>
          <PrintTable>
            <thead>
              <tr>
                <th>Programme</th>
                <th className={right}>Planned</th>
                <th className={right}>Scheduled</th>
                <th className={right}>Measured</th>
                <th>Forecast finish</th>
                <th>Against baseline</th>
              </tr>
            </thead>
            <tbody>
              {d.schedules.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className={right}>{s.plannedPct === null ? '—' : `${s.plannedPct}%`}</td>
                  <td className={right}>{s.scheduledPct === null ? '—' : `${s.scheduledPct}%`}</td>
                  <td className={right}>{s.measuredPct === null ? '—' : `${s.measuredPct}%`}</td>
                  <td>{s.finish ? shortDate(s.finish) : '—'}</td>
                  <td>
                    {s.slipDays === null
                      ? '—'
                      : s.slipDays === 0
                        ? 'On time'
                        : s.slipDays > 0
                          ? `${s.slipDays} days late`
                          : `${-s.slipDays} days early`}
                  </td>
                </tr>
              ))}
            </tbody>
          </PrintTable>
        </section>
      ) : null}
      {d.milestones.length ? (
        <section className="break-inside-avoid">
          <h2 className="mb-1 text-sm font-bold uppercase">Milestones</h2>
          <PrintTable>
            <thead>
              <tr>
                <th>Milestone</th>
                <th>Baseline</th>
                <th>Forecast</th>
              </tr>
            </thead>
            <tbody>
              {d.milestones.map((m) => (
                <tr key={`${m.planId}-${m.id}`}>
                  <td>
                    {m.code} {m.name}
                  </td>
                  <td>{m.baselineDate ? shortDate(m.baselineDate) : '—'}</td>
                  <td>{m.date ? shortDate(m.date) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </PrintTable>
        </section>
      ) : null}
      {d.lookahead.activities.length ? (
        <section>
          <h2 className="mb-1 text-sm font-bold uppercase">
            The next {Math.round(d.lookahead.days / 7)} weeks
          </h2>
          <PrintTable>
            <thead>
              <tr>
                <th>Activity</th>
                <th>Start</th>
                <th>Finish</th>
              </tr>
            </thead>
            <tbody>
              {d.lookahead.activities.map((a) => (
                <tr key={`${a.planId}-${a.id}`}>
                  <td>
                    {a.code} {a.name}
                  </td>
                  <td>{shortDate(a.start)}</td>
                  <td>{shortDate(a.finish)}</td>
                </tr>
              ))}
            </tbody>
          </PrintTable>
        </section>
      ) : null}
    </PrintSheet>
  );
}
