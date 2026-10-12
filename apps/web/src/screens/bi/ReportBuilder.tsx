// The report builder (docs/wave6-plan.md step 3): choose a view, its fields or a grouping with totals, filters and a
// sort; see a table or a chart; save, share, export to Excel and schedule. The server builds the query from the
// reporting model only; this screen sends names, never SQL.
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api, saveFile } from '../../api/client';
import { EChart, type ChartOption } from '../../charts/EChart';
import { describeError, formatInr } from '../../lib/format';

interface ViewDef {
  name: string;
  label: string;
  fields: { name: string; label: string; type: string; group?: boolean; sum?: boolean }[];
}
type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max';
interface Spec {
  view: string;
  fields: string[];
  filters: { field: string; op: string; value: string | string[] }[];
  groupBy: string[];
  aggregates: { field: string; fn: Agg }[];
  sort: { field: string; dir: 'asc' | 'desc' } | null;
  limit: number;
}
interface Chart {
  kind: 'table' | 'bar' | 'line' | 'pie';
  label?: string | undefined;
  value?: string | undefined;
}
interface Result {
  columns: { name: string; label: string; type: string }[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}
interface Saved {
  id: string;
  name: string;
  spec: Spec;
  chart: Chart;
  sharedWith: string;
  owner: string;
  mine: boolean;
  schedules: { id: string; cadence: string; nextRunAt: string; lastError: string | null }[] | null;
}

const blank = (view: string): Spec => ({
  view,
  fields: [],
  filters: [],
  groupBy: [],
  aggregates: [],
  sort: null,
  limit: 1000,
});
const show = (v: unknown, type: string) =>
  v === null || v === undefined ? '—' : type === 'money' ? formatInr(String(v)) : String(v);

export function ReportBuilderScreen() {
  const qc = useQueryClient();
  const views = useQuery({
    queryKey: ['bi', 'views'],
    queryFn: () => api.request<ViewDef[]>('/api/tenant/reports/views'),
  });
  const saved = useQuery({
    queryKey: ['bi', 'saved'],
    queryFn: () => api.request<Saved[]>('/api/tenant/reports/saved'),
  });
  const [spec, setSpec] = useState<Spec | null>(null);
  const [chart, setChart] = useState<Chart>({ kind: 'table' });
  const [name, setName] = useState('');
  const [shareWith, setShareWith] = useState('nobody');
  const [current, setCurrent] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A scheduled export's notice links here with ?export=…: fetch the file at once.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('export');
    if (id)
      void api
        .download(`/api/tenant/reports/exports/${id}`)
        .then((f) => saveFile(f.blob, f.fileName))
        .catch((err: unknown) => setError(describeError(err)));
  }, []);
  const view = views.data?.find((v) => v.name === spec?.view);
  const run = async (s: Spec) => {
    setError(null);
    setBusy(true);
    try {
      setResult(await api.request<Result>('/api/tenant/reports/run', { method: 'POST', body: s }));
    } catch (err) {
      setError(describeError(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  const update = (s: Spec) => setSpec(s);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Report builder"
        subtitle="Your own reports over projects, purchasing, billing, the ledger, CRM and sales."
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <Card title="Saved reports">
          <ul className="space-y-1 text-sm" aria-label="Saved reports">
            {(saved.data ?? []).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className="text-left underline"
                  onClick={() => {
                    setSpec(r.spec);
                    setChart(r.chart);
                    setName(r.name);
                    setShareWith(r.sharedWith);
                    setCurrent(r.mine ? r.id : null);
                    void run(r.spec);
                  }}
                >
                  {r.name}
                </button>{' '}
                {!r.mine && <span className="text-xs text-fg-muted">by {r.owner}</span>}
                {r.sharedWith !== 'nobody' && <Badge tone="accent">{r.sharedWith}</Badge>}
                {r.schedules?.length ? <Badge tone="success">scheduled</Badge> : null}
              </li>
            ))}
            {saved.data?.length === 0 && <li className="text-fg-muted">None yet.</li>}
          </ul>
        </Card>
        <div className="space-y-5">
          <Card title="Build">
            {views.isPending ? (
              <Spinner />
            ) : (
              <div className="space-y-3">
                <Field label="View">
                  <Select
                    value={spec?.view ?? ''}
                    onChange={(e) => {
                      setSpec(e.target.value ? blank(e.target.value) : null);
                      setResult(null);
                      setCurrent(null);
                      setChart({ kind: 'table' });
                    }}
                  >
                    <option value="">Choose what to report on…</option>
                    {(views.data ?? []).map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                {spec && view && <Builder spec={spec} view={view} onChange={update} />}
                {spec && (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" busy={busy} onClick={() => void run(spec)}>
                      Run
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={async () => {
                        setError(null);
                        try {
                          const f = await api.download('/api/tenant/reports/run.xlsx', {
                            method: 'POST',
                            body: { spec, title: name || view?.label || 'Report' },
                          });
                          saveFile(f.blob, f.fileName);
                        } catch (err) {
                          setError(describeError(err));
                        }
                      }}
                    >
                      Excel
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>
          {result && spec && (
            <ResultCard
              result={result}
              chart={chart}
              setChart={setChart}
              columns={result.columns}
            />
          )}
          {spec && result && (
            <Card title="Save">
              <form
                aria-label="Save the report"
                className="grid gap-3 sm:grid-cols-4"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setError(null);
                  try {
                    const r = await api.request<{ id: string }>(
                      current
                        ? `/api/tenant/reports/saved/${current}`
                        : '/api/tenant/reports/saved',
                      {
                        method: 'POST',
                        body: { name, spec, chart, sharedWith: shareWith },
                      },
                    );
                    setCurrent(r.id);
                    void qc.invalidateQueries({ queryKey: ['bi', 'saved'] });
                  } catch (err) {
                    setError(describeError(err));
                  }
                }}
              >
                <Field label="Report name">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    minLength={2}
                  />
                </Field>
                <Field label="Share with">
                  <Select value={shareWith} onChange={(e) => setShareWith(e.target.value)}>
                    <option value="nobody">Nobody</option>
                    <option value="managers">Managers</option>
                    <option value="everyone">Everyone</option>
                  </Select>
                </Field>
                <div className="flex items-end gap-2">
                  <Button type="submit">{current ? 'Save changes' : 'Save'}</Button>
                </div>
              </form>
              {current && (
                <ScheduleForm
                  id={current}
                  onDone={() => void qc.invalidateQueries({ queryKey: ['bi', 'saved'] })}
                  onError={setError}
                />
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function Builder({
  spec,
  view,
  onChange,
}: {
  spec: Spec;
  view: ViewDef;
  onChange: (s: Spec) => void;
}) {
  const grouped = spec.groupBy.length > 0;
  const label = (n: string) => view.fields.find((f) => f.name === n)?.label ?? n;
  const [filter, setFilter] = useState({ field: '', op: 'eq', value: '' });
  const toggle = (list: string[], n: string) =>
    list.includes(n) ? list.filter((x) => x !== n) : [...list, n];
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="mb-1 text-xs text-fg-muted">Group by (then add totals)</div>
        <div className="flex flex-wrap gap-1" aria-label="Group by">
          {view.fields
            .filter((f) => f.group)
            .map((f) => (
              <Button
                key={f.name}
                type="button"
                variant={spec.groupBy.includes(f.name) ? 'primary' : 'ghost'}
                aria-pressed={spec.groupBy.includes(f.name)}
                onClick={() =>
                  onChange({ ...spec, groupBy: toggle(spec.groupBy, f.name), sort: null })
                }
              >
                {f.label}
              </Button>
            ))}
        </div>
      </div>
      {grouped ? (
        <div>
          <div className="mb-1 text-xs text-fg-muted">Totals</div>
          <div className="flex flex-wrap gap-1" aria-label="Totals">
            <Button
              type="button"
              variant={spec.aggregates.some((a) => a.fn === 'count') ? 'primary' : 'ghost'}
              onClick={() =>
                onChange({
                  ...spec,
                  aggregates: spec.aggregates.some((a) => a.fn === 'count')
                    ? spec.aggregates.filter((a) => a.fn !== 'count')
                    : [...spec.aggregates, { field: view.fields[0]!.name, fn: 'count' }],
                })
              }
            >
              Count
            </Button>
            {view.fields
              .filter((f) => f.sum)
              .map((f) => {
                const on = spec.aggregates.some((a) => a.fn === 'sum' && a.field === f.name);
                return (
                  <Button
                    key={f.name}
                    type="button"
                    variant={on ? 'primary' : 'ghost'}
                    aria-pressed={on}
                    onClick={() =>
                      onChange({
                        ...spec,
                        aggregates: on
                          ? spec.aggregates.filter((a) => !(a.fn === 'sum' && a.field === f.name))
                          : [...spec.aggregates, { field: f.name, fn: 'sum' }],
                      })
                    }
                  >
                    Total {f.label.toLowerCase()}
                  </Button>
                );
              })}
          </div>
        </div>
      ) : (
        <div>
          <div className="mb-1 text-xs text-fg-muted">Fields</div>
          <div className="flex flex-wrap gap-1" aria-label="Fields">
            {view.fields.map((f) => (
              <Button
                key={f.name}
                type="button"
                variant={spec.fields.includes(f.name) ? 'primary' : 'ghost'}
                aria-pressed={spec.fields.includes(f.name)}
                onClick={() =>
                  onChange({ ...spec, fields: toggle(spec.fields, f.name), sort: null })
                }
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="mb-1 text-xs text-fg-muted">Filters</div>
        <ul className="mb-1 space-y-1">
          {spec.filters.map((f, i) => (
            <li key={i}>
              {label(f.field)} {f.op} {Array.isArray(f.value) ? f.value.join(', ') : f.value}{' '}
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  onChange({ ...spec, filters: spec.filters.filter((_, j) => j !== i) })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Select
            aria-label="Filter field"
            value={filter.field}
            onChange={(e) => setFilter({ ...filter, field: e.target.value })}
          >
            <option value="">Field…</option>
            {view.fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Comparison"
            value={filter.op}
            onChange={(e) => setFilter({ ...filter, op: e.target.value })}
          >
            <option value="eq">is</option>
            <option value="ne">is not</option>
            <option value="gt">more than</option>
            <option value="lt">less than</option>
            <option value="contains">contains</option>
          </Select>
          <Input
            aria-label="Filter value"
            value={filter.value}
            onChange={(e) => setFilter({ ...filter, value: e.target.value })}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={!filter.field || !filter.value}
            onClick={() => {
              onChange({ ...spec, filters: [...spec.filters, { ...filter }] });
              setFilter({ field: '', op: 'eq', value: '' });
            }}
          >
            Add filter
          </Button>
        </div>
      </div>
    </div>
  );
}

function ResultCard({
  result,
  chart,
  setChart,
  columns,
}: {
  result: Result;
  chart: Chart;
  setChart: (c: Chart) => void;
  columns: Result['columns'];
}) {
  const valueCols = columns.filter((c) => c.type === 'money' || c.type === 'number');
  const option = useMemo<ChartOption | null>(() => {
    if (chart.kind === 'table' || !chart.label || !chart.value) return null;
    const labels = result.rows.map((r) => String(r[chart.label!] ?? '—'));
    const values = result.rows.map((r) => Number(r[chart.value!] ?? 0));
    if (chart.kind === 'pie')
      return {
        tooltip: { trigger: 'item' },
        series: [{ type: 'pie', data: labels.map((name, i) => ({ name, value: values[i] })) }],
      };
    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: labels },
      yAxis: { type: 'value' },
      series: [{ type: chart.kind, data: values }],
    };
  }, [chart, result]);
  return (
    <Card title={`${result.rows.length} rows${result.truncated ? ' (the first ones)' : ''}`}>
      <div className="mb-3 flex flex-wrap gap-2">
        <Select
          aria-label="Show as"
          value={chart.kind}
          onChange={(e) =>
            setChart({
              kind: e.target.value as Chart['kind'],
              label: chart.label ?? columns[0]?.name,
              value: chart.value ?? valueCols[0]?.name,
            })
          }
        >
          <option value="table">Table</option>
          <option value="bar">Bar chart</option>
          <option value="line">Line chart</option>
          <option value="pie">Pie chart</option>
        </Select>
        {chart.kind !== 'table' && (
          <>
            <Select
              aria-label="Labels"
              value={chart.label ?? ''}
              onChange={(e) => setChart({ ...chart, label: e.target.value })}
            >
              {columns.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Values"
              value={chart.value ?? ''}
              onChange={(e) => setChart({ ...chart, value: e.target.value })}
            >
              {valueCols.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label}
                </option>
              ))}
            </Select>
          </>
        )}
      </div>
      {option && <EChart option={option} label="The report as a chart" />}
      <Table minWidth="40rem">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.name}
                className={c.type === 'money' || c.type === 'number' ? 'text-right' : ''}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody aria-label="Report rows">
          {result.rows.map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td
                  key={c.name}
                  className={
                    c.type === 'money' || c.type === 'number' ? 'text-right tabular-nums' : ''
                  }
                >
                  {show(r[c.name], c.type)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function ScheduleForm({
  id,
  onDone,
  onError,
}: {
  id: string;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [cadence, setCadence] = useState('weekly');
  const [weekday, setWeekday] = useState(1);
  const [monthday, setMonthday] = useState(1);
  return (
    <form
      aria-label="Schedule"
      className="mt-3 grid gap-3 sm:grid-cols-4"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.request(`/api/tenant/reports/saved/${id}/schedules`, {
            method: 'POST',
            body: {
              cadence,
              weekday: cadence === 'weekly' ? weekday : null,
              monthday: cadence === 'monthly' ? monthday : null,
            },
          });
          onDone();
        } catch (err) {
          onError(describeError(err));
        }
      }}
    >
      <Field label="Send to my inbox">
        <Select value={cadence} onChange={(e) => setCadence(e.target.value)}>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
        </Select>
      </Field>
      {cadence === 'weekly' && (
        <Field label="On">
          <Select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
            {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
              (d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ),
            )}
          </Select>
        </Field>
      )}
      {cadence === 'monthly' && (
        <Field label="Day of the month">
          <Input
            type="number"
            min={1}
            max={28}
            value={monthday}
            onChange={(e) => setMonthday(Number(e.target.value))}
          />
        </Field>
      )}
      <div className="flex items-end">
        <Button type="submit" variant="secondary">
          Schedule at 07:00
        </Button>
      </div>
    </form>
  );
}
