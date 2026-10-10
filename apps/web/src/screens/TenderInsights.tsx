// Across tenders (docs/wave1-plan.md step 8): the agenda of coming dates, and the win/loss analysis.
import { Alert, Badge, Card, Field, PageHeader, Select, Spinner, Stat, Table } from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { AgendaItem, WinLoss, WinLossTally } from '../api/types';
import { describeError, formatDate, formatInrShort } from '../lib/format';
import { VERTICALS } from './TenderForm';

const KIND: Record<
  AgendaItem['kind'],
  { label: string; tone: 'neutral' | 'accent' | 'warning' | 'danger' }
> = {
  submission: { label: 'Submission', tone: 'danger' },
  prebid: { label: 'Pre-bid', tone: 'accent' },
  queries: { label: 'Queries', tone: 'accent' },
  opening: { label: 'Opening', tone: 'neutral' },
  security_expiry: { label: 'EMD / BG', tone: 'warning' },
  checklist: { label: 'Document', tone: 'neutral' },
};

const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The next weeks across open tenders: deadlines, meetings, openings, expiring guarantees, documents due; as a list
 * or a month calendar. */
export function TenderAgenda() {
  const [view, setView] = useState<'list' | 'month'>(() => {
    try {
      return localStorage.getItem('aerolith.agenda.view') === 'month' ? 'month' : 'list';
    } catch {
      return 'list';
    }
  });
  const pick = (v: 'list' | 'month') => {
    setView(v);
    try {
      localStorage.setItem('aerolith.agenda.view', v);
    } catch {
      // Not kept: fine.
    }
  };
  const toggle = (
    <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="Agenda view">
      {(['list', 'month'] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => pick(v)}
          className={`rounded px-2 py-1 text-xs ${view === v ? 'bg-surface-2 font-medium' : 'text-fg-muted'}`}
        >
          {v === 'list' ? 'List' : 'Month'}
        </button>
      ))}
    </div>
  );
  return view === 'list' ? <AgendaList view={toggle} /> : <AgendaMonth view={toggle} />;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A month of tender dates, Monday first, today marked; arrows move a month. */
function AgendaMonth({ view }: { view: React.ReactNode }) {
  const now = new Date();
  const [month, setMonth] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const first = new Date(month.y, month.m, 1);
  const days = new Date(month.y, month.m + 1, 0).getDate();
  const from = `${month.y}-${pad(month.m + 1)}-01`;
  const to = `${month.y}-${pad(month.m + 1)}-${pad(days)}`;
  const agenda = useQuery({
    queryKey: ['tender-agenda-month', from],
    queryFn: () => api.request<AgendaItem[]>(`/api/tenant/tender-agenda?from=${from}&to=${to}`),
  });
  const byDay = (agenda.data ?? []).reduce<Record<string, AgendaItem[]>>((g, a) => {
    (g[dayKey(a.at)] ??= []).push(a);
    return g;
  }, {});
  const lead = (first.getDay() + 6) % 7; // Monday first
  const cells = [...Array<null>(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const today = dayKey(now.toISOString());
  const shift = (by: number) =>
    setMonth(({ y, m }) => {
      const d = new Date(y, m + by, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  return (
    <Card
      title={first.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
      actions={
        <div className="flex items-center gap-1">
          {view}
          <button
            type="button"
            className="rounded px-2 py-1 text-sm hover:bg-surface-2"
            onClick={() => shift(-1)}
            aria-label="Previous month"
          >
            ‹
          </button>
          <button
            type="button"
            className="rounded px-2 py-1 text-sm hover:bg-surface-2"
            onClick={() => shift(1)}
            aria-label="Next month"
          >
            ›
          </button>
        </div>
      }
    >
      {agenda.isError && <Alert tone="danger">{describeError(agenda.error)}</Alert>}
      <div
        className="grid grid-cols-7 gap-px overflow-hidden rounded-md border border-line bg-line text-xs"
        role="grid"
        aria-label="Month"
      >
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div
            key={d}
            className="bg-surface-2 px-1.5 py-1 font-medium text-fg-muted"
            role="columnheader"
          >
            {d}
          </div>
        ))}
        {cells.map((d, i) => {
          const key = d ? `${month.y}-${pad(month.m + 1)}-${pad(d)}` : null;
          const items = key ? (byDay[key] ?? []) : [];
          return (
            <div
              key={i}
              role="gridcell"
              aria-label={key ?? undefined}
              className={`min-h-20 bg-surface p-1 ${d ? '' : 'bg-surface-2/50'}`}
            >
              {d && (
                <div
                  className={`mb-0.5 text-right tabular-nums ${key === today ? 'font-bold text-accent' : 'text-fg-muted'}`}
                >
                  {d}
                </div>
              )}
              {items.slice(0, 4).map((a, j) => (
                <Link
                  key={j}
                  to="/tenders/$tenderId"
                  params={{ tenderId: a.tender.id }}
                  title={`${a.label}: ${a.tender.number} · ${a.tender.title}`}
                  className="mb-0.5 block truncate rounded px-1 py-0.5 hover:bg-surface-2"
                >
                  <Badge tone={KIND[a.kind].tone}>{KIND[a.kind].label}</Badge>{' '}
                  <span className="text-fg">{a.tender.number}</span>
                </Link>
              ))}
              {items.length > 4 && (
                <div className="px-1 text-fg-subtle">+{items.length - 4} more</div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function AgendaList({ view }: { view: React.ReactNode }) {
  const [days, setDays] = useState(30);
  const agenda = useQuery({
    queryKey: ['tender-agenda', days],
    queryFn: () => api.request<AgendaItem[]>(`/api/tenant/tender-agenda?days=${days}`),
  });
  const today = dayKey(new Date().toISOString());
  return (
    <Card
      title="Agenda"
      actions={
        <div className="flex items-center gap-2">
          {view}
          <Select
            aria-label="How far ahead"
            className="w-36"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>Next 7 days</option>
            <option value={30}>Next 30 days</option>
            <option value={90}>Next 90 days</option>
          </Select>
        </div>
      }
    >
      {agenda.isPending ? (
        <Spinner />
      ) : agenda.isError ? (
        <Alert tone="danger">{describeError(agenda.error)}</Alert>
      ) : agenda.data.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing due.</p>
      ) : (
        <ol className="space-y-4" aria-label="Agenda">
          {Object.entries(
            agenda.data.reduce<Record<string, AgendaItem[]>>((g, a) => {
              (g[dayKey(a.at)] ??= []).push(a);
              return g;
            }, {}),
          ).map(([day, items]) => (
            <li key={day}>
              <h3
                className={`mb-1 text-xs font-medium uppercase tracking-wide ${day < today ? 'text-danger' : 'text-fg-muted'}`}
              >
                {day === today ? 'Today' : formatDate(`${day}T12:00:00`)}
                {day < today && ' (past)'}
              </h3>
              <ul className="divide-y divide-line text-sm">
                {items.map((a, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 py-1.5">
                    <span className="w-14 text-xs tabular-nums text-fg-muted">
                      {a.allDay
                        ? ''
                        : new Date(a.at).toLocaleTimeString('en-IN', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                    </span>
                    <Badge tone={KIND[a.kind].tone}>{KIND[a.kind].label}</Badge>
                    <span>{a.label}</span>
                    <Link
                      to="/tenders/$tenderId"
                      params={{ tenderId: a.tender.id }}
                      className="min-w-0 truncate text-accent hover:underline"
                    >
                      {a.tender.number} · {a.tender.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

const REASON: Record<string, string> = {
  price: 'Price',
  technical: 'Technical evaluation',
  qualification: 'Qualification',
  documents: 'Documents or EMD',
  scope: 'Scope or terms',
  client: 'Client decision',
  other: 'Other',
  not_recorded: 'Not recorded',
};
const pct = (x: number | null) => (x === null ? '-' : `${x} %`);

function TallyTable({ title, rows }: { title: string; rows: (WinLossTally & { name: string })[] }) {
  return (
    <Card title={title}>
      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing yet.</p>
      ) : (
        <Table minWidth="26rem">
          <thead>
            <tr>
              <th>Name</th>
              <th className="text-right">Bids</th>
              <th className="text-right">Won</th>
              <th className="text-right">Win rate</th>
              <th className="text-right">Won value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="text-right tabular-nums">{r.submitted}</td>
                <td className="text-right tabular-nums">{r.won}</td>
                <td className="text-right tabular-nums">{pct(r.winRatePct)}</td>
                <td className="text-right tabular-nums">{formatInrShort(r.wonValue)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** Win/loss by financial year: win rate, clients, verticals, why we lost, competitors head to head. */
export function WinLossScreen() {
  const [fy, setFy] = useState('');
  const data = useQuery({
    queryKey: ['tender-analysis', fy],
    queryFn: () => api.request<WinLoss>(`/api/tenant/tender-analysis${fy ? `?fy=${fy}` : ''}`),
  });
  return (
    <div className="space-y-5">
      <Link
        to="/tenders"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Tenders
      </Link>
      <PageHeader
        title="Win / loss"
        subtitle="Tenders handed in, by the financial year they were submitted. Values are our bid values."
        actions={
          <Field label="Financial year">
            <Select value={fy} onChange={(e) => setFy(e.target.value)}>
              <option value="">All years</option>
              {(data.data?.years ?? []).map((y) => (
                <option key={y} value={y}>
                  FY {y}
                </option>
              ))}
            </Select>
          </Field>
        }
      />
      {data.isPending ? (
        <Spinner />
      ) : data.isError ? (
        <Alert tone="danger">{describeError(data.error)}</Alert>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6" data-testid="win-loss-totals">
            <Stat label="Bids submitted" value={String(data.data.totals.submitted)} />
            <Stat label="Won" value={String(data.data.totals.won)} />
            <Stat label="Lost" value={String(data.data.totals.lost)} />
            <Stat label="Win rate" value={pct(data.data.totals.winRatePct)} />
            <Stat label="Win rate by value" value={pct(data.data.totals.winRateByValuePct)} />
            <Stat
              label="Average above L1 when not L1"
              value={pct(data.data.position.avgAboveL1Pct)}
            />
          </div>
          <TallyTable title="By client" rows={data.data.byClient} />
          <Card title="Competitors, head to head">
            {data.data.competitors.length === 0 ? (
              <p className="text-sm text-fg-muted">
                Record the bids at each opening to see who you meet and how you compare.
              </p>
            ) : (
              <Table minWidth="40rem">
                <thead>
                  <tr>
                    <th>Competitor</th>
                    <th className="text-right">Met</th>
                    <th className="text-right">Below us</th>
                    <th className="text-right">Above us</th>
                    <th className="text-right">Won</th>
                    <th className="text-right">Their price vs ours</th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.competitors.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td className="text-right tabular-nums">{c.met}</td>
                      <td className="text-right tabular-nums">{c.beatUs}</td>
                      <td className="text-right tabular-nums">{c.weBeat}</td>
                      <td className="text-right tabular-nums">{c.won}</td>
                      <td className="text-right tabular-nums">
                        {c.avgGapPct === null
                          ? '-'
                          : `${c.avgGapPct > 0 ? '+' : ''}${c.avgGapPct} %`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Why we lost">
              {data.data.lossReasons.length === 0 ? (
                <p className="text-sm text-fg-muted">No losses recorded.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {data.data.lossReasons.map((r) => (
                    <li key={r.category} className="flex justify-between">
                      <span>{REASON[r.category] ?? r.category}</span>
                      <span className="tabular-nums">{r.count}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-fg-muted">
                Bids opened with our value known: {data.data.position.opened}; L1 in{' '}
                {data.data.position.l1}.
              </p>
            </Card>
            <TallyTable
              title="By vertical"
              rows={data.data.byVertical.map((r) => ({ ...r, name: VERTICALS[r.name] ?? r.name }))}
            />
          </div>
        </>
      )}
    </div>
  );
}
