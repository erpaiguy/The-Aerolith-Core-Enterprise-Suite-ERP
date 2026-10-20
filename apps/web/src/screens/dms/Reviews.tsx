// Document reviews (docs/wave5-plan.md step 1): what is waiting on me, a project's review workflows and its reviews,
// and one review's stages, reviewers and codes. Reviewers answer with a status code; the worst code at a stage wins.
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
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, saveFile } from '../../api/client';
import type { DocVault, ProjectDetail, ProjectSummary } from '../../api/types';
import { describeError } from '../../lib/format';
import { MarkupViewer } from './MarkupViewer';

type Effect = 'approve' | 'approve_comments' | 'return' | 'reject';
interface Code {
  code: string;
  label: string;
  effect: Effect;
  active: boolean;
}
type Reviewer = { kind: 'user' | 'lead' | 'member' | 'designation'; id?: string };
interface Stage {
  name: string;
  mode: 'all' | 'any';
  dueDays: number;
  reviewers: Reviewer[];
}
interface Workflow {
  id: string;
  projectId: string | null;
  name: string;
  stages: Stage[];
}
interface Row {
  id: string;
  number: string;
  title: string;
  document: string;
  versionNo: number;
  status: string;
  withComments: boolean;
  stageName: string | null;
  startedOn: string;
  waitingOn: string | null;
}
interface Mine {
  taskId: string;
  reviewId: string;
  number: string;
  title: string;
  project: string;
  document: string;
  versionNo: number;
  stageName: string;
  dueOn: string;
  overdue: boolean;
}
interface Detail {
  id: string;
  projectId: string;
  number: string;
  title: string;
  document: { id: string; name: string; versionNo: number };
  stages: { name: string; mode: string; dueDays: number }[];
  stage: number;
  status: string;
  withComments: boolean;
  tasks: {
    id: string;
    stage: number;
    reviewer: string;
    dueOn: string;
    status: string;
    code: string | null;
    comment: string | null;
    overdue: boolean;
  }[];
  mine: string[];
  mayWithdraw: boolean;
}

const tone = (s: string) =>
  s === 'approved'
    ? 'success'
    : s === 'rejected'
      ? 'danger'
      : s === 'returned' || s === 'withdrawn'
        ? 'warning'
        : 'accent';
const statusText = (s: string, withComments: boolean) =>
  s === 'approved' && withComments ? 'approved with comments' : s.replace('_', ' ');

export function ReviewsScreen() {
  const qc = useQueryClient();
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const mine = useQuery({
    queryKey: ['reviews', 'mine'],
    queryFn: () => api.request<Mine[]>('/api/tenant/reviews/mine'),
  });
  const [projectId, setProjectId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const call = async <T,>(path: string, body: object, done?: string) => {
    setError(null);
    try {
      const r = await api.request<T>(path, { method: 'POST', body });
      if (done) toast.success(done);
      void qc.invalidateQueries({ queryKey: ['reviews'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      return r;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Reviews"
        subtitle="Document reviews in stages: reviewers answer with a code, the worst code at a stage decides."
        actions={
          <Select
            aria-label="Project"
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setOpen(null);
            }}
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
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Waiting on me">
        {mine.isPending ? (
          <Spinner />
        ) : (mine.data ?? []).length === 0 ? (
          <EmptyState title="Nothing waiting on you">
            Reviews that need your code appear here when their stage reaches you.
          </EmptyState>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="reviews-mine">
            {mine.data!.map((m) => (
              <li key={m.taskId}>
                <button
                  type="button"
                  className="text-left underline"
                  onClick={() => setOpen(m.reviewId)}
                >
                  {m.number} {m.title}
                </button>{' '}
                <span className="text-fg-muted">
                  {m.project} · {m.document} rev {m.versionNo} · {m.stageName} · due {m.dueOn}
                </span>{' '}
                {m.overdue && <Badge tone="danger">overdue</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {open && <ReviewDetail key={open} id={open} call={call} onError={setError} />}
      {projectId && (
        <ProjectReviews key={projectId} projectId={projectId} call={call} onOpen={setOpen} />
      )}
    </div>
  );
}

type Call = <T>(path: string, body: object, done?: string) => Promise<T | null>;

function ReviewDetail({
  id,
  call,
  onError,
}: {
  id: string;
  call: Call;
  onError: (e: string | null) => void;
}) {
  const q = useQuery({
    queryKey: ['reviews', 'one', id],
    queryFn: () => api.request<Detail>(`/api/tenant/reviews/${id}`),
  });
  const codes = useQuery({
    queryKey: ['review-codes'],
    queryFn: () => api.request<Code[]>('/api/tenant/review-codes'),
  });
  const [code, setCode] = useState('');
  const [comment, setComment] = useState('');
  const [markup, setMarkup] = useState(false);
  const confirm = useConfirm();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{describeError(q.error)}</Alert>;
  const d = q.data;
  const active = (codes.data ?? []).filter((c) => c.active);
  return (
    <Card title={`${d.number} ${d.title}`}>
      <p className="text-sm" data-testid="review-status">
        {d.document.name} rev {d.document.versionNo} ·{' '}
        <Badge tone={tone(d.status)}>{statusText(d.status, d.withComments)}</Badge>
        {d.status === 'in_review' && ` · stage ${d.stage + 1}: ${d.stages[d.stage]?.name}`}
      </p>
      <ol className="mt-3 space-y-2 text-sm">
        {d.stages.map((s, i) => (
          <li key={i}>
            <span className="font-medium">
              {i + 1}. {s.name}
            </span>{' '}
            <span className="text-fg-muted">
              ({s.mode === 'all' ? 'everyone answers' : 'the first answer decides'}, {s.dueDays}{' '}
              days)
            </span>
            <ul className="ml-4">
              {d.tasks
                .filter((t) => t.stage === i)
                .map((t) => (
                  <li key={t.id} aria-label={`${s.name}, ${t.reviewer}`}>
                    {t.reviewer}:{' '}
                    {t.status === 'done' ? (
                      <>
                        <Badge tone="neutral">{t.code}</Badge> {t.comment}
                      </>
                    ) : t.status === 'skipped' ? (
                      <span className="text-fg-muted">not needed</span>
                    ) : (
                      <span className={t.overdue ? 'text-danger' : 'text-fg-muted'}>
                        waiting, due {t.dueOn}
                      </span>
                    )}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ol>
      {d.mine.length > 0 && (
        <form
          aria-label="Respond"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            onError(null);
            if (
              await call(
                `/api/tenant/review-tasks/${d.mine[0]}/respond`,
                { code, comment },
                `Responded to ${d.number} with code ${code}`,
              )
            ) {
              setCode('');
              setComment('');
            }
          }}
        >
          <Field label="Code">
            <Select value={code} onChange={(e) => setCode(e.target.value)} required>
              <option value="">Choose…</option>
              {active.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}: {c.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Comment">
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
            </Field>
          </div>
          <div className="flex items-end">
            <Button type="submit">Respond</Button>
          </div>
        </form>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => setMarkup(!markup)}>
          {markup ? 'Close the mark-up' : 'Mark up the document'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={async () => {
            onError(null);
            try {
              const f = await api.download(`/api/tenant/reviews/${d.id}/comment-sheet`);
              saveFile(f.blob, f.fileName);
            } catch (err) {
              onError(describeError(err));
            }
          }}
        >
          Comment sheet
        </Button>
        {d.mayWithdraw && (
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              if (
                !(await confirm({
                  title: `Withdraw review ${d.number}?`,
                  body: 'The review stops at its current stage and the reviewers no longer see it.',
                  confirmLabel: 'Withdraw the review',
                  tone: 'danger',
                }))
              )
                return;
              void call(`/api/tenant/reviews/${d.id}/withdraw`, {}, `Review ${d.number} withdrawn`);
            }}
          >
            Withdraw
          </Button>
        )}
        {d.status === 'returned' && (
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              void call(
                `/api/tenant/reviews/${d.id}/resubmit`,
                { versionNo: null },
                `Review ${d.number} resubmitted`,
              )
            }
          >
            Resubmit the latest revision
          </Button>
        )}
      </div>
      {markup && (
        <div className="mt-4">
          <MarkupViewer
            documentId={d.document.id}
            versionNo={d.document.versionNo}
            reviewId={d.id}
            mayAdd={d.status === 'in_review'}
          />
        </div>
      )}
    </Card>
  );
}

function ProjectReviews({
  projectId,
  call,
  onOpen,
}: {
  projectId: string;
  call: Call;
  onOpen: (id: string) => void;
}) {
  const reviews = useQuery({
    queryKey: ['reviews', 'project', projectId],
    queryFn: () => api.request<Row[]>(`/api/tenant/projects/${projectId}/reviews`),
  });
  const workflows = useQuery({
    queryKey: ['reviews', 'workflows', projectId],
    queryFn: () => api.request<Workflow[]>(`/api/tenant/review-workflows?projectId=${projectId}`),
  });
  const vault = useQuery({
    queryKey: ['reviews', 'vault', projectId],
    queryFn: () => api.request<DocVault>(`/api/tenant/projects/${projectId}/documents`),
  });
  const [form, setForm] = useState({ documentId: '', workflowId: '', title: '' });
  return (
    <>
      <Card title="Reviews">
        {reviews.isPending ? (
          <Spinner />
        ) : (reviews.data ?? []).length === 0 ? (
          <EmptyState title="No reviews yet">
            Start one below: pick a document and the workflow it goes through.
          </EmptyState>
        ) : (
          <Table minWidth="52rem">
            <thead>
              <tr>
                <th>Number</th>
                <th>Document</th>
                <th>Status</th>
                <th>Stage</th>
                <th>Waiting on</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {reviews.data!.map((r) => (
                <tr key={r.id} aria-label={r.number}>
                  <td>
                    <button type="button" className="underline" onClick={() => onOpen(r.id)}>
                      {r.number}
                    </button>{' '}
                    {r.title}
                  </td>
                  <td>
                    {r.document} rev {r.versionNo}
                  </td>
                  <td>
                    <Badge tone={tone(r.status)}>{statusText(r.status, r.withComments)}</Badge>
                  </td>
                  <td>{r.status === 'in_review' ? r.stageName : '—'}</td>
                  <td>{r.waitingOn ?? '—'}</td>
                  <td>{r.startedOn}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <form
          aria-label="Start a review"
          className="mt-3 grid gap-3 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await call<{ id: string }>(
              `/api/tenant/projects/${projectId}/reviews`,
              { ...form, versionNo: null },
              'Review started',
            );
            if (r) {
              setForm({ documentId: '', workflowId: form.workflowId, title: '' });
              onOpen(r.id);
            }
          }}
        >
          <Field label="Document">
            <Select
              value={form.documentId}
              onChange={(e) => setForm({ ...form, documentId: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {(vault.data?.documents ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} (rev {d.versionNo})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Workflow">
            <Select
              value={form.workflowId}
              onChange={(e) => setForm({ ...form, workflowId: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {(workflows.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title">
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit">Start review</Button>
          </div>
        </form>
      </Card>
      <WorkflowCard
        projectId={projectId}
        workflows={workflows.data ?? []}
        call={call}
        onSaved={() => void workflows.refetch()}
      />
    </>
  );
}

function WorkflowCard({
  projectId,
  workflows,
  call,
  onSaved,
}: {
  projectId: string;
  workflows: Workflow[];
  call: Call;
  onSaved: () => void;
}) {
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const designations = useQuery({
    queryKey: ['designations'],
    queryFn: () =>
      api.request<{ id: string; name: string }[]>('/api/tenant/hr/designations').catch(() => []),
  });
  const blank = (): Stage => ({ name: '', mode: 'all', dueDays: 7, reviewers: [] });
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'project' | 'company'>('project');
  const [stages, setStages] = useState<Stage[]>([blank()]);
  const team = project.data?.team ?? [];
  const label = (r: Reviewer) =>
    r.kind === 'lead'
      ? 'Project lead'
      : r.kind === 'member'
        ? 'Project members'
        : r.kind === 'user'
          ? (team.find((m) => m.userId === r.id)?.displayName ?? 'A user')
          : (designations.data?.find((x) => x.id === r.id)?.name ?? 'A designation');
  const set = (i: number, s: Partial<Stage>) =>
    setStages(stages.map((x, j) => (j === i ? { ...x, ...s } : x)));
  return (
    <Card title="Review workflows">
      <ul className="space-y-1 text-sm" data-testid="review-workflows">
        {workflows.map((w) => (
          <li key={w.id}>
            <span className="font-medium">{w.name}</span>{' '}
            <span className="text-fg-muted">
              {w.projectId ? 'this project' : 'company-wide'} ·{' '}
              {w.stages.map((s) => s.name).join(' → ')}
            </span>
          </li>
        ))}
        {workflows.length === 0 && (
          <li>
            <EmptyState title="None yet">
              Name a workflow and its stages below; reviews then follow it.
            </EmptyState>
          </li>
        )}
      </ul>
      <form
        aria-label="New workflow"
        className="mt-3 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await call(
            '/api/tenant/review-workflows',
            { id: null, projectId: scope === 'project' ? projectId : null, name, stages },
            `Workflow ${name} saved`,
          );
          if (r) {
            setName('');
            setStages([blank()]);
            onSaved();
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Workflow name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          </Field>
          <Field label="For">
            <Select
              value={scope}
              onChange={(e) => setScope(e.target.value as 'project' | 'company')}
            >
              <option value="project">This project</option>
              <option value="company">Every project</option>
            </Select>
          </Field>
        </div>
        {stages.map((s, i) => (
          <fieldset
            key={i}
            aria-label={`Stage ${i + 1}`}
            className="grid gap-3 rounded border border-border p-3 sm:grid-cols-5"
          >
            <Field label="Stage name">
              <Input value={s.name} onChange={(e) => set(i, { name: e.target.value })} required />
            </Field>
            <Field label="Who decides">
              <Select
                value={s.mode}
                onChange={(e) => set(i, { mode: e.target.value as 'all' | 'any' })}
              >
                <option value="all">Everyone answers</option>
                <option value="any">The first answer</option>
              </Select>
            </Field>
            <Field label="Days to answer">
              <Input
                type="number"
                min={0}
                max={90}
                value={s.dueDays}
                onChange={(e) => set(i, { dueDays: Number(e.target.value) })}
              />
            </Field>
            <Field label="Add reviewer">
              <Select
                value=""
                onChange={(e) => {
                  const [kind, id] = e.target.value.split(':') as [Reviewer['kind'], string?];
                  if (!kind) return;
                  const r: Reviewer = id ? { kind, id } : { kind };
                  if (!s.reviewers.some((x) => x.kind === r.kind && x.id === r.id))
                    set(i, { reviewers: [...s.reviewers, r] });
                }}
              >
                <option value="">Choose…</option>
                <option value="lead">Project lead</option>
                <option value="member">Project members</option>
                {team.map((m) => (
                  <option key={m.userId} value={`user:${m.userId}`}>
                    {m.displayName}
                  </option>
                ))}
                {(designations.data ?? []).map((x) => (
                  <option key={x.id} value={`designation:${x.id}`}>
                    Designation: {x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex flex-wrap items-end gap-1">
              {s.reviewers.map((r, k) => (
                <Button
                  key={k}
                  type="button"
                  variant="ghost"
                  title="Remove"
                  onClick={() => set(i, { reviewers: s.reviewers.filter((_, j) => j !== k) })}
                >
                  {label(r)} ×
                </Button>
              ))}
            </div>
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={() => setStages([...stages, blank()])}>
            Add a stage
          </Button>
          {stages.length > 1 && (
            <Button type="button" variant="ghost" onClick={() => setStages(stages.slice(0, -1))}>
              Remove the last stage
            </Button>
          )}
          <Button type="submit">Save workflow</Button>
        </div>
      </form>
    </Card>
  );
}
