// Safety inspections (docs/wave7-plan.md step 7d.5): site walks with the safety checklist filled on them, what they
// found, who is to put each finding right and by when, and its closure. Owners see their open findings in their work.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Spinner,
  Table,
  Textarea,
  toast,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import type { ProjectDetail } from '../api/types';
import { describeError } from '../lib/format';
import { shortDate } from '../schedule/model';

type Severity = 'low' | 'medium' | 'high';
interface List {
  walks: {
    id: string;
    number: string;
    walkedOn: string;
    area: string;
    walkedBy: string;
    findings: number;
    open: number;
    openHigh: number;
  }[];
  checklists: { id: string; template: string; doneOn: string; location: string; result: string }[];
  mayWrite: boolean;
}
interface Walk {
  id: string;
  number: string;
  walkedOn: string;
  area: string;
  walkedBy: string;
  note: string;
  projectId: string;
  checklist: string | null;
  checklistResult: string | null;
  recordedBy: string | null;
  status: 'open' | 'closed';
  findings: {
    id: string;
    position: number;
    observation: string;
    severity: Severity;
    action: string;
    ownerId: string;
    owner: string;
    dueOn: string;
    status: 'open' | 'closed';
    closedOn: string | null;
    closure: string;
    overdue: boolean;
  }[];
  mayManage: boolean;
  me: string;
}
const today = () => new Date().toISOString().slice(0, 10);
const tone = { low: 'neutral', medium: 'warning', high: 'danger' } as const;

export function SiteWalksScreen({ projectId }: { projectId: string }) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const list = useQuery({
    queryKey: ['site-walks', projectId],
    queryFn: () => api.request<List>(`/api/tenant/projects/${projectId}/site-walks`),
  });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHeader
        title="Safety inspections"
        subtitle={project.data ? `${project.data.number} · ${project.data.name}` : undefined}
        actions={
          list.data?.mayWrite && !adding ? (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden /> Record a site walk
            </Button>
          ) : null
        }
      />
      {adding && project.data && list.data ? (
        <NewWalk
          project={project.data}
          checklists={list.data.checklists}
          onDone={(id) => {
            setAdding(false);
            setOpen(id);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {open ? <WalkCard id={open} /> : null}
      <Card title="Site walks">
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="danger">{describeError(list.error)}</Alert>
        ) : list.data.walks.length === 0 ? (
          <EmptyState title="No site walk recorded yet.">
            Record each safety walk with what was found; each finding goes to its owner to close.
          </EmptyState>
        ) : (
          <Table minWidth="40rem">
            <thead>
              <tr>
                <th>Walk</th>
                <th>On</th>
                <th>By</th>
                <th className="text-right">Findings open</th>
              </tr>
            </thead>
            <tbody aria-label="Site walks">
              {list.data.walks.map((w) => (
                <tr key={w.id}>
                  <td>
                    <button
                      type="button"
                      className="text-left hover:underline"
                      onClick={() => setOpen(w.id)}
                    >
                      <span className="font-mono text-xs">{w.number}</span> {w.area}
                    </button>
                  </td>
                  <td>{shortDate(w.walkedOn)}</td>
                  <td>{w.walkedBy}</td>
                  <td className="text-right">
                    {w.open} of {w.findings}
                    {w.openHigh ? (
                      <span className="ml-1">
                        <Badge tone="danger">{w.openHigh} high</Badge>
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function NewWalk({
  project,
  checklists,
  onDone,
  onCancel,
}: {
  project: ProjectDetail;
  checklists: List['checklists'];
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({
    walkedOn: today(),
    area: '',
    walkedBy: '',
    checklistId: '',
    note: '',
  });
  const [findings, setFindings] = useState<
    { observation: string; severity: Severity; action: string; ownerId: string; dueOn: string }[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const edit = (i: number, k: keyof (typeof findings)[number], v: string) =>
    setFindings(findings.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  return (
    <Card title="Record a site walk">
      <form
        aria-label="Record a site walk"
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          void api
            .request<Walk>(`/api/tenant/projects/${project.id}/site-walks`, {
              method: 'POST',
              body: {
                ...f,
                checklistId: f.checklistId || null,
                findings: findings.filter((x) => x.observation.trim()),
              },
            })
            .then((w) => {
              toast.success(`Site walk ${w.number} recorded`);
              void qc.invalidateQueries({ queryKey: ['site-walks', project.id] });
              void qc.invalidateQueries({ queryKey: ['my-work'] });
              onDone(w.id);
            })
            .catch((err: unknown) => setError(describeError(err)));
        }}
      >
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Area walked">
            <Input value={f.area} onChange={set('area')} required minLength={2} />
          </Field>
          <Field label="Walked on">
            <Input type="date" value={f.walkedOn} onChange={set('walkedOn')} required />
          </Field>
          <Field label="Walked by">
            <Input value={f.walkedBy} onChange={set('walkedBy')} />
          </Field>
        </div>
        <Field label="Safety checklist filled">
          <Select value={f.checklistId} onChange={set('checklistId')}>
            <option value="">None</option>
            {checklists.map((c) => (
              <option key={c.id} value={c.id}>
                {c.template} · {shortDate(c.doneOn)} · {c.location} ({c.result})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note">
          <Textarea rows={2} value={f.note} onChange={set('note')} />
        </Field>
        {findings.map((x, i) => (
          <fieldset
            key={i}
            aria-label={`Finding ${i + 1}`}
            className="grid gap-3 rounded border border-line p-2 md:grid-cols-[2fr_8rem_2fr_1fr_10rem]"
          >
            <Field label="Seen">
              <Input
                value={x.observation}
                onChange={(e) => edit(i, 'observation', e.target.value)}
              />
            </Field>
            <Field label="Severity">
              <Select value={x.severity} onChange={(e) => edit(i, 'severity', e.target.value)}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            </Field>
            <Field label="To do">
              <Input value={x.action} onChange={(e) => edit(i, 'action', e.target.value)} />
            </Field>
            <Field label="Owner">
              <Select value={x.ownerId} onChange={(e) => edit(i, 'ownerId', e.target.value)}>
                {project.team.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="By">
              <Input
                type="date"
                value={x.dueOn}
                onChange={(e) => edit(i, 'dueOn', e.target.value)}
              />
            </Field>
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              setFindings([
                ...findings,
                {
                  observation: '',
                  severity: 'medium',
                  action: '',
                  ownerId: project.team[0]?.userId ?? '',
                  dueOn: today(),
                },
              ])
            }
          >
            Add a finding
          </Button>
          <Button type="submit">Save the walk</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </form>
    </Card>
  );
}

export function WalkCard({ id }: { id: string }) {
  const qc = useQueryClient();
  const key = ['site-walk', id];
  const w = useQuery({
    queryKey: key,
    queryFn: () => api.request<Walk>(`/api/tenant/site-walks/${id}`),
  });
  const [closing, setClosing] = useState<string | null>(null);
  const [closure, setClosure] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (w.isPending) return <Spinner />;
  if (w.isError) return <Alert tone="danger">{describeError(w.error)}</Alert>;
  const x = w.data;
  const close = async (findingId: string) => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<Walk>(`/api/tenant/walk-findings/${findingId}/close`, {
          method: 'POST',
          body: { closedOn: today(), closure },
        }),
      );
      toast.success('Finding closed');
      setClosing(null);
      setClosure('');
      void qc.invalidateQueries({ queryKey: ['site-walks', x.projectId] });
      void qc.invalidateQueries({ queryKey: ['my-work'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title={`${x.number} ${x.area}`}>
      <p className="mb-2 text-sm text-fg-muted">
        {shortDate(x.walkedOn)}
        {x.walkedBy ? ` · ${x.walkedBy}` : ''}
        {x.recordedBy ? ` · recorded by ${x.recordedBy}` : ''} ·{' '}
        <Badge tone={x.status === 'closed' ? 'success' : 'warning'}>{x.status}</Badge>
      </p>
      {x.checklist ? (
        <p className="text-sm">
          Checklist: {x.checklist} ({x.checklistResult})
        </p>
      ) : null}
      {x.note ? <p className="mt-1 whitespace-pre-wrap text-sm">{x.note}</p> : null}
      {x.findings.length ? (
        <ul className="mt-3 divide-y divide-line text-sm" aria-label="Findings">
          {x.findings.map((f) => (
            <li key={f.id} className="py-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={tone[f.severity]}>{f.severity}</Badge>
                <span className="flex-1">
                  {f.observation}
                  {f.action ? <span className="text-fg-muted"> — {f.action}</span> : null}
                </span>
                <span className={f.overdue ? 'font-medium text-danger' : 'text-fg-muted'}>
                  {f.owner} · by {shortDate(f.dueOn)}
                </span>
                {f.status === 'closed' ? (
                  <Badge tone="success">closed</Badge>
                ) : f.ownerId === x.me || x.mayManage ? (
                  <Button variant="secondary" onClick={() => setClosing(f.id)}>
                    Close
                  </Button>
                ) : (
                  <Badge tone="warning">open</Badge>
                )}
              </div>
              {f.status === 'closed' ? (
                <div className="text-xs text-fg-muted">
                  {shortDate(f.closedOn!)}: {f.closure}
                </div>
              ) : closing === f.id ? (
                <form
                  aria-label="Close the finding"
                  className="mt-1 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void close(f.id);
                  }}
                >
                  <Input
                    aria-label="What was done"
                    value={closure}
                    onChange={(e) => setClosure(e.target.value)}
                    required
                    minLength={2}
                  />
                  <Button type="submit">Closed</Button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">Nothing found.</p>
      )}
      {error ? <Alert tone="danger">{error}</Alert> : null}
    </Card>
  );
}
