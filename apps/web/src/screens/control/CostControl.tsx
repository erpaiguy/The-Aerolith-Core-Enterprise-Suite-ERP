// Cost control (docs/wave4-plan.md step 1), for a project: budget, committed, actual, cost to complete, forecast and
// variance by cost code and WBS element; what is not placed, to allocate; the company's defaults; month closes.
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
import { useState, type ReactNode } from 'react';
import { api, saveFile } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';

const FIELDS = [
  ['original', 'Original'],
  ['changes', 'Changes'],
  ['budget', 'Budget'],
  ['committed', 'Committed'],
  ['actual', 'Actual'],
  ['ctc', 'To complete'],
  ['forecast', 'Forecast'],
  ['variance', 'Variance'],
] as const;
type Figures = Record<(typeof FIELDS)[number][0], string>;
interface Ref {
  id: string;
  code: string;
  name: string;
}
interface Row extends Figures {
  key: string;
  wbs: Ref | null;
  costCode: Ref | null;
  ctcComputed: boolean;
  note: string;
}
interface Node extends Figures {
  id: string;
  code: string;
  name: string;
  depth: number;
}
interface Report {
  baseline: { takenOn: string } | null;
  rows: Row[];
  byCostCode: { nodes: Node[]; none: Figures };
  byWbs: { nodes: Node[]; none: Figures };
  totals: Figures;
  alerts: {
    overBudget: { costCode: Ref; budget: string; exposure: string; over: string }[];
    rates: {
      resource: string;
      unit: string;
      budgetRate: string;
      billedRate: string;
      qty: string;
    }[];
  };
  unallocated: { orderLines: number; ledgerLines: number };
  defaults: { source: string; label: string; costCode: Ref | null; used: boolean }[];
  months: string[];
  compared: { month: string; rows: Record<string, Figures>; totals: Figures } | null;
  mayForecast: boolean;
}
interface Documents {
  orderLines: {
    poId: string;
    number: string;
    party: string;
    lineKey: string;
    description: string;
    amount: string;
    billed: string;
    committed: string;
    how: string;
  }[];
  ledgerLines: {
    voucherId: string;
    position: number;
    number: string;
    date: string;
    account: string;
    note: string;
    billNo: string | null;
    amount: string;
    how: string;
  }[];
}
const HOW: Record<string, string> = {
  allocated: 'allocated',
  voucher: 'on the voucher',
  requisition: 'from the requisition',
  default: 'company default',
  unallocated: 'not placed',
};
const label = (r: Ref | null, none: string) => (r ? `${r.code} ${r.name}` : none);
const money = (v: string) => formatInr(v);
const neg = (v: string) => (Number(v) < 0 ? 'text-danger' : '');

export function CostControlScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useState('');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Cost control"
        subtitle="Budget, committed, actual and forecast by cost code and WBS element."
        actions={
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
        }
      />
      {projectId && <ProjectCost key={projectId} projectId={projectId} />}
    </div>
  );
}

function ProjectCost({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [compare, setCompare] = useState('');
  const key = ['cost-control', projectId, compare];
  const r = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Report>(
        `/api/tenant/projects/${projectId}/cost-control${compare ? `?compare=${compare}` : ''}`,
      ),
  });
  const codes = useQuery({
    queryKey: ['cost-codes'],
    queryFn: () => api.request<(Ref & { active: boolean })[]>('/api/tenant/cost-codes'),
    select: (x) => x.filter((c) => c.active),
  });
  const wbs = useQuery({
    queryKey: ['wbs', projectId],
    queryFn: () =>
      api.request<(Ref & { depth: number })[]>(`/api/tenant/projects/${projectId}/wbs`),
  });
  const [view, setView] = useState<'rows' | 'cost' | 'wbs'>('rows');
  const [open, setOpen] = useState<string | null>(null);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['cost-control', projectId] });
  const call = async (path: string, body: object) => {
    setError(null);
    try {
      await api.request(path, { method: 'POST', body });
      refresh();
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  const base = `/api/tenant/projects/${projectId}/cost-control`;
  const unplaced = d.unallocated.orderLines + d.unallocated.ledgerLines;
  const missing = d.defaults.filter((x) => x.used && !x.costCode);
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card
        title="The project"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Compare with"
              value={compare}
              onChange={(e) => setCompare(e.target.value)}
            >
              <option value="">Compare with a closed month…</option>
              {d.months.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                try {
                  const f = await api.download(`${base}?format=xlsx`);
                  saveFile(f.blob, f.fileName);
                } catch (err) {
                  setError(describeError(err));
                }
              }}
            >
              Excel
            </Button>
          </div>
        }
      >
        <dl className="grid gap-3 text-sm sm:grid-cols-4" data-testid="cost-totals">
          {FIELDS.map(([k, l]) => (
            <div key={k}>
              <dt className="text-xs text-fg-muted">{l}</dt>
              <dd className={`font-medium ${k === 'variance' ? neg(d.totals[k]) : ''}`}>
                {money(d.totals[k])}
                {d.compared && k === 'forecast' && (
                  <span className="block text-xs text-fg-muted">
                    {d.compared.month}: {money(d.compared.totals.forecast)}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-fg-muted">
          {d.baseline
            ? `Original budget taken on ${d.baseline.takenOn}.`
            : 'The original budget is not taken yet: it is the current budget until it is.'}{' '}
          Actual is the ledger&apos;s, as in the project P&amp;L. Forecast is actual plus cost to
          complete.
        </p>
        {d.mayForecast && (
          <div className="mt-3 flex flex-wrap items-end gap-2">
            {!d.baseline && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void call(`${base}/baseline`, {})}
              >
                Take the original budget
              </Button>
            )}
            <Field label="Month">
              <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </Field>
            <Button
              type="button"
              onClick={() => void call(`${base}/months/${month}/close`, {})}
              disabled={!month}
            >
              Close the month
            </Button>
          </div>
        )}
      </Card>

      {(d.alerts.overBudget.length > 0 ||
        d.alerts.rates.length > 0 ||
        unplaced > 0 ||
        missing.length > 0) && (
        <Card title="Needs attention">
          <ul className="space-y-1 text-sm" data-testid="cost-alerts">
            {d.alerts.overBudget.map((a) => (
              <li key={a.costCode.id}>
                <Badge tone="danger">over budget</Badge> {label(a.costCode, '')}: committed and
                spent {money(a.exposure)} against {money(a.budget)}, {money(a.over)} over.
              </li>
            ))}
            {d.alerts.rates.map((a) => (
              <li key={a.resource}>
                <Badge tone="warning">rate</Badge> {a.resource}: billed at {money(a.billedRate)}/
                {a.unit} against {money(a.budgetRate)} in the material budget ({Number(a.qty)}{' '}
                {a.unit}).
              </li>
            ))}
            {unplaced > 0 && (
              <li>
                <Badge tone="warning">not placed</Badge> {d.unallocated.ledgerLines} ledger lines
                and {d.unallocated.orderLines} order lines have no WBS element or cost code: see
                below.
              </li>
            )}
            {missing.length > 0 && (
              <li>
                <Badge tone="neutral">no default</Badge> No cost code is set for{' '}
                {missing.map((m) => m.label.toLowerCase()).join(', ')}.
              </li>
            )}
          </ul>
        </Card>
      )}

      <Card
        title="Cost report"
        actions={
          <Select
            aria-label="View"
            value={view}
            onChange={(e) => setView(e.target.value as typeof view)}
          >
            <option value="rows">By cost code and WBS</option>
            <option value="cost">By cost code</option>
            <option value="wbs">By WBS element</option>
          </Select>
        }
      >
        {view === 'rows' ? (
          <Table minWidth="64rem">
            <thead>
              <tr>
                <th>Cost code</th>
                <th>WBS</th>
                {FIELDS.map(([k, l]) => (
                  <th key={k} className="text-right">
                    {l}
                  </th>
                ))}
                {d.compared && <th className="text-right">Forecast {d.compared.month}</th>}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((x) => (
                <CostRow
                  key={x.key}
                  row={x}
                  then={d.compared ? (d.compared.rows[x.key]?.forecast ?? '0.00') : null}
                  mayForecast={d.mayForecast}
                  open={open === x.key}
                  onOpen={() => setOpen(open === x.key ? null : x.key)}
                  onCtc={(amount, note) => call(`${base}/ctc`, { key: x.key, amount, note })}
                />
              ))}
            </tbody>
          </Table>
        ) : (
          <TreeTable
            tree={view === 'cost' ? d.byCostCode : d.byWbs}
            none={view === 'cost' ? 'No cost code' : 'No WBS element'}
          />
        )}
        {open && view === 'rows' && <RowDocuments projectId={projectId} rowKey={open} />}
      </Card>

      {unplaced > 0 && (
        <Unplaced
          projectId={projectId}
          mayForecast={d.mayForecast}
          codes={codes.data ?? []}
          wbs={wbs.data ?? []}
          onAllocate={(body) => call(`${base}/allocations`, body)}
        />
      )}

      {d.mayForecast && (
        <Card title="Where costs go when nothing else says">
          <p className="mb-2 text-xs text-fg-muted">
            Company-wide. Used after an allocation, a cost code on the voucher and the requisition
            behind an order.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {d.defaults.map((x) => (
              <Field key={x.source} label={x.label}>
                <Select
                  value={x.costCode?.id ?? ''}
                  onChange={(e) =>
                    void call(`/api/tenant/cost-control/defaults/${x.source}`, {
                      costCodeId: e.target.value || null,
                    })
                  }
                >
                  <option value="">Not set</option>
                  {(codes.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function CostRow({
  row,
  then,
  mayForecast,
  open,
  onOpen,
  onCtc,
}: {
  row: Row;
  then: string | null;
  mayForecast: boolean;
  open: boolean;
  onOpen: () => void;
  onCtc: (amount: string | null, note: string) => Promise<boolean>;
}) {
  const [ctc, setCtc] = useState(row.ctcComputed ? '' : row.ctc);
  const name = `${label(row.costCode, 'No cost code')} · ${label(row.wbs, 'No WBS')}`;
  return (
    <tr aria-label={name} className={open ? 'bg-surface-muted' : ''}>
      <td>
        <button
          type="button"
          className="text-left underline-offset-2 hover:underline"
          onClick={onOpen}
        >
          {label(row.costCode, 'No cost code')}
        </button>
      </td>
      <td>{label(row.wbs, '—')}</td>
      {FIELDS.map(([k]) =>
        k === 'ctc' && mayForecast ? (
          <td key={k} className="text-right">
            <form
              className="flex items-center justify-end gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void onCtc(ctc.trim() === '' ? null : ctc.trim(), row.note);
              }}
            >
              <Input
                aria-label={`Cost to complete, ${name}`}
                className="w-28 text-right"
                inputMode="decimal"
                placeholder={row.ctc}
                value={ctc}
                onChange={(e) => setCtc(e.target.value)}
              />
              {row.ctcComputed && <span title="Computed: nothing entered">*</span>}
            </form>
          </td>
        ) : (
          <td key={k} className={`text-right tabular-nums ${k === 'variance' ? neg(row[k]) : ''}`}>
            {money(row[k])}
            {k === 'ctc' && row.ctcComputed && <span title="Computed: nothing entered">*</span>}
          </td>
        ),
      )}
      {then !== null && <td className="text-right tabular-nums">{money(then)}</td>}
    </tr>
  );
}

function TreeTable({ tree, none }: { tree: { nodes: Node[]; none: Figures }; none: string }) {
  const rows = [
    ...tree.nodes,
    ...(FIELDS.some(([k]) => Number(tree.none[k]) !== 0)
      ? [{ ...tree.none, id: '', code: '', name: none, depth: 0 }]
      : []),
  ];
  return (
    <Table minWidth="56rem">
      <thead>
        <tr>
          <th />
          {FIELDS.map(([k, l]) => (
            <th key={k} className="text-right">
              {l}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((n) => (
          <tr key={n.id || 'none'}>
            <td style={{ paddingLeft: `${0.75 + n.depth * 1.25}rem` }}>
              {n.code} {n.name}
            </td>
            {FIELDS.map(([k]) => (
              <td
                key={k}
                className={`text-right tabular-nums ${k === 'variance' ? neg(n[k]) : ''}`}
              >
                {money(n[k])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function RowDocuments({ projectId, rowKey }: { projectId: string; rowKey: string }) {
  const q = useQuery({
    queryKey: ['cost-control-docs', projectId, rowKey],
    queryFn: () =>
      api.request<Documents>(
        `/api/tenant/projects/${projectId}/cost-control/documents?key=${encodeURIComponent(rowKey)}`,
      ),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  return <DocumentLists docs={q.data} />;
}

function DocumentLists({ docs, actions }: { docs: Documents; actions?: (k: string) => ReactNode }) {
  return (
    <div className="mt-3 space-y-3" data-testid="cost-documents">
      {docs.orderLines.length > 0 && (
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>Order</th>
              <th>Line</th>
              <th className="text-right">Ordered</th>
              <th className="text-right">Billed</th>
              <th className="text-right">Committed</th>
              <th>Placed</th>
              {actions && <th />}
            </tr>
          </thead>
          <tbody>
            {docs.orderLines.map((o) => (
              <tr key={`${o.poId}|${o.lineKey}`}>
                <td>
                  {o.number} <span className="text-fg-muted">{o.party}</span>
                </td>
                <td>{o.description}</td>
                <td className="text-right tabular-nums">{money(o.amount)}</td>
                <td className="text-right tabular-nums">{money(o.billed)}</td>
                <td className="text-right tabular-nums">{money(o.committed)}</td>
                <td>{HOW[o.how]}</td>
                {actions && <td>{actions(`o|${o.poId}|${o.lineKey}`)}</td>}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {docs.ledgerLines.length > 0 && (
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>Voucher</th>
              <th>Date</th>
              <th>Ledger</th>
              <th>Note</th>
              <th className="text-right">Amount</th>
              <th>Placed</th>
              {actions && <th />}
            </tr>
          </thead>
          <tbody>
            {docs.ledgerLines.map((l) => (
              <tr key={`${l.voucherId}|${l.position}`}>
                <td>
                  {l.number}
                  {l.billNo && <span className="text-fg-muted"> · bill {l.billNo}</span>}
                </td>
                <td>{l.date}</td>
                <td>{l.account}</td>
                <td>{l.note}</td>
                <td className="text-right tabular-nums">{money(l.amount)}</td>
                <td>{HOW[l.how]}</td>
                {actions && <td>{actions(`l|${l.voucherId}|${l.position}`)}</td>}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {docs.orderLines.length === 0 && docs.ledgerLines.length === 0 && (
        <p className="text-sm text-fg-muted">Nothing behind this row but its budget.</p>
      )}
    </div>
  );
}

function Unplaced({
  projectId,
  mayForecast,
  codes,
  wbs,
  onAllocate,
}: {
  projectId: string;
  mayForecast: boolean;
  codes: Ref[];
  wbs: (Ref & { depth: number })[];
  onAllocate: (body: object) => Promise<boolean>;
}) {
  const qc = useQueryClient();
  const key = ['cost-control-docs', projectId, 'unallocated'];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<Documents>(
        `/api/tenant/projects/${projectId}/cost-control/documents?unallocated=true`,
      ),
  });
  const [picked, setPicked] = useState<Record<string, { wbsId: string; costCodeId: string }>>({});
  return (
    <Card title="Not placed">
      <p className="text-xs text-fg-muted">
        Costs with nothing to say where they belong. Place each on a WBS element, a cost code or
        both.
      </p>
      {q.data && (
        <DocumentLists
          docs={q.data}
          {...(mayForecast
            ? {
                actions: (k: string) => {
                  const p = picked[k] ?? { wbsId: '', costCodeId: '' };
                  const set = (v: Partial<typeof p>) =>
                    setPicked({ ...picked, [k]: { ...p, ...v } });
                  const [kind, a, b] = k.split('|') as [string, string, string];
                  return (
                    <form
                      aria-label="Place this cost"
                      className="flex gap-1"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const ok = await onAllocate({
                          target:
                            kind === 'o'
                              ? { poId: a, lineKey: b }
                              : { voucherId: a, position: Number(b) },
                          wbsId: p.wbsId || null,
                          costCodeId: p.costCodeId || null,
                        });
                        if (ok) void qc.invalidateQueries({ queryKey: key });
                      }}
                    >
                      <Select
                        aria-label="WBS element"
                        value={p.wbsId}
                        onChange={(e) => set({ wbsId: e.target.value })}
                      >
                        <option value="">WBS…</option>
                        {wbs.map((w) => (
                          <option key={w.id} value={w.id}>
                            {'  '.repeat(w.depth)}
                            {w.code} {w.name}
                          </option>
                        ))}
                      </Select>
                      <Select
                        aria-label="Cost code"
                        value={p.costCodeId}
                        onChange={(e) => set({ costCodeId: e.target.value })}
                      >
                        <option value="">Cost code…</option>
                        {codes.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.code} {c.name}
                          </option>
                        ))}
                      </Select>
                      <Button
                        type="submit"
                        variant="secondary"
                        disabled={!p.wbsId && !p.costCodeId}
                      >
                        Place
                      </Button>
                    </form>
                  );
                },
              }
            : {})}
        />
      )}
    </Card>
  );
}
