// Earned value (docs/wave4-plan.md step 3), for a project: PV from the baseline schedule at budget value, EV from
// the measurement book at budget rates, AC from the ledger; indices, the estimates at completion side by side, by
// WBS element, and the S-curves.
import { Alert, Card, Field, Input, PageHeader, Select, Spinner, Table, toast } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { ChartFigure } from '../../charts/ChartFigure';
import type { ChartOption } from '../../charts/EChart';
import { valueAxis } from '../../charts/measure';
import { describeError, formatInr } from '../../lib/format';
import { useProjectParam } from '../../lib/project-param';

type Method = 'cpi' | 'budget_rate' | 'cpi_spi' | 'bottom_up';
interface Figures {
  bac: string;
  pv: string | null;
  ev: string;
  ac: string;
  sv: string | null;
  cv: string;
  spi: string | null;
  cpi: string | null;
  eac: Record<Method, string | null>;
  etc: string | null;
  vac: string | null;
  pctPlanned: string | null;
  pctDone: string | null;
  pctSpent: string | null;
}
interface Report {
  asOf: string;
  baseline: string | null;
  method: Method;
  methods: { method: Method; label: string }[];
  project: Figures;
  byWbs: (Figures & { id: string | null; code: string; name: string; depth: number })[];
  curve: { months: string[]; pv: string[] | null; ev: (string | null)[]; ac: (string | null)[] };
  mayChoose: boolean;
}
const inr = (v: string | null) => (v === null ? '—' : formatInr(v));
const tone = (v: string | null, good: (n: number) => boolean) =>
  v === null ? '' : good(Number(v)) ? 'text-success' : 'text-danger';

export function EarnedValueScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useProjectParam();
  const [asOf, setAsOf] = useState(today());
  return (
    <div className="space-y-5">
      <PageHeader
        title="Earned value"
        subtitle="Planned, earned and actual cost; how the project is doing and where it will finish."
        actions={
          <div className="flex flex-wrap gap-2">
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
              type="date"
              aria-label="As of"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
            />
          </div>
        }
      />
      {projectId && <ProjectEv key={projectId} projectId={projectId} asOf={asOf} />}
    </div>
  );
}

function ProjectEv({ projectId, asOf }: { projectId: string; asOf: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['earned-value', projectId, asOf],
    queryFn: () =>
      api.request<Report>(`/api/tenant/projects/${projectId}/earned-value?asOf=${asOf}`),
  });
  const [error, setError] = useState<string | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const d = q.data;
  const p = d.project;
  const chosen = p.eac[d.method];
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      {!d.baseline && (
        <Alert tone="warning">
          The schedule has no baseline with activities linked to the contract BOQ: planned value, SV
          and SPI are blank until it has.
        </Alert>
      )}
      <Card title={`At ${d.asOf}${d.baseline ? ` against the baseline “${d.baseline}”` : ''}`}>
        <dl className="grid gap-3 text-sm sm:grid-cols-4" data-testid="ev-figures">
          {(
            [
              ['Budget at completion', inr(p.bac), ''],
              ['Planned value', `${inr(p.pv)}${p.pctPlanned ? ` (${p.pctPlanned}%)` : ''}`, ''],
              ['Earned value', `${inr(p.ev)}${p.pctDone ? ` (${p.pctDone}%)` : ''}`, ''],
              ['Actual cost', `${inr(p.ac)}${p.pctSpent ? ` (${p.pctSpent}%)` : ''}`, ''],
              ['Schedule variance', inr(p.sv), tone(p.sv, (n) => n >= 0)],
              ['Cost variance', inr(p.cv), tone(p.cv, (n) => n >= 0)],
              ['SPI', p.spi ?? '—', tone(p.spi, (n) => n >= 1)],
              ['CPI', p.cpi ?? '—', tone(p.cpi, (n) => n >= 1)],
              ['Estimate at completion', inr(chosen), ''],
              ['Estimate to complete', inr(p.etc), ''],
              ['Variance at completion', inr(p.vac), tone(p.vac, (n) => n >= 0)],
            ] as const
          ).map(([k, v, c]) => (
            <div key={k}>
              <dt className="text-xs text-fg-muted">{k}</dt>
              <dd className={`font-medium ${c}`}>{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card title="Estimate at completion">
        <Table minWidth="32rem">
          <thead>
            <tr>
              <th>Method</th>
              <th className="text-right">Estimate</th>
            </tr>
          </thead>
          <tbody>
            {d.methods.map((m) => (
              <tr
                key={m.method}
                aria-label={m.label}
                className={m.method === d.method ? 'font-medium' : ''}
              >
                <td>
                  {m.label}
                  {m.method === d.method && ' · the forecast'}
                </td>
                <td className="text-right tabular-nums">{inr(p.eac[m.method])}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        {d.mayChoose && (
          <Field label="The project's forecast uses">
            <Select
              value={d.method}
              onChange={async (e) => {
                setError(null);
                try {
                  await api.request(`/api/tenant/projects/${projectId}/earned-value/method`, {
                    method: 'POST',
                    body: { method: e.target.value },
                  });
                  toast.success('Forecast method saved');
                  void qc.invalidateQueries({ queryKey: ['earned-value', projectId] });
                } catch (err) {
                  setError(describeError(err));
                }
              }}
            >
              {d.methods.map((m) => (
                <option key={m.method} value={m.method}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </Card>

      <Card title="S-curves">
        <Curves curve={d.curve} />
      </Card>

      {d.byWbs.length > 0 && (
        <Card title="By WBS element">
          <Table minWidth="56rem">
            <thead>
              <tr>
                <th>WBS</th>
                <th className="text-right">BAC</th>
                <th className="text-right">PV</th>
                <th className="text-right">EV</th>
                <th className="text-right">AC</th>
                <th className="text-right">SPI</th>
                <th className="text-right">CPI</th>
                <th className="text-right">EAC</th>
              </tr>
            </thead>
            <tbody>
              {d.byWbs.map((w) => (
                <tr key={w.id ?? 'none'} aria-label={w.id ? `${w.code} ${w.name}` : w.name}>
                  <td style={{ paddingLeft: `${0.75 + w.depth * 1.25}rem` }}>
                    {w.code} {w.name}
                  </td>
                  <td className="text-right tabular-nums">{inr(w.bac)}</td>
                  <td className="text-right tabular-nums">{inr(w.pv)}</td>
                  <td className="text-right tabular-nums">{inr(w.ev)}</td>
                  <td className="text-right tabular-nums">{inr(w.ac)}</td>
                  <td className={`text-right tabular-nums ${tone(w.spi, (n) => n >= 1)}`}>
                    {w.spi ?? '—'}
                  </td>
                  <td className={`text-right tabular-nums ${tone(w.cpi, (n) => n >= 1)}`}>
                    {w.cpi ?? '—'}
                  </td>
                  <td className="text-right tabular-nums">{inr(w.eac[d.method])}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </>
  );
}

function Curves({ curve }: { curve: Report['curve'] }) {
  const option = useMemo<ChartOption>(() => {
    const n = (xs: (string | null)[]) => xs.map((x) => (x === null ? null : Number(x)));
    const line = (name: string, data: (number | null)[], dashed = false) => ({
      name,
      type: 'line',
      data,
      showSymbol: data.length < 30,
      lineStyle: { type: dashed ? 'dashed' : 'solid' },
    });
    return {
      grid: { left: 70, right: 16, top: 56, bottom: 30 },
      xAxis: { type: 'category', data: curve.months },
      yAxis: valueAxis('money'),
      series: [
        ...(curve.pv ? [line('Planned value', n(curve.pv), true)] : []),
        line('Earned value', n(curve.ev)),
        line('Actual cost', n(curve.ac)),
      ],
    };
  }, [curve]);
  return (
    <ChartFigure
      title="S-curves"
      option={option}
      height={280}
      heading="Month"
      measures="money"
      label="S-curves: planned value, earned value and actual cost by month"
    />
  );
}
