// Contracts and claims (docs/wave4-plan.md step 5), for a project: the calendar of dated duties, the contracts with
// their securities, obligations and notices, extensions of time from the daily reports' hindrances, and claims.
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
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import type { ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError, formatInr } from '../../lib/format';

interface Reg {
  contracts: {
    id: string;
    kind: string;
    party: string | null;
    reference: string;
    title: string;
    value: string;
    completionOn: string | null;
    dlpEnds: string | null;
    status: string;
  }[];
  securities: {
    id: string;
    contractId: string;
    kind: string;
    issuer: string;
    number: string;
    amount: string;
    validUntil: string;
    status: string;
    rowVersion: number;
  }[];
  obligations: {
    id: string;
    contractId: string;
    title: string;
    clause: string;
    dueOn: string;
    doneOn: string | null;
  }[];
  notices: {
    id: string;
    contractId: string;
    direction: string;
    subject: string;
    dated: string;
    reference: string;
    replyBy: string | null;
    repliedOn: string | null;
  }[];
  eots: {
    id: string;
    contractId: string;
    number: string;
    from: string;
    to: string;
    basis: { byCause: Record<string, number> };
    daysClaimed: number;
    status: string;
    daysGranted: number | null;
  }[];
  claims: {
    id: string;
    contractId: string;
    number: string;
    kind: string;
    title: string;
    amount: string;
    status: string;
    settledAmount: string | null;
  }[];
  calendar: {
    date: string;
    what: string;
    kind: string;
    contract: string;
    amount: string | null;
    overdue: boolean;
  }[];
  mayKeep: boolean;
}
const label = (s: string) => s.replace(/_/g, ' ');
const TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'accent'> = {
  held: 'accent',
  returned: 'neutral',
  invoked: 'danger',
  granted: 'success',
  rejected: 'danger',
  submitted: 'accent',
  draft: 'neutral',
  negotiation: 'warning',
  settled: 'success',
};

export function ContractsScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useState('');
  return (
    <div className="space-y-5">
      <PageHeader
        title="Contracts and claims"
        subtitle="Contracts, securities, obligations, notices, extensions of time and claims."
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
      {projectId && <ProjectContracts key={projectId} projectId={projectId} />}
    </div>
  );
}

function ProjectContracts({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['contracts', projectId];
  const r = useQuery({
    queryKey: key,
    queryFn: () => api.request<Reg>(`/api/tenant/projects/${projectId}/contracts`),
  });
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [c, setC] = useState({
    kind: 'client',
    reference: '',
    title: '',
    value: '',
    completionOn: '',
    dlpMonths: '12',
  });
  const call = async (path: string, body: object) => {
    setError(null);
    try {
      await api.request(path, { method: 'POST', body });
      void qc.invalidateQueries({ queryKey: key });
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  const current = d.contracts.find((x) => x.id === (chosen ?? d.contracts[0]?.id));
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Calendar">
        {d.calendar.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing dated yet.</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="contract-calendar">
            {d.calendar.map((x, i) => (
              <li key={i} className={x.overdue ? 'text-danger' : ''}>
                <span className="tabular-nums">{x.date}</span> · {x.what} ({x.contract})
                {x.amount && ` · ${formatInr(x.amount)}`}
                {x.overdue && ' · overdue'}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Contracts"
        actions={
          d.contracts.length > 1 ? (
            <Select
              aria-label="Contract"
              value={current?.id ?? ''}
              onChange={(e) => setChosen(e.target.value)}
            >
              {d.contracts.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.reference}
                </option>
              ))}
            </Select>
          ) : undefined
        }
      >
        {d.contracts.length > 0 && (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Party</th>
                <th className="text-right">Value</th>
                <th>Completion</th>
                <th>DLP ends</th>
              </tr>
            </thead>
            <tbody>
              {d.contracts.map((x) => (
                <tr key={x.id} aria-label={x.reference}>
                  <td>
                    {x.reference} <span className="text-fg-muted">{x.title}</span>
                  </td>
                  <td>{x.party ?? ''}</td>
                  <td className="text-right tabular-nums">{formatInr(x.value)}</td>
                  <td>{x.completionOn ?? ''}</td>
                  <td>{x.dlpEnds ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {d.mayKeep && (
          <form
            aria-label="New contract"
            className="mt-3 grid gap-3 sm:grid-cols-6"
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              if (
                await call(`/api/tenant/projects/${projectId}/contracts`, {
                  kind: c.kind,
                  reference: c.reference,
                  title: c.title,
                  value: c.value || '0',
                  completionOn: c.completionOn || null,
                  dlpMonths: Number(c.dlpMonths || 0),
                })
              )
                setC({ ...c, reference: '', title: '', value: '' });
            }}
          >
            <Field label="Kind">
              <Select value={c.kind} onChange={(e) => setC({ ...c, kind: e.target.value })}>
                <option value="client">With the client</option>
                <option value="subcontract">Subcontract</option>
              </Select>
            </Field>
            <Field label="Reference">
              <Input
                value={c.reference}
                onChange={(e) => setC({ ...c, reference: e.target.value })}
                required
              />
            </Field>
            <Field label="Title">
              <Input
                value={c.title}
                onChange={(e) => setC({ ...c, title: e.target.value })}
                required
                minLength={3}
              />
            </Field>
            <Field label="Value (₹)">
              <Input
                inputMode="decimal"
                value={c.value}
                onChange={(e) => setC({ ...c, value: e.target.value })}
              />
            </Field>
            <Field label="Completion">
              <Input
                type="date"
                value={c.completionOn}
                onChange={(e) => setC({ ...c, completionOn: e.target.value })}
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit">Add the contract</Button>
            </div>
          </form>
        )}
      </Card>

      {current && <ContractDetail key={current.id} reg={d} contractId={current.id} call={call} />}
    </>
  );
}

function ContractDetail({
  reg,
  contractId,
  call,
}: {
  reg: Reg;
  contractId: string;
  call: (path: string, body: object) => Promise<boolean>;
}) {
  const mine = <T extends { contractId: string }>(xs: T[]) =>
    xs.filter((x) => x.contractId === contractId);
  const [sec, setSec] = useState({
    kind: 'performance',
    issuer: '',
    number: '',
    amount: '',
    validUntil: '',
  });
  const [ob, setOb] = useState({ title: '', clause: '', dueOn: '' });
  const [nt, setNt] = useState({
    direction: 'received',
    subject: '',
    dated: today(),
    reference: '',
    replyBy: '',
  });
  const [period, setPeriod] = useState({ from: '', to: '' });
  const [cl, setCl] = useState({ kind: 'prolongation', title: '', amount: '' });
  const [decide, setDecide] = useState<
    Record<string, { days: string; reference: string; amount: string }>
  >({});
  const basis = useQuery({
    queryKey: ['eot-basis', contractId, period],
    enabled: !!period.from && !!period.to,
    queryFn: () =>
      api.request<{ days: number; byCause: Record<string, number> }>(
        `/api/tenant/contracts/${contractId}/eot-basis?from=${period.from}&to=${period.to}`,
      ),
  });
  const base = `/api/tenant/contracts/${contractId}`;
  return (
    <>
      <Card title="Securities">
        {mine(reg.securities).length > 0 && (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>What</th>
                <th className="text-right">Amount</th>
                <th>Valid until</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {mine(reg.securities).map((s) => (
                <tr key={s.id} aria-label={`${label(s.kind)} ${s.number}`}>
                  <td>
                    {label(s.kind)} {s.number} <span className="text-fg-muted">{s.issuer}</span>
                  </td>
                  <td className="text-right tabular-nums">{formatInr(s.amount)}</td>
                  <td>{s.validUntil}</td>
                  <td>
                    <Badge tone={TONE[s.status] ?? 'neutral'}>{s.status}</Badge>
                  </td>
                  <td>
                    {reg.mayKeep && s.status === 'held' && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          void call(`/api/tenant/contract-securities/${s.id}`, {
                            validUntil: s.validUntil,
                            status: 'returned',
                            rowVersion: s.rowVersion,
                          })
                        }
                      >
                        Returned
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {reg.mayKeep && (
          <form
            aria-label="New security"
            className="mt-3 grid gap-3 sm:grid-cols-6"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await call(`${base}/securities`, sec))
                setSec({ ...sec, number: '', amount: '', validUntil: '' });
            }}
          >
            <Field label="Kind">
              <Select value={sec.kind} onChange={(e) => setSec({ ...sec, kind: e.target.value })}>
                {['performance', 'advance', 'retention_bond', 'insurance', 'other'].map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Issuer">
              <Input
                value={sec.issuer}
                onChange={(e) => setSec({ ...sec, issuer: e.target.value })}
              />
            </Field>
            <Field label="Number">
              <Input
                value={sec.number}
                onChange={(e) => setSec({ ...sec, number: e.target.value })}
              />
            </Field>
            <Field label="Amount (₹)">
              <Input
                inputMode="decimal"
                value={sec.amount}
                onChange={(e) => setSec({ ...sec, amount: e.target.value })}
                required
              />
            </Field>
            <Field label="Valid until">
              <Input
                type="date"
                value={sec.validUntil}
                onChange={(e) => setSec({ ...sec, validUntil: e.target.value })}
                required
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit">Add</Button>
            </div>
          </form>
        )}
        <p className="mt-2 text-xs text-fg-muted">
          The project&apos;s leads are reminded 30 and 7 days before a held security expires.
        </p>
      </Card>

      <Card title="Obligations and notices">
        <ul className="space-y-1 text-sm">
          {mine(reg.obligations).map((o) => (
            <li key={o.id}>
              {o.dueOn} · {o.title}{' '}
              {o.clause && <span className="text-fg-muted">({o.clause})</span>}{' '}
              {o.doneOn ? (
                <Badge tone="success">done {o.doneOn}</Badge>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void call(`/api/tenant/obligations/${o.id}/done`, { on: today() })}
                >
                  Done
                </Button>
              )}
            </li>
          ))}
          {mine(reg.notices).map((n) => (
            <li key={n.id}>
              {n.dated} · {n.direction} · {n.subject}{' '}
              <span className="text-fg-muted">{n.reference}</span>
              {n.replyBy && !n.repliedOn && ` · reply by ${n.replyBy}`}
              {n.repliedOn && <Badge tone="success">replied {n.repliedOn}</Badge>}
              {n.replyBy && !n.repliedOn && reg.mayKeep && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void call(`/api/tenant/notices/${n.id}/replied`, { on: today() })}
                >
                  Replied
                </Button>
              )}
            </li>
          ))}
        </ul>
        <form
          aria-label="New obligation"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await call(`${base}/obligations`, ob)) setOb({ title: '', clause: '', dueOn: '' });
          }}
        >
          <Field label="Obligation">
            <Input
              value={ob.title}
              onChange={(e) => setOb({ ...ob, title: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <Field label="Clause">
            <Input value={ob.clause} onChange={(e) => setOb({ ...ob, clause: e.target.value })} />
          </Field>
          <Field label="Due">
            <Input
              type="date"
              value={ob.dueOn}
              onChange={(e) => setOb({ ...ob, dueOn: e.target.value })}
              required
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit">Add</Button>
          </div>
        </form>
        {reg.mayKeep && (
          <form
            aria-label="New notice"
            className="mt-3 grid gap-3 sm:grid-cols-6"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await call(`${base}/notices`, { ...nt, replyBy: nt.replyBy || null }))
                setNt({ ...nt, subject: '', reference: '', replyBy: '' });
            }}
          >
            <Field label="Notice">
              <Select
                value={nt.direction}
                onChange={(e) => setNt({ ...nt, direction: e.target.value })}
              >
                <option value="received">Received</option>
                <option value="sent">Sent</option>
              </Select>
            </Field>
            <Field label="Subject">
              <Input
                value={nt.subject}
                onChange={(e) => setNt({ ...nt, subject: e.target.value })}
                required
                minLength={3}
              />
            </Field>
            <Field label="Dated">
              <Input
                type="date"
                value={nt.dated}
                onChange={(e) => setNt({ ...nt, dated: e.target.value })}
                required
              />
            </Field>
            <Field label="Their reference">
              <Input
                value={nt.reference}
                onChange={(e) => setNt({ ...nt, reference: e.target.value })}
              />
            </Field>
            <Field label="Reply by">
              <Input
                type="date"
                value={nt.replyBy}
                onChange={(e) => setNt({ ...nt, replyBy: e.target.value })}
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit">Record</Button>
            </div>
          </form>
        )}
      </Card>

      <Card title="Extensions of time">
        <ul className="space-y-1 text-sm">
          {mine(reg.eots).map((e) => (
            <li key={e.id}>
              {e.number} · {e.from} to {e.to} · {e.daysClaimed} days claimed (
              {Object.entries(e.basis.byCause)
                .map(([k, v]) => `${label(k)} ${v}`)
                .join(', ') || 'typed'}
              ) <Badge tone={TONE[e.status] ?? 'neutral'}>{e.status}</Badge>
              {e.daysGranted !== null && ` ${e.daysGranted} days granted`}
              {reg.mayKeep && e.status === 'draft' && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void call(`/api/tenant/eots/${e.id}`, { action: 'submit' })}
                >
                  Submit
                </Button>
              )}
              {reg.mayKeep && e.status === 'submitted' && (
                <span className="ml-2 inline-flex gap-1">
                  <Input
                    aria-label={`Days granted, ${e.number}`}
                    className="w-20"
                    value={decide[e.id]?.days ?? ''}
                    onChange={(x) =>
                      setDecide({
                        ...decide,
                        [e.id]: {
                          ...(decide[e.id] ?? { reference: '', amount: '' }),
                          days: x.target.value,
                        },
                      })
                    }
                  />
                  <Input
                    aria-label={`Client's reference, ${e.number}`}
                    className="w-32"
                    value={decide[e.id]?.reference ?? ''}
                    onChange={(x) =>
                      setDecide({
                        ...decide,
                        [e.id]: {
                          ...(decide[e.id] ?? { days: '', amount: '' }),
                          reference: x.target.value,
                        },
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void call(`/api/tenant/eots/${e.id}`, {
                        action: 'decide',
                        daysGranted: Number(decide[e.id]?.days || 0),
                        reference: decide[e.id]?.reference || '-',
                        date: today(),
                      })
                    }
                  >
                    Decided
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {reg.mayKeep && (
          <form
            aria-label="New extension of time"
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await call(`${base}/eots`, period)) setPeriod({ from: '', to: '' });
            }}
          >
            <Field label="Hindrances from">
              <Input
                type="date"
                value={period.from}
                onChange={(e) => setPeriod({ ...period, from: e.target.value })}
                required
              />
            </Field>
            <Field label="To">
              <Input
                type="date"
                value={period.to}
                onChange={(e) => setPeriod({ ...period, to: e.target.value })}
                required
              />
            </Field>
            {basis.data && (
              <span className="text-sm" data-testid="eot-basis">
                {basis.data.days} days lost
                {Object.keys(basis.data.byCause).length > 0 &&
                  ` (${Object.entries(basis.data.byCause)
                    .map(([k, v]) => `${label(k)} ${v}`)
                    .join(', ')})`}
              </span>
            )}
            <Button type="submit">Claim the extension</Button>
          </form>
        )}
        <p className="mt-2 text-xs text-fg-muted">
          A day counts once when the client&apos;s and neutral hindrances in the daily reports add
          up to 4 hours or more.
        </p>
      </Card>

      <Card title="Claims">
        <ul className="space-y-1 text-sm">
          {mine(reg.claims).map((x) => (
            <li key={x.id}>
              {x.number} · {label(x.kind)} · {x.title} · {formatInr(x.amount)}{' '}
              <Badge tone={TONE[x.status] ?? 'neutral'}>{x.status}</Badge>
              {x.settledAmount && ` settled for ${formatInr(x.settledAmount)}`}
              {reg.mayKeep && x.status === 'draft' && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    void call(`/api/tenant/claims/${x.id}/status`, { status: 'submitted' })
                  }
                >
                  Submit
                </Button>
              )}
              {reg.mayKeep && (x.status === 'submitted' || x.status === 'negotiation') && (
                <span className="ml-2 inline-flex gap-1">
                  <Input
                    aria-label={`Settled amount, ${x.number}`}
                    className="w-28"
                    value={decide[x.id]?.amount ?? ''}
                    onChange={(e) =>
                      setDecide({
                        ...decide,
                        [x.id]: { days: '', reference: '', amount: e.target.value },
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      void call(`/api/tenant/claims/${x.id}/status`, {
                        status: 'settled',
                        settledAmount: decide[x.id]?.amount || '0',
                        date: today(),
                      })
                    }
                  >
                    Settled
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {reg.mayKeep && (
          <form
            aria-label="New claim"
            className="mt-3 grid gap-3 sm:grid-cols-4"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await call(`${base}/claims`, cl)) setCl({ ...cl, title: '', amount: '' });
            }}
          >
            <Field label="Claim for">
              <Select value={cl.kind} onChange={(e) => setCl({ ...cl, kind: e.target.value })}>
                {['idle_resources', 'prolongation', 'escalation', 'other'].map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="What">
              <Input
                value={cl.title}
                onChange={(e) => setCl({ ...cl, title: e.target.value })}
                required
                minLength={3}
              />
            </Field>
            <Field label="Amount (₹)">
              <Input
                inputMode="decimal"
                value={cl.amount}
                onChange={(e) => setCl({ ...cl, amount: e.target.value })}
                required
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit">Add the claim</Button>
            </div>
          </form>
        )}
      </Card>
    </>
  );
}
