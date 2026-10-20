// Dashboards (docs/wave1-plan.md step 12 part 2, docs/08-dashboard.md §2.3, §2.4, §2.6): the tender and bid
// dashboard and the estimation dashboard. Three fixed headline numbers each, then the tiles each user adds from a
// catalogue (saved per user), then charts. Clicking a tile or a bar opens what it counts. Every view says when it
// was made; Excel downloads the figures and printing makes the PDF.
import { Alert, Button, Card, EmptyState, Field, Select, Spinner, cx, toast } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  Download,
  Plus,
  Printer,
  RefreshCw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { api, saveFile } from '../api/client';
import type {
  DashboardName,
  DashboardTile,
  EstimationDashboardData,
  TenderDashboardData,
} from '../api/types';
import { ChartFigure } from '../charts/ChartFigure';
import type { ChartOption } from '../charts/EChart';
import { valueAxis, type Measure } from '../charts/measure';
import {
  describeError,
  formatDate,
  formatDateTime,
  formatInr,
  formatInrShort,
} from '../lib/format';
import { PART_LABEL } from './Reports';
import { VERTICALS } from './TenderForm';
import { STATUS_LABEL } from './Tenders';
import { numberLocale } from '../lib/locale';

type Data = TenderDashboardData | EstimationDashboardData;

const TITLES: Record<DashboardName, string> = {
  tender: 'Tenders and bids',
  estimation: 'Estimation',
};

const tileValue = (t: DashboardTile) =>
  t.value === ''
    ? '–'
    : t.kind === 'money'
      ? formatInrShort(t.value)
      : t.kind === 'pct'
        ? `${t.value} %`
        : Number(t.value).toLocaleString(numberLocale());

export function DashboardScreen({ name }: { name: DashboardName }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [fy, setFy] = useState('');
  const [vertical, setVertical] = useState('');
  const [owner, setOwner] = useState('');
  const [editing, setEditing] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qs = new URLSearchParams(
    Object.entries({ fy, vertical, owner }).filter(([, v]) => v !== ''),
  ).toString();
  const q = useQuery({
    queryKey: ['dashboard', name, qs],
    queryFn: () => api.request<Data>(`/api/tenant/dashboards/${name}?${qs}`),
    placeholderData: (prev) => (prev?.dashboard === name ? prev : undefined),
  });
  const go = (to: string | undefined) => to && router.history.push(to);

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    try {
      await api.request(`/api/tenant/dashboards/${name}/tiles`, {
        method: 'POST',
        body: { tiles: editing },
      });
      await qc.invalidateQueries({ queryKey: ['dashboard', name] });
      setEditing(null);
      toast.success('Your tiles saved');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSaving(false);
    }
  };
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const { blob, fileName } = await api.download(`/api/tenant/dashboards/${name}/export?${qs}`);
      saveFile(blob, fileName);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const d = q.data;
  return (
    <div className="space-y-5">
      <style>{'@page { size: A4 landscape; margin: 10mm }'}</style>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <nav className="flex gap-1 print:hidden" aria-label="Dashboards">
            {(['tender', 'estimation'] as const).map((n) => (
              <Link
                key={n}
                to={`/dashboards/${n}`}
                className={cx(
                  'rounded-md px-3 py-1.5 text-sm',
                  n === name
                    ? 'bg-surface-2 font-medium text-fg'
                    : 'text-fg-muted hover:bg-surface-2',
                )}
              >
                {TITLES[n]}
              </Link>
            ))}
          </nav>
          <h1 className="mt-2 text-xl font-semibold">{TITLES[name]}</h1>
          {d && (
            <p className="text-xs text-fg-muted" data-testid="as-of">
              As of {formatDateTime(d.asOf)}
              {d.filter.fy ? ` · FY ${d.filter.fy}` : ''}
              {d.filter.vertical ? ` · ${VERTICALS[d.filter.vertical]}` : ''}
              {d.filter.ownerId
                ? ` · ${d.owners.find((o) => o.id === d.filter.ownerId)?.name ?? ''}`
                : ''}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-2 print:hidden">
          <Field label="Financial year">
            <Select
              value={fy || d?.filter.fy || ''}
              onChange={(e) => setFy(e.target.value)}
              className="w-32"
            >
              {(d?.years ?? []).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vertical">
            <Select value={vertical} onChange={(e) => setVertical(e.target.value)} className="w-32">
              <option value="">All</option>
              {Object.entries(VERTICALS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Owner">
            <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-40">
              <option value="">Anyone</option>
              {(d?.owners ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="ghost" onClick={() => void q.refetch()} title="Read the figures again">
            <RefreshCw className={cx('size-4', q.isFetching && 'animate-spin')} aria-hidden />{' '}
            Refresh
          </Button>
          <Button
            variant="secondary"
            aria-pressed={editing !== null}
            onClick={() => setEditing(editing ? null : (d?.tiles.map((t) => t.key) ?? []))}
          >
            <SlidersHorizontal className="size-4" aria-hidden /> Tiles
          </Button>
          <Button variant="secondary" busy={busy} onClick={() => void download()}>
            <Download className="size-4" aria-hidden /> Excel
          </Button>
          <Button variant="secondary" onClick={() => window.print()}>
            <Printer className="size-4" aria-hidden /> Print
          </Button>
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{describeError(q.error)}</Alert>
      ) : (
        d && (
          <>
            <section
              aria-label="Headline numbers"
              className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              {d.fixed.map((t) => (
                <TileCard key={t.key} tile={t} headline onOpen={go} />
              ))}
            </section>
            {editing ? (
              <TilePicker
                data={d}
                keys={editing}
                onChange={setEditing}
                onSave={() => void save()}
                onCancel={() => setEditing(null)}
                saving={saving}
              />
            ) : (
              d.tiles.length > 0 && (
                <section aria-label="My tiles" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  {d.tiles.map((t) => (
                    <TileCard key={t.key} tile={t} onOpen={go} />
                  ))}
                </section>
              )
            )}
            {d.dashboard === 'tender' ? <TenderCharts d={d} /> : <EstimationCharts d={d} />}
          </>
        )
      )}
    </div>
  );
}

function TileCard({
  tile: t,
  headline = false,
  onOpen,
}: {
  tile: DashboardTile;
  headline?: boolean;
  onOpen: (to: string | undefined) => void;
}) {
  const body = (
    <>
      <div className="text-xs text-fg-muted">{t.label}</div>
      <div
        className={cx(
          'mt-1 font-semibold tabular-nums',
          headline ? 'text-3xl' : 'text-2xl',
          t.tone === 'danger' && 'text-danger',
          t.tone === 'warning' && 'text-warning',
        )}
        data-testid={`tile-${t.key}`}
        title={t.kind === 'money' ? formatInr(t.value) : undefined}
      >
        {tileValue(t)}
      </div>
      {t.detail && <div className="mt-0.5 text-xs text-fg-muted">{t.detail}</div>}
    </>
  );
  const cls = 'block w-full rounded-lg border border-line bg-surface p-4 text-left';
  return t.link ? (
    <button
      type="button"
      className={`${cls} hover:border-accent`}
      title={t.hint}
      onClick={() => onOpen(t.link)}
    >
      {body}
    </button>
  ) : (
    <div className={cls} title={t.hint}>
      {body}
    </div>
  );
}

/** The KPI picker: add tiles from the catalogue, put them in order, remove them; saved for this user. */
function TilePicker({
  data,
  keys,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  data: Data;
  keys: string[];
  onChange: (k: string[]) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const byKey = new Map(data.catalogue.map((c) => [c.key, c]));
  const free = data.catalogue.filter((c) => !keys.includes(c.key));
  const [pick, setPick] = useState('');
  const move = (i: number, by: number) => {
    const next = [...keys];
    const [k] = next.splice(i, 1);
    next.splice(i + by, 0, k!);
    onChange(next);
  };
  return (
    <Card title="My tiles" className="print:hidden">
      <p className="mb-3 text-sm text-fg-muted">
        The three numbers above are on everyone&rsquo;s dashboard. Add your own below; only you see
        them.
      </p>
      {keys.length === 0 ? (
        <EmptyState title="No tiles added yet.">Choose a tile below and add it.</EmptyState>
      ) : (
        <ol
          className="mb-3 divide-y divide-line rounded-md border border-line"
          aria-label="Tiles chosen"
        >
          {keys.map((k, i) => (
            <li key={k} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="flex-1">
                {byKey.get(k)?.label ?? k}
                <span className="block text-xs text-fg-muted">{byKey.get(k)?.hint}</span>
              </span>
              <Button
                variant="ghost"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                aria-label={`Move ${byKey.get(k)?.label} up`}
              >
                <ArrowUp className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                disabled={i === keys.length - 1}
                onClick={() => move(i, 1)}
                aria-label={`Move ${byKey.get(k)?.label} down`}
              >
                <ArrowDown className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                onClick={() => onChange(keys.filter((x) => x !== k))}
                aria-label={`Remove ${byKey.get(k)?.label}`}
              >
                <X className="size-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Add a tile">
          <Select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            className="w-72"
            disabled={free.length === 0}
          >
            <option value="">{free.length ? 'Choose…' : 'All tiles added'}</option>
            {free.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          variant="secondary"
          disabled={!pick}
          onClick={() => {
            onChange([...keys, pick]);
            setPick('');
          }}
        >
          <Plus className="size-4" aria-hidden /> Add
        </Button>
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button busy={saving} onClick={onSave}>
            Save tiles
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Panel({ title, children, note }: { title: string; children: ReactNode; note?: string }) {
  return (
    <Card title={title} className="break-inside-avoid">
      {children}
      {note && <p className="mt-2 text-xs text-fg-muted">{note}</p>}
    </Card>
  );
}

const TENDERS: Measure = { unit: 'tenders' };

function TenderCharts({ d }: { d: TenderDashboardData }) {
  const c = d.charts;
  const options = useMemo(() => {
    const stages = c.stages.filter(
      (s) => s.count > 0 || ['lead', 'evaluating', 'bidding', 'submitted'].includes(s.status),
    );
    return {
      stages: {
        grid: { left: 48, right: 64, top: 56, bottom: 28 },
        xAxis: { type: 'category', data: stages.map((s) => STATUS_LABEL[s.status]) },
        yAxis: [valueAxis(TENDERS), valueAxis('money', { splitLine: { show: false } })],
        series: [
          { name: 'Tenders', type: 'bar', data: stages.map((s) => s.count) },
          {
            name: 'Estimate',
            type: 'line',
            yAxisIndex: 1,
            data: stages.map((s) => Number(s.estimatedValue)),
          },
        ],
      } as ChartOption,
      stageKeys: stages.map((s) => s.status),
      quarters: {
        grid: { left: 48, right: 16, top: 56, bottom: 28 },
        xAxis: { type: 'category', data: c.quarters.map((q) => q.quarter) },
        yAxis: valueAxis(TENDERS),
        series: [
          { name: 'Submitted', type: 'bar', data: c.quarters.map((q) => q.submitted) },
          { name: 'Won', type: 'bar', stack: 'r', data: c.quarters.map((q) => q.won) },
          { name: 'Lost', type: 'bar', stack: 'r', data: c.quarters.map((q) => q.lost) },
        ],
      } as ChartOption,
      verticals: {
        grid: { left: 48, right: 16, top: 56, bottom: 28 },
        xAxis: {
          type: 'category',
          data: c.verticals.map((v) => VERTICALS[v.vertical] ?? v.vertical),
        },
        yAxis: valueAxis(TENDERS),
        series: [
          { name: 'Open', type: 'bar', data: c.verticals.map((v) => v.open) },
          { name: 'Won', type: 'bar', data: c.verticals.map((v) => v.won) },
          { name: 'Lost', type: 'bar', data: c.verticals.map((v) => v.lost) },
        ],
      } as ChartOption,
    };
  }, [c]);
  const fyq = d.filter.fy ? `fy=${d.filter.fy}&` : '';
  const quarters = `Bids and results by quarter, FY ${d.filter.fy}`;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Pipeline by stage" note="Click a stage for its tenders.">
        <ChartFigure
          title="Pipeline by stage"
          label="Tenders and their estimates by stage"
          heading="Stage"
          option={options.stages}
          measures={{ Tenders: TENDERS, Estimate: 'money' }}
          drill={(e) => `/reports/pipeline?status=${options.stageKeys[e.dataIndex]}`}
        />
      </Panel>
      <Panel title={quarters} note="Click a quarter for the year's tenders.">
        <ChartFigure
          title={quarters}
          label="Bids submitted, won and lost by quarter"
          heading="Quarter"
          option={options.quarters}
          measures={TENDERS}
          drill={() => `/reports/pipeline?${fyq}status=all`}
        />
      </Panel>
      <Panel
        title="By vertical"
        note={`Open now; won and lost in FY ${d.filter.fy}. Click a vertical for its tenders.`}
      >
        <ChartFigure
          title="By vertical"
          label="Open, won and lost tenders by vertical"
          heading="Vertical"
          option={options.verticals}
          measures={TENDERS}
          drill={(e) => `/reports/pipeline?vertical=${c.verticals[e.dataIndex]?.vertical ?? ''}`}
        />
      </Panel>
      <Panel title="Next 30 days">
        {c.upcoming.length === 0 ? (
          <EmptyState title="Nothing due." />
        ) : (
          <ul className="divide-y divide-line text-sm" aria-label="Next 30 days">
            {c.upcoming.map((u, i) => (
              <li key={i} className="flex items-baseline gap-3 py-1.5">
                <span
                  className={cx(
                    'w-28 shrink-0 tabular-nums',
                    u.kind === 'security' && 'text-warning',
                  )}
                >
                  {u.kind === 'security' ? formatDate(u.at) : formatDateTime(u.at)}
                </span>
                <span className="w-36 shrink-0 text-fg-muted">{u.label}</span>
                <Link
                  to="/tenders/$tenderId"
                  params={{ tenderId: u.tender.id }}
                  className="min-w-0 flex-1 hover:underline"
                >
                  {u.tender.number} · {u.tender.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Enquiries awaiting quotes">
        {c.rfqs.length === 0 ? (
          <EmptyState title="No enquiry is out." />
        ) : (
          <table className="w-full text-sm" aria-label="Open RFQs">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="pb-1">RFQ</th>
                <th className="pb-1">Tender</th>
                <th className="pb-1">Quotes due</th>
                <th className="pb-1 text-right">Quotes in</th>
              </tr>
            </thead>
            <tbody>
              {c.rfqs.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1.5">
                    <Link to="/rfqs/$rfqId" params={{ rfqId: r.id }} className="hover:underline">
                      {r.number}
                    </Link>{' '}
                    <span className="text-fg-muted">{r.title}</span>
                  </td>
                  <td className="py-1.5">{r.tender.number}</td>
                  <td className="py-1.5">{r.dueOn ? formatDate(r.dueOn) : '–'}</td>
                  <td
                    className={cx(
                      'py-1.5 text-right tabular-nums',
                      r.quoted < r.vendors && 'text-warning',
                    )}
                  >
                    {r.quoted} of {r.vendors}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function EstimationCharts({ d }: { d: EstimationDashboardData }) {
  const c = d.charts;
  const options = useMemo(() => {
    const parts = c.breakdown.parts.filter((p) => Number(p.amount) !== 0);
    const top = [...c.topBoqs].reverse();
    return {
      estimators: {
        grid: { left: 48, right: 16, top: 56, bottom: 28 },
        xAxis: { type: 'category', data: c.estimators.map((e) => e.name) },
        yAxis: valueAxis({ unit: 'BOQs / items' }),
        series: [
          { name: 'BOQs', type: 'bar', data: c.estimators.map((e) => e.boqs) },
          { name: 'Items not priced', type: 'bar', data: c.estimators.map((e) => e.unpriced) },
        ],
      } as ChartOption,
      top: {
        grid: { left: 8, right: 24, top: 32, bottom: 24, containLabel: true },
        xAxis: valueAxis('money'),
        yAxis: {
          type: 'category',
          data: top.map((b) => `${b.tender.number} · ${b.name}`),
          axisLabel: { width: 180, overflow: 'truncate' },
        },
        series: [{ name: 'Value', type: 'bar', data: top.map((b) => Number(b.total)) }],
      } as ChartOption,
      topIds: top.map((b) => b.id),
      breakdown: {
        legend: { orient: 'vertical', right: 0, top: 'middle' },
        series: [
          {
            name: 'Amount',
            type: 'pie',
            radius: ['45%', '72%'],
            center: ['35%', '50%'],
            label: { show: false },
            data: parts.map((p) => ({ name: PART_LABEL[p.part], value: Number(p.amount) })),
          },
        ],
      } as ChartOption,
    };
  }, [c]);
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel
        title="BOQs in progress by estimator"
        note="The tender's owner is the estimator. Click for their open tenders."
      >
        {c.estimators.length === 0 ? (
          <EmptyState title="No BOQ is in progress." />
        ) : (
          <ChartFigure
            title="BOQs in progress by estimator"
            label="BOQs in progress and items not priced, by estimator"
            heading="Estimator"
            option={options.estimators}
            measures={{ BOQs: { unit: 'BOQs' }, 'Items not priced': { unit: 'items' } }}
            drill={(e) => {
              const id = c.estimators[e.dataIndex]?.id;
              return `/reports/pipeline?status=open${id ? `&owner=${id}` : ''}`;
            }}
          />
        )}
      </Panel>
      <Panel title="Largest BOQs in progress" note="Click a BOQ to open it.">
        {c.topBoqs.length === 0 ? (
          <EmptyState title="No BOQ is in progress." />
        ) : (
          <ChartFigure
            title="Largest BOQs in progress"
            label="The ten largest BOQs in progress by value"
            heading="BOQ"
            option={options.top}
            measures="money"
            height={Math.max(160, c.topBoqs.length * 30 + 64)}
            drill={(e) => `/boqs/${options.topIds[e.dataIndex]}`}
          />
        )}
      </Panel>
      <Panel
        title="What the BOQs in progress are made of"
        note="Each item split in the proportions of its rate analysis on its BOQ's rate date."
      >
        {Number(c.breakdown.total) === 0 ? (
          <EmptyState title="Nothing is priced yet." />
        ) : (
          <>
            <ChartFigure
              title="What the BOQs in progress are made of"
              label="Cost breakdown of the BOQs in progress"
              heading="Part"
              option={options.breakdown}
              measures="money"
              height={220}
            />
            <table className="mt-2 w-full text-sm" aria-label="Cost breakdown">
              <tbody>
                {c.breakdown.parts.map((p) => (
                  <tr key={p.part} className="border-t border-line">
                    <td className="py-1">{PART_LABEL[p.part]}</td>
                    <td className="py-1 text-right tabular-nums">{formatInr(p.amount)}</td>
                    <td className="w-20 py-1 text-right tabular-nums text-fg-muted">
                      {p.pct === null ? '' : `${Number(p.pct).toFixed(1)} %`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Panel>
      <Panel
        title="Revisions"
        note="BOQs with frozen versions: the first frozen value against today's."
      >
        {c.revisions.length === 0 ? (
          <EmptyState title="No BOQ has been frozen yet." />
        ) : (
          <table className="w-full text-sm" aria-label="Revisions">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="pb-1">BOQ</th>
                <th className="pb-1 text-right">Versions</th>
                <th className="pb-1 text-right">First</th>
                <th className="pb-1 text-right">Now</th>
                <th className="pb-1 text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {c.revisions.map((r) => (
                <tr key={r.id} className="border-t border-line">
                  <td className="py-1.5">
                    <Link
                      to="/boqs/$boqId/versions"
                      params={{ boqId: r.id }}
                      className="hover:underline"
                    >
                      {r.tenderNumber} · {r.name}
                    </Link>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{r.versions}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatInrShort(r.first)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatInrShort(r.current)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {r.changePct === null
                      ? '–'
                      : `${Number(r.changePct) > 0 ? '+' : ''}${r.changePct} %`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      <Panel title="Resource rates changed in 30 days">
        {c.rateChanges.length === 0 ? (
          <EmptyState title="No rate entered in the last 30 days." />
        ) : (
          <table className="w-full text-sm" aria-label="Rate changes">
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th className="pb-1">Resource</th>
                <th className="pb-1">From</th>
                <th className="pb-1 text-right">Rate</th>
                <th className="pb-1 text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {c.rateChanges.map((r, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-1.5">
                    <span className="font-mono text-xs">{r.code}</span> {r.name}
                  </td>
                  <td className="py-1.5">{formatDate(r.effectiveFrom)}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatInr(r.rate)}/{r.unit}
                  </td>
                  <td
                    className={cx(
                      'py-1.5 text-right tabular-nums',
                      r.changePct && Number(r.changePct) > 0 && 'text-danger',
                      r.changePct && Number(r.changePct) < 0 && 'text-success',
                    )}
                  >
                    {r.changePct === null
                      ? 'new'
                      : `${Number(r.changePct) > 0 ? '+' : ''}${r.changePct} %`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
