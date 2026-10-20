// Variations (docs/wave4-plan.md step 4), for a project: the register with what is executed but not approved; a
// variation raised and priced (new items, changed quantities), submitted, and the client's decision recorded.
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
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';
import { useProjectParam } from '../../lib/project-param';
import { useFocusForm, useNewParam } from '../../lib/new-param';
import { printLink } from '../../print/Letterhead';

interface Register {
  variations: {
    id: string;
    number: string;
    title: string;
    status: string;
    value: string;
    cost: string;
    approvedValue: string | null;
    executedNotApproved: boolean;
  }[];
  totals: Record<string, { count: number; value: string }>;
  atRisk: string;
  billPending: boolean;
  deviationLimitPct: number;
  mayDecide: boolean;
}
interface Variation {
  id: string;
  number: string;
  title: string;
  status: string;
  statusReason: string | null;
  value: string;
  cost: string;
  approvedValue: string | null;
  clientRef: string | null;
  startedOn: string | null;
  rowVersion: number;
  lines: {
    position: number;
    kind: 'new' | 'change';
    code: string;
    description: string;
    unit: string;
    qty: string;
    rate: string;
    costRate: string;
    value: string;
    cost: string;
    approvedQty: string | null;
    approvedRate: string | null;
  }[];
}
interface Analysis {
  id: string;
  code: string;
  description: string;
}
const TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'accent'> = {
  approved: 'success',
  rejected: 'danger',
  submitted: 'accent',
  pending: 'warning',
  draft: 'neutral',
  withdrawn: 'neutral',
};
const SOURCES = [
  ['client_instruction', 'Client instruction'],
  ['site_condition', 'Site condition'],
  ['design_change', 'Design change'],
  ['other', 'Other'],
] as const;
const num = (v: string) => String(Number(v));
const blank = () => ({
  kind: 'new' as 'new' | 'change',
  code: '',
  description: '',
  unit: '',
  qty: '',
  rate: '',
  costRate: '',
  rateAnalysisId: '',
});

export function VariationsScreen() {
  useFocusForm('Raise a variation', useNewParam('variation'));
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useProjectParam();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Variations"
        subtitle="Changes to the contract: priced, approved inside and by the client, carried into the BOQ and budget."
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
      {projectId && <ProjectVariations key={projectId} projectId={projectId} />}
    </div>
  );
}

function ProjectVariations({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['variations', projectId];
  const r = useQuery({
    queryKey: key,
    queryFn: () => api.request<Register>(`/api/tenant/projects/${projectId}/variations`),
  });
  const analyses = useQuery({
    queryKey: ['rate-analyses'],
    queryFn: () => api.request<Analysis[] | { items: Analysis[] }>('/api/tenant/rate-analyses'),
    select: (x) => (Array.isArray(x) ? x : x.items),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    source: 'client_instruction',
    instructionRef: '',
    reason: '',
  });
  const [lines, setLines] = useState([blank()]);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['variations'] });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  const setLine = (i: number, v: Partial<ReturnType<typeof blank>>) =>
    setLines(lines.map((l, j) => (j === i ? { ...l, ...v } : l)));
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Register">
        <dl className="mb-3 grid gap-3 text-sm sm:grid-cols-4" data-testid="vo-totals">
          {Object.entries(d.totals).map(([status, t]) => (
            <div key={status}>
              <dt className="text-xs text-fg-muted">
                {status} ({t.count})
              </dt>
              <dd className="font-medium">{formatInr(t.value)}</dd>
            </div>
          ))}
          <div>
            <dt className="text-xs text-fg-muted">Executed, not approved</dt>
            <dd className={`font-medium ${Number(d.atRisk) ? 'text-danger' : ''}`}>
              {formatInr(d.atRisk)}
            </dd>
          </div>
        </dl>
        {d.variations.length > 0 && (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>No.</th>
                <th>What</th>
                <th>Status</th>
                <th className="text-right">Value</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Approved</th>
              </tr>
            </thead>
            <tbody>
              {d.variations.map((v) => (
                <tr key={v.id} aria-label={v.number}>
                  <td>
                    <button
                      type="button"
                      className="underline-offset-2 hover:underline"
                      onClick={() => setOpen(open === v.id ? null : v.id)}
                    >
                      {v.number}
                    </button>
                  </td>
                  <td>{v.title}</td>
                  <td>
                    <Badge tone={TONE[v.status] ?? 'neutral'}>{v.status}</Badge>
                    {v.executedNotApproved && <Badge tone="danger">executed, not approved</Badge>}
                  </td>
                  <td className="text-right tabular-nums">{formatInr(v.value)}</td>
                  <td className="text-right tabular-nums">{formatInr(v.cost)}</td>
                  <td className="text-right tabular-nums">
                    {v.approvedValue ? formatInr(v.approvedValue) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {d.mayDecide && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={d.billPending}
              onChange={async (e) => {
                try {
                  await api.request(`/api/tenant/projects/${projectId}/variations/settings`, {
                    method: 'POST',
                    body: { billPending: e.target.checked },
                  });
                  toast.success('Variation settings saved');
                  refresh();
                } catch (err) {
                  setError(describeError(err));
                }
              }}
            />
            The contract lets variations be billed while the client&apos;s approval is pending
          </label>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <Link
            to="/print/deviation-statement/$projectId"
            params={{ projectId }}
            className={printLink}
          >
            Deviation statement
          </Link>
          {d.mayDecide && (
            <label className="flex items-center gap-2">
              Deviation limit %
              <input
                type="number"
                min={0}
                max={1000}
                step="0.01"
                className="w-20 rounded-md border border-line bg-surface px-2 py-1"
                defaultValue={d.deviationLimitPct}
                onBlur={async (e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v) || v === d.deviationLimitPct) return;
                  try {
                    await api.request(`/api/tenant/projects/${projectId}/variations/settings`, {
                      method: 'POST',
                      body: { deviationLimitPct: v },
                    });
                    toast.success('Deviation limit saved');
                    refresh();
                  } catch (err) {
                    setError(describeError(err));
                  }
                }}
              />
            </label>
          )}
        </div>
      </Card>

      {open && <Detail key={open} id={open} mayDecide={d.mayDecide} onChange={refresh} />}

      <Card title="Raise a variation">
        <form
          aria-label="Raise a variation"
          className="space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              const v = await api.request<{ id: string }>(
                `/api/tenant/projects/${projectId}/variations`,
                {
                  method: 'POST',
                  body: {
                    ...form,
                    lines: lines.map((l) => ({
                      kind: l.kind,
                      code: l.code,
                      description: l.description,
                      unit: l.unit,
                      qty: l.qty,
                      rate: l.rate || null,
                      costRate: l.costRate || null,
                      rateAnalysisId: l.rateAnalysisId || null,
                    })),
                  },
                },
              );
              setForm({ title: '', source: 'client_instruction', instructionRef: '', reason: '' });
              setLines([blank()]);
              toast.success(`Variation ${form.title} raised`);
              refresh();
              setOpen(v.id);
            } catch (err) {
              setError(describeError(err));
            }
          }}
        >
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="What">
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                required
                minLength={3}
              />
            </Field>
            <Field label="Source">
              <Select
                value={form.source}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
              >
                {SOURCES.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Instruction ref.">
              <Input
                value={form.instructionRef}
                onChange={(e) => setForm({ ...form, instructionRef: e.target.value })}
              />
            </Field>
            <Field label="Why">
              <Input
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
              />
            </Field>
          </div>
          {lines.map((l, i) => (
            <fieldset
              key={i}
              aria-label={`Variation line ${i + 1}`}
              className="grid gap-2 sm:grid-cols-8"
            >
              <Select
                aria-label="Kind"
                value={l.kind}
                onChange={(e) => setLine(i, { kind: e.target.value as 'new' | 'change' })}
              >
                <option value="new">New item</option>
                <option value="change">Change a contract item</option>
              </Select>
              <Input
                aria-label="Code"
                placeholder="Code"
                value={l.code}
                onChange={(e) => setLine(i, { code: e.target.value })}
                required
              />
              <Input
                aria-label="Description"
                placeholder="Description"
                value={l.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
              />
              <Input
                aria-label="Unit"
                placeholder="Unit"
                value={l.unit}
                onChange={(e) => setLine(i, { unit: e.target.value })}
              />
              <Input
                aria-label="Quantity"
                placeholder="Qty (+/−)"
                inputMode="decimal"
                value={l.qty}
                onChange={(e) => setLine(i, { qty: e.target.value })}
                required
              />
              <Select
                aria-label="Rate analysis"
                value={l.rateAnalysisId}
                onChange={(e) => setLine(i, { rateAnalysisId: e.target.value })}
              >
                <option value="">No analysis</option>
                {(analyses.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.description}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Cost rate"
                placeholder="Cost rate"
                inputMode="decimal"
                value={l.costRate}
                onChange={(e) => setLine(i, { costRate: e.target.value })}
              />
              <Input
                aria-label="Rate"
                placeholder="Contract rate"
                inputMode="decimal"
                value={l.rate}
                onChange={(e) => setLine(i, { rate: e.target.value })}
              />
            </fieldset>
          ))}
          <p className="text-xs text-fg-muted">
            A changed item takes its contract and budget rates. A new item&apos;s contract rate is
            its cost rate (from the analysis or typed) with the project&apos;s markup, unless typed.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={() => setLines([...lines, blank()])}>
              Add a line
            </Button>
            <Button type="submit">Raise</Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function Detail({
  id,
  mayDecide,
  onChange,
}: {
  id: string;
  mayDecide: boolean;
  onChange: () => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['variation', id],
    queryFn: () => api.request<Variation>(`/api/tenant/variations/${id}`),
  });
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState({ reference: '', date: today() });
  const [given, setGiven] = useState<Record<number, { qty?: string; rate?: string }>>({});
  const confirm = useConfirm();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const v = q.data;
  const call = async (path: string, body: object = {}, done?: string) => {
    setError(null);
    try {
      await api.request(path, { method: 'POST', body });
      if (done) toast.success(done);
      void qc.invalidateQueries({ queryKey: ['variation', id] });
      onChange();
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title={`${v.number} ${v.title}`}>
      {error && <Alert tone="danger">{error}</Alert>}
      {v.statusReason && v.status === 'draft' && (
        <Alert tone="warning">Returned: {v.statusReason}</Alert>
      )}
      <Table minWidth="48rem">
        <thead>
          <tr>
            <th>Item</th>
            <th className="text-right">Qty</th>
            <th className="text-right">Rate</th>
            <th className="text-right">Value</th>
            <th className="text-right">Cost</th>
            {v.status === 'submitted' && mayDecide && <th>Client allows</th>}
            {v.status === 'approved' && <th className="text-right">Approved</th>}
          </tr>
        </thead>
        <tbody>
          {v.lines.map((l) => (
            <tr key={l.position} aria-label={l.code}>
              <td>
                {l.kind === 'new' ? 'New ' : 'Change '}
                {l.code} {l.description} <span className="text-fg-muted">{l.unit}</span>
              </td>
              <td className="text-right tabular-nums">{num(l.qty)}</td>
              <td className="text-right tabular-nums">{formatInr(l.rate)}</td>
              <td className="text-right tabular-nums">{formatInr(l.value)}</td>
              <td className="text-right tabular-nums">{formatInr(l.cost)}</td>
              {v.status === 'submitted' && mayDecide && (
                <td className="flex gap-1">
                  <Input
                    aria-label={`Allowed quantity, ${l.code}`}
                    className="w-24"
                    placeholder={num(l.qty)}
                    value={given[l.position]?.qty ?? ''}
                    onChange={(e) =>
                      setGiven({
                        ...given,
                        [l.position]: { ...given[l.position], qty: e.target.value },
                      })
                    }
                  />
                  <Input
                    aria-label={`Allowed rate, ${l.code}`}
                    className="w-24"
                    placeholder={num(l.rate)}
                    value={given[l.position]?.rate ?? ''}
                    onChange={(e) =>
                      setGiven({
                        ...given,
                        [l.position]: { ...given[l.position], rate: e.target.value },
                      })
                    }
                  />
                </td>
              )}
              {v.status === 'approved' && (
                <td className="text-right tabular-nums">
                  {num(l.approvedQty ?? l.qty)} × {formatInr(l.approvedRate ?? l.rate)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="mt-2 text-sm">
        Value {formatInr(v.value)}, cost {formatInr(v.cost)}
        {v.approvedValue && `; approved ${formatInr(v.approvedValue)} (${v.clientRef})`}.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        {v.status === 'draft' && (
          <Button
            type="button"
            onClick={() =>
              void call(
                `/api/tenant/variations/${id}/submit`,
                { rowVersion: v.rowVersion },
                `${v.number} submitted`,
              )
            }
          >
            Submit
          </Button>
        )}
        {['draft', 'pending', 'submitted'].includes(v.status) && (
          <>
            <Field label="Work started on">
              <Input
                type="date"
                value={v.startedOn ?? ''}
                onChange={(e) =>
                  void call(
                    `/api/tenant/variations/${id}/started`,
                    { on: e.target.value || null },
                    'Start date saved',
                  )
                }
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              onClick={async () => {
                if (
                  !(await confirm({
                    title: `Withdraw ${v.number}?`,
                    body: 'The variation is withdrawn and goes no further.',
                    confirmLabel: 'Withdraw the variation',
                    tone: 'danger',
                  }))
                )
                  return;
                void call(`/api/tenant/variations/${id}/withdraw`, {}, `${v.number} withdrawn`);
              }}
            >
              Withdraw
            </Button>
          </>
        )}
      </div>
      {v.status === 'submitted' && mayDecide && (
        <form
          aria-label="The client's decision"
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => e.preventDefault()}
        >
          <Field label="Client's reference">
            <Input
              value={client.reference}
              onChange={(e) => setClient({ ...client, reference: e.target.value })}
            />
          </Field>
          <Field label="Date">
            <Input
              type="date"
              value={client.date}
              onChange={(e) => setClient({ ...client, date: e.target.value })}
            />
          </Field>
          <Button
            type="button"
            disabled={!client.reference}
            onClick={() =>
              void call(
                `/api/tenant/variations/${id}/client`,
                {
                  decision: 'approved',
                  ...client,
                  rowVersion: v.rowVersion,
                  lines: Object.entries(given).map(([p, g]) => ({
                    position: Number(p),
                    ...(g.qty ? { qty: g.qty } : {}),
                    ...(g.rate ? { rate: g.rate } : {}),
                  })),
                },
                `${v.number} recorded as approved by the client`,
              )
            }
          >
            Approved by the client
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!client.reference}
            onClick={async () => {
              if (
                !(await confirm({
                  title: `Record ${v.number} as rejected?`,
                  body: `The client's rejection (${client.reference}) is recorded and the variation closes.`,
                  confirmLabel: 'Record the rejection',
                  tone: 'danger',
                }))
              )
                return;
              void call(
                `/api/tenant/variations/${id}/client`,
                { decision: 'rejected', ...client, rowVersion: v.rowVersion },
                `${v.number} recorded as rejected by the client`,
              );
            }}
          >
            Rejected by the client
          </Button>
        </form>
      )}
    </Card>
  );
}
