// A project's BOQs on its page (docs/wave2a-plan.md step 2): the contract BOQ and budget made from the won tender
// (contract at the quoted rates, optionally priced to the negotiated contract value; budget at the estimate rates),
// the list of the project's BOQs, and the budget against the contract with the planned margin.
import { Alert, Badge, Button, Card, Field, Input, Select, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api/client';
import type {
  BoqCopyPreview,
  BoqSummary,
  ProjectBoq,
  ProjectBreakdown,
  ProjectDetail,
} from '../api/types';
import { BOQ_KIND_LABEL } from '../boq/model';
import { describeError, formatDateTime, formatInr } from '../lib/format';
import { usePermission } from '../session/permissions';

const STATUS_LABEL = { draft: 'draft', locked: 'locked', submitted: 'submitted' } as const;
const pctOf = (scale: string) => `${(Number(scale) * 100).toFixed(2)}%`;
/** As the API refuses: contract values that would scale rates up, or below half. */
const scalable = (scale: string | null) =>
  scale !== null && Number(scale) >= 0.5 && Number(scale) <= 1.001;

export function ProjectBoqs({ project: p }: { project: ProjectDetail }) {
  const canEditBoq = usePermission('boq.edit');
  const canCopy = canEditBoq && p.canEdit;
  const canAdd = canEditBoq && (p.canEdit || p.myRole === 'member');
  const base = `/api/tenant/projects/${p.id}`;
  const boqs = useQuery({
    queryKey: ['project-boqs', p.id],
    queryFn: () => api.request<ProjectBoq[]>(`${base}/boqs`),
  });
  const summary = useQuery({
    queryKey: ['project-boq-summary', p.id],
    queryFn: () => api.request<BoqSummary>(`${base}/boq-summary`),
  });
  if (boqs.isPending) return <Spinner />;
  if (boqs.isError) return <Alert tone="danger">{describeError(boqs.error)}</Alert>;
  const fromTender = boqs.data.some((b) => b.sourceBoqId);
  return (
    <>
      {p.tenderId && !fromTender && <CopyFromTender project={p} canCopy={canCopy} />}
      <Card title={`BOQs (${boqs.data.length})`} actions={canAdd && <NewBoq projectId={p.id} />}>
        {boqs.data.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {p.tenderId
              ? 'None yet. Make the contract BOQ and budget from the won tender, above.'
              : 'None yet. Add a contract BOQ and a budget, then import or type their lines.'}
          </p>
        ) : (
          <Table minWidth="30rem">
            <thead>
              <tr>
                <th>BOQ</th>
                <th>Kind</th>
                <th>Version</th>
                <th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {boqs.data.map((b) => (
                <tr key={b.id}>
                  <td>
                    <Link
                      to="/boqs/$boqId"
                      params={{ boqId: b.id }}
                      className="text-accent hover:underline"
                    >
                      {b.name}
                    </Link>
                    {b.sourceName && (
                      <div className="text-xs text-fg-muted">
                        From {b.sourceName}, version {b.sourceVersionNo}
                        {b.rateBasis?.unsubmitted ? ' (never submitted)' : ''}
                        {b.kind === 'contract' && b.rateBasis && Number(b.rateBasis.scale) !== 1
                          ? ` · rates at ${pctOf(b.rateBasis.scale)} of quoted`
                          : ''}
                      </div>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    <Badge tone={b.kind === 'contract' ? 'accent' : 'neutral'}>
                      {BOQ_KIND_LABEL[b.kind]}
                    </Badge>
                    {b.archivedAt && <Badge tone="danger">Archived</Badge>}
                  </td>
                  <td className="whitespace-nowrap text-fg-muted">
                    {b.versionNo} · {STATUS_LABEL[b.status]}
                  </td>
                  <td className="text-right tabular-nums">{formatInr(b.total)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {summary.data && summary.data.contracts > 0 && <Margin s={summary.data} />}
      {boqs.data.length > 0 && <WbsSummary projectId={p.id} />}
    </>
  );
}

/** The won tender's BOQs, what copying them gives, and the copy (run in the background, polled here). */
function CopyFromTender({ project: p, canCopy }: { project: ProjectDetail; canCopy: boolean }) {
  const qc = useQueryClient();
  const [match, setMatch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useQuery({
    // The contract value changes the scale: asked again when it is edited.
    queryKey: ['project-boq-copy', p.id, p.contractValue],
    queryFn: () => api.request<BoqCopyPreview>(`/api/tenant/projects/${p.id}/boqs/from-tender`),
    refetchInterval: (q) => (q.state.data?.copy?.status === 'copying' ? 2000 : false),
  });
  const copying = preview.data?.copy?.status === 'copying';
  const finished = preview.data?.copy?.status === 'done';
  // Once the copy is done, the BOQs and the margin are there to show (and this card goes).
  useEffect(() => {
    if (!finished) return;
    void qc.invalidateQueries({ queryKey: ['project-boqs', p.id] });
    void qc.invalidateQueries({ queryKey: ['project-boq-summary', p.id] });
    void qc.invalidateQueries({ queryKey: ['project', p.id] });
  }, [finished, qc, p.id]);
  if (preview.isPending) return <Spinner />;
  if (preview.isError) return <Alert tone="danger">{describeError(preview.error)}</Alert>;
  const d = preview.data;
  if (!d.sources.length)
    return (
      <Card title="Contract BOQ and budget">
        <p className="text-sm text-fg-muted">
          The tender has no BOQ to copy. Add the project&apos;s BOQs below.
        </p>
      </Card>
    );
  const differs = d.scale !== null && Number(d.scale) !== 1;
  const canScale = differs && scalable(d.scale);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.request(`/api/tenant/projects/${p.id}/boqs/from-tender`, {
        method: 'POST',
        body: { matchContractValue: canScale && match },
      });
      await preview.refetch();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Contract BOQ and budget">
      <p className="mb-3 text-sm text-fg-muted">
        Each BOQ of the won tender becomes two: the <strong>contract BOQ</strong> at the rates
        quoted to the client (provisional sums as they are), and the <strong>budget</strong> at the
        estimate rates. Both from the version submitted.
      </p>
      <Table minWidth="30rem">
        <thead>
          <tr>
            <th>Tender BOQ</th>
            <th>Version</th>
            <th className="text-right">Quoted</th>
            <th className="text-right">Estimate</th>
          </tr>
        </thead>
        <tbody>
          {d.sources.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>
                {s.submitted ? (
                  `${s.version} (submitted)`
                ) : (
                  <span className="text-warning">{s.version}, never submitted</span>
                )}
              </td>
              <td className="text-right tabular-nums">{formatInr(s.quotedTotal)}</td>
              <td className="text-right tabular-nums">{formatInr(s.estimateTotal)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <dl className="mt-3 grid grid-cols-[11rem_1fr] gap-y-1 text-sm">
        <dt className="text-fg-muted">Quoted, before GST</dt>
        <dd className="tabular-nums">{formatInr(d.quotedTotal)}</dd>
        <dt className="text-fg-muted">Contract value</dt>
        <dd className="tabular-nums">{formatInr(d.contractValue)}</dd>
      </dl>
      {differs && canScale && (
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={match}
            disabled={!canCopy || copying}
            onChange={(e) => setMatch(e.target.checked)}
          />
          <span>
            Price the contract BOQ to the contract value: every quoted rate (not provisional sums)
            at {pctOf(d.scale!)}.
          </span>
        </label>
      )}
      {differs && !canScale && (
        <Alert tone="warning">
          The contract value is{' '}
          {Number(d.scale) > 1
            ? 'above the quoted total (does it include GST?)'
            : 'under half the quoted total'}
          . The contract BOQ will be at the quoted rates; correct the contract value to price it to
          that instead.
        </Alert>
      )}
      {d.copy?.status === 'failed' && <Alert tone="danger">{d.copy.error}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="mt-4 flex items-center gap-3">
        {canCopy ? (
          <Button onClick={() => void start()} disabled={busy || copying}>
            {copying ? 'Copying…' : 'Make the contract BOQ and budget'}
          </Button>
        ) : (
          <p className="text-sm text-fg-muted">
            The project&apos;s lead (or someone who edits projects and BOQs) makes them.
          </p>
        )}
        {copying && d.copy && (
          <span className="text-sm text-fg-muted" role="status">
            Started {formatDateTime(d.copy.startedAt)}. A large BOQ takes a few minutes.
          </span>
        )}
      </div>
    </Card>
  );
}

function NewBoq({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'contract' | 'budget'>('contract');
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Plus className="size-4" aria-hidden /> New BOQ
      </Button>
    );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request(`/api/tenant/projects/${projectId}/boqs`, {
        method: 'POST',
        body: { name, kind },
      });
      setOpen(false);
      setName('');
      void qc.invalidateQueries({ queryKey: ['project-boqs', projectId] });
      void qc.invalidateQueries({ queryKey: ['project-boq-summary', projectId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-wrap items-end gap-2">
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
      </Field>
      <Field label="Kind">
        <Select value={kind} onChange={(e) => setKind(e.target.value as 'contract' | 'budget')}>
          <option value="contract">Contract BOQ</option>
          <option value="budget">Budget</option>
        </Select>
      </Field>
      <Button type="submit">Add</Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  );
}

/** How far the project's BOQ lines are mapped to the WBS and cost codes, with the way to the WBS screen. */
function WbsSummary({ projectId }: { projectId: string }) {
  const d = useQuery({
    queryKey: ['project-breakdown', projectId],
    queryFn: () => api.request<ProjectBreakdown>(`/api/tenant/projects/${projectId}/breakdown`),
  });
  const items = d.data?.totals.contract.lines ?? 0;
  return (
    <Card
      title="WBS and cost codes"
      actions={
        <Link
          to="/projects/$projectId/wbs"
          params={{ projectId }}
          className="text-sm text-accent hover:underline"
        >
          Open the WBS
        </Link>
      }
    >
      {d.data && (
        <p className="text-sm text-fg-muted">
          {d.data.wbs.length === 0
            ? 'No WBS yet. Make it from the contract BOQ, or by hand.'
            : `${d.data.wbs.length} WBS elements. `}
          {items > 0 &&
            `Of ${items.toLocaleString('en-IN')} contract items, ${(items - d.data.unmapped.wbs.contract.lines).toLocaleString('en-IN')} are mapped to the WBS and ${(items - d.data.unmapped.costCode.contract.lines).toLocaleString('en-IN')} to cost codes.`}
        </p>
      )}
    </Card>
  );
}

/** Budget against contract: the planned margin overall and by top-level section. */
function Margin({ s }: { s: BoqSummary }) {
  const tone = (m: string | null) =>
    m === null ? '' : Number(m) < 0 ? 'text-danger' : Number(m) > 0 ? 'text-success' : '';
  return (
    <Card title="Budget against contract">
      <dl className="grid grid-cols-[11rem_1fr] gap-y-1 text-sm" aria-label="Planned margin">
        <dt className="text-fg-muted">Contract BOQs</dt>
        <dd className="tabular-nums">{formatInr(s.contract)}</dd>
        <dt className="text-fg-muted">Budget</dt>
        <dd className="tabular-nums">{s.budgets ? formatInr(s.budget) : 'No budget yet'}</dd>
        <dt className="text-fg-muted">Planned margin</dt>
        <dd className={`tabular-nums font-medium ${tone(s.margin)}`}>
          {s.margin === null
            ? '-'
            : `${formatInr(s.margin)}${s.marginPct ? ` (${s.marginPct}%)` : ''}`}
        </dd>
      </dl>
      {s.boqs
        .filter((b) => b.lines.length > 0)
        .map((b) => (
          <div key={b.contractId} className="mt-4">
            <h3 className="mb-2 text-sm font-medium">{b.name}</h3>
            <Table minWidth="30rem">
              <thead>
                <tr>
                  <th>Section</th>
                  <th className="text-right">Contract</th>
                  <th className="text-right">Budget</th>
                  <th className="text-right">Margin</th>
                </tr>
              </thead>
              <tbody>
                {b.lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {l.code && <span className="mr-2 font-mono text-xs">{l.code}</span>}
                      {l.description}
                    </td>
                    <td className="text-right tabular-nums">{formatInr(l.contract)}</td>
                    <td className="text-right tabular-nums">{formatInr(l.budget)}</td>
                    <td className={`text-right tabular-nums ${tone(l.margin)}`}>
                      {formatInr(l.margin)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ))}
    </Card>
  );
}
