// Projects (docs/wave2a-plan.md step 1): the register, a new project, and a project's page with its details, status,
// sites, team and activity. A project is visible to its team (and to roles that see every project); its lead and
// roles that edit projects change it. A won tender becomes a project from the tender's page.
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
  Textarea,
} from '@aerolith/ui';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Gauge, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useDeferredValue, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api/client';
import { ProjectBoqs } from '../project/ProjectBoqs';
import { ProjectEnquiries } from '../project/ProjectEnquiries';
import { ProjectMaterialBudget } from '../project/ProjectMaterialBudget';
import { ProjectOrders } from '../project/ProjectOrders';
import { ProjectStores } from '../project/ProjectStores';
import { ProjectRequisitions } from '../project/ProjectRequisitions';
import { ProjectSchedules } from '../project/ProjectSchedules';
import type {
  Party,
  Person,
  ProjectDetail,
  ProjectRole,
  ProjectStatus,
  ProjectSummary,
} from '../api/types';
import {
  describeError,
  formatDate,
  formatDateTime,
  formatInr,
  formatInrShort,
} from '../lib/format';

export const PROJECT_STATUS: Record<ProjectStatus, string> = {
  planned: 'Planned',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  closed: 'Closed',
  cancelled: 'Cancelled',
};
const STATUS_TONE: Record<ProjectStatus, 'neutral' | 'accent' | 'warning' | 'danger' | 'success'> =
  {
    planned: 'neutral',
    active: 'accent',
    on_hold: 'warning',
    completed: 'success',
    closed: 'neutral',
    cancelled: 'danger',
  };
const MOVE_LABEL: Record<ProjectStatus, string> = {
  planned: 'Back to planned',
  active: 'Start work',
  on_hold: 'Put on hold',
  completed: 'Mark completed',
  closed: 'Close the project',
  cancelled: 'Cancel the project',
};
const REASON_NEEDED: ProjectStatus[] = ['on_hold', 'cancelled'];
const ROLE_LABEL: Record<ProjectRole, string> = {
  lead: 'Lead',
  member: 'Member',
  viewer: 'Viewer',
};
const LIVE: ProjectStatus[] = ['planned', 'active', 'on_hold'];
const FILTERS = [
  { key: 'live', label: 'Live' },
  { key: 'planned', label: 'Planned' },
  { key: 'active', label: 'Active' },
  { key: 'on_hold', label: 'On hold' },
  { key: 'completed', label: 'Completed' },
  { key: 'closed', label: 'Closed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'all', label: 'All' },
];

const post = <T,>(url: string, body: object = {}) =>
  api.request<T>(`/api/tenant/${url}`, { method: 'POST', body });

// --- the register ---

export function ProjectsScreen() {
  const [filter, setFilter] = useState('live');
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDeferredValue(search.trim());
  const projects = useQuery({
    queryKey: ['projects', filter, q, mine],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('status', filter);
      if (q) params.set('q', q);
      if (mine) params.set('mine', 'true');
      return api.request<{
        items: ProjectSummary[];
        counts: Record<string, number>;
        canCreate: boolean;
      }>(`/api/tenant/projects?${params}`);
    },
    placeholderData: keepPreviousData,
  });
  const counts = projects.data?.counts ?? {};
  const count = (key: string) =>
    key === 'all'
      ? Object.values(counts).reduce((a, b) => a + b, 0)
      : key === 'live'
        ? LIVE.reduce((a, s) => a + (counts[s] ?? 0), 0)
        : (counts[key] ?? 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Projects"
        subtitle="Jobs won and under way. A won tender becomes a project from its page."
        actions={
          projects.data?.canCreate &&
          !creating && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> New project
            </Button>
          )
        }
      />
      {creating && <NewProject onCancel={() => setCreating(false)} />}
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-md px-2.5 py-1.5 text-sm ${filter === f.key ? 'bg-surface-3 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2'}`}
          >
            {f.label} <span className="tabular-nums text-fg-subtle">{count(f.key)}</span>
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-sm text-fg-muted">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Only projects I am on
        </label>
      </div>
      <Card>
        <div className="relative mb-4 max-w-sm">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
            aria-hidden
          />
          <Input
            aria-label="Search projects"
            placeholder="Name, number, client, work order, location"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {projects.isPending ? (
          <Spinner />
        ) : projects.isError ? (
          <Alert tone="danger">{describeError(projects.error)}</Alert>
        ) : projects.data.items.length === 0 ? (
          <p className="py-8 text-center text-sm text-fg-muted">
            {q || filter !== 'live'
              ? 'No projects match.'
              : 'No live projects you can see. A won tender becomes one from its page.'}
          </p>
        ) : (
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Number</th>
                <th>Project</th>
                <th>Start</th>
                <th>Planned finish</th>
                <th className="text-right">Contract value</th>
                <th>Status</th>
                <th>Lead</th>
              </tr>
            </thead>
            <tbody aria-label="Projects">
              {projects.data.items.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap font-mono text-xs text-fg-muted">{p.number}</td>
                  <td className="max-w-[24rem]">
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: p.id }}
                      className="font-medium text-accent hover:underline"
                    >
                      {p.name}
                    </Link>
                    <div className="truncate text-xs text-fg-muted">
                      {[p.client?.name, p.location].filter(Boolean).join(' · ') || '-'}
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-fg-muted">
                    {p.startOn ? formatDate(p.startOn) : '-'}
                  </td>
                  <td className="whitespace-nowrap text-fg-muted">
                    {p.plannedFinishOn ? formatDate(p.plannedFinishOn) : '-'}
                  </td>
                  <td className="whitespace-nowrap text-right tabular-nums">
                    {formatInrShort(p.contractValue)}
                  </td>
                  <td>
                    <Badge tone={STATUS_TONE[p.status]}>{PROJECT_STATUS[p.status]}</Badge>
                  </td>
                  <td className="text-fg-muted">{p.lead?.displayName ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}

// --- the project's details, as a form ---

interface Values {
  name: string;
  clientId: string;
  clientRef: string;
  contractValue: string;
  startOn: string;
  plannedFinishOn: string;
  location: string;
  description: string;
}
const fromProject = (p?: ProjectDetail): Values => ({
  name: p?.name ?? '',
  clientId: p?.client?.id ?? '',
  clientRef: p?.clientRef ?? '',
  contractValue: p?.contractValue ?? '',
  startOn: p?.startOn ?? '',
  plannedFinishOn: p?.plannedFinishOn ?? '',
  location: p?.location ?? '',
  description: p?.description ?? '',
});
const toBody = (v: Values) => ({
  name: v.name.trim(),
  clientId: v.clientId || null,
  clientRef: v.clientRef,
  contractValue: v.contractValue.replace(/,/g, '').trim() || null,
  startOn: v.startOn || null,
  plannedFinishOn: v.plannedFinishOn || null,
  location: v.location,
  description: v.description,
});

function ProjectForm({
  project,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  project?: ProjectDetail;
  submitLabel: string;
  onSubmit: (body: ReturnType<typeof toBody>) => Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = useState(() => fromProject(project));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clients = useQuery({
    queryKey: ['parties', 'client'],
    queryFn: () => api.request<Party[]>('/api/tenant/parties?kind=client'),
  });
  const set = (k: keyof Values) => (e: { target: { value: string } }) =>
    setV((s) => ({ ...s, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(toBody(v));
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="Project name">
            <Input value={v.name} onChange={set('name')} required minLength={3} />
          </Field>
        </div>
        <Field label="Client">
          <Select value={v.clientId} onChange={set('clientId')}>
            <option value="">No client yet</option>
            {(clients.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Work order / agreement number">
          <Input value={v.clientRef} onChange={set('clientRef')} />
        </Field>
        <Field label="Contract value (₹)">
          <Input inputMode="decimal" value={v.contractValue} onChange={set('contractValue')} />
        </Field>
        <Field label="Location">
          <Input value={v.location} onChange={set('location')} />
        </Field>
        <Field label="Start">
          <Input type="date" value={v.startOn} onChange={set('startOn')} />
        </Field>
        <Field label="Planned finish">
          <Input type="date" value={v.plannedFinishOn} onChange={set('plannedFinishOn')} />
        </Field>
        <div className="md:col-span-2">
          <Field label="Description">
            <Textarea rows={3} value={v.description} onChange={set('description')} />
          </Field>
        </div>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" busy={busy} disabled={v.name.trim().length < 3}>
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function NewProject({ onCancel }: { onCancel: () => void }) {
  const navigate = useNavigate();
  return (
    <Card title="New project">
      <p className="mb-4 text-sm text-fg-muted">
        For a job that did not come through a tender here. You will lead it; add the team after.
      </p>
      <ProjectForm
        submitLabel="Create project"
        onCancel={onCancel}
        onSubmit={async (body) => {
          const p = await post<ProjectDetail>('projects', body);
          await navigate({ to: '/projects/$projectId', params: { projectId: p.id } });
        }}
      />
    </Card>
  );
}

// --- one project ---

export function ProjectScreen({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const project = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
  });
  const done = (p: ProjectDetail) => {
    qc.setQueryData(['project', projectId], p);
    void qc.invalidateQueries({ queryKey: ['projects'] });
  };
  if (project.isPending) return <Spinner />;
  if (project.isError) return <Alert tone="danger">{describeError(project.error)}</Alert>;
  const p = project.data;
  return (
    <div className="space-y-5">
      <Link
        to="/projects"
        className="inline-flex items-center gap-1 text-sm text-fg-muted hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden /> Projects
      </Link>
      <PageHeader
        title={p.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs">{p.number}</span>
            <Badge tone={STATUS_TONE[p.status]}>{PROJECT_STATUS[p.status]}</Badge>
            {p.client && <span>{p.client.name}</span>}
            {p.myRole && <span className="text-xs">You: {ROLE_LABEL[p.myRole].toLowerCase()}</span>}
          </span>
        }
        actions={
          <div className="flex gap-2">
            <Link
              to="/projects/$projectId/dashboard"
              params={{ projectId: p.id }}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
            >
              <Gauge className="size-4" aria-hidden /> Dashboard
            </Link>
            {p.canEdit && !editing && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden /> Edit
              </Button>
            )}
          </div>
        }
      />
      {p.statusReason && (p.status === 'on_hold' || p.status === 'cancelled') && (
        <Alert tone="warning">
          {PROJECT_STATUS[p.status]}: {p.statusReason}
        </Alert>
      )}
      {editing ? (
        <Card title="Edit project">
          <ProjectForm
            project={p}
            submitLabel="Save changes"
            onCancel={() => setEditing(false)}
            onSubmit={async (body) => {
              done(
                await post<ProjectDetail>(`projects/${p.id}`, {
                  ...body,
                  rowVersion: p.rowVersion,
                }),
              );
              setEditing(false);
            }}
          />
        </Card>
      ) : (
        <>
          {p.canEdit && p.allowedMoves.length > 0 && <StatusActions project={p} onDone={done} />}
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_26rem]">
            <div className="space-y-5">
              <Card title="Details">
                <dl className="grid grid-cols-[11rem_1fr] gap-y-2 text-sm">
                  <Row label="Contract value">{formatInr(p.contractValue)}</Row>
                  <Row label="Work order">{p.clientRef ?? '-'}</Row>
                  <Row label="Start">{p.startOn ? formatDate(p.startOn) : '-'}</Row>
                  <Row label="Planned finish">
                    {p.plannedFinishOn ? formatDate(p.plannedFinishOn) : '-'}
                  </Row>
                  {p.actualFinishOn && <Row label="Finished">{formatDate(p.actualFinishOn)}</Row>}
                  <Row label="Location">{p.location ?? '-'}</Row>
                  <Row label="Company">{p.entity.name}</Row>
                  <Row label="From tender">
                    {p.tender ? (
                      <Link
                        to="/tenders/$tenderId"
                        params={{ tenderId: p.tender.id }}
                        className="text-accent hover:underline"
                      >
                        {p.tender.number} · {p.tender.title}
                      </Link>
                    ) : (
                      '-'
                    )}
                  </Row>
                </dl>
                {p.description && (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-fg-muted">{p.description}</p>
                )}
              </Card>
              <ProjectBoqs project={p} />
              <ProjectSchedules project={p} />
              <ProjectMaterialBudget project={p} />
              <ProjectRequisitions project={p} />
              <ProjectEnquiries project={p} />
              <ProjectOrders project={p} />
              <ProjectStores project={p} />
              <Sites project={p} onDone={done} />
              <Card title="Coming next">
                <p className="text-sm text-fg-muted">
                  Next in Wave 2b: purchase orders from the vendors chosen, goods receipt, stores,
                  and daily site reports.
                </p>
              </Card>
            </div>
            <div className="space-y-5">
              <Team project={p} onDone={done} />
              <Card title="Activity">
                <ul className="space-y-2 text-sm" aria-label="Project activity">
                  {p.events.map((e) => (
                    <li key={e.id}>
                      <div>{describeEvent(e.kind, e.data)}</div>
                      <div className="text-xs text-fg-muted">
                        {formatDateTime(e.at)}
                        {e.actor ? ` · ${e.actor}` : ''}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function describeEvent(kind: string, d: Record<string, unknown>): string {
  switch (kind) {
    case 'created':
      return d.tenderId ? 'Project made from the won tender' : 'Project created';
    case 'updated':
      return 'Details changed';
    case 'status':
      return `${PROJECT_STATUS[d.from as ProjectStatus]} → ${PROJECT_STATUS[d.to as ProjectStatus]}${d.reason ? `: ${String(d.reason)}` : ''}`;
    case 'site_added':
      return `Site added: ${String(d.name)}`;
    case 'boqs_from_tender':
      return `Contract BOQ and budget made from the tender${d.scale && d.scale !== '1' ? `, rates at ${(Number(d.scale) * 100).toFixed(2)}% of quoted` : ''}`;
    case 'boq_created':
      return `BOQ added: ${String(d.name)}`;
    case 'boq_frozen':
      return `${String(d.name)}: version ${String(d.version)} frozen`;
    case 'boq_revision_started':
      return `${String(d.name)}: revision started`;
    case 'boq_imported':
      return `BOQ lines imported from ${String(d.file)}`;
    case 'boq_archived':
      return `BOQ archived: ${String(d.name)}`;
    case 'boq_restored':
      return `BOQ restored: ${String(d.name)}`;
    case 'schedule_created':
      return `Schedule started: ${String(d.name)}`;
    case 'programme_imported':
      return `Schedule imported: ${String(d.name)}`;
    case 'baseline_taken':
      return `Baseline taken: ${String(d.name)}`;
    case 'programme_archived':
      return `Schedule archived: ${String(d.name)}`;
    case 'programme_restored':
      return `Schedule restored: ${String(d.name)}`;
    case 'rfq_created':
      return `Enquiry ${String(d.number)} started: ${String(d.title)}`;
    case 'rfq_status':
      return `Enquiry ${String(d.number)}: ${String(d.from)} → ${String(d.to)}`;
    case 'rfq_quote':
      return `Enquiry ${String(d.number)}: quote from ${String(d.vendor)}`;
    case 'team':
      return d.to
        ? `${String(d.user)} is now ${ROLE_LABEL[d.to as ProjectRole].toLowerCase()}`
        : `${String(d.user)} left the team`;
    default:
      return kind;
  }
}

function StatusActions({
  project: p,
  onDone,
}: {
  project: ProjectDetail;
  onDone: (p: ProjectDetail) => void;
}) {
  const [to, setTo] = useState<ProjectStatus | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const move = async (status: ProjectStatus, why: string | null) => {
    setBusy(true);
    setError(null);
    try {
      onDone(
        await post<ProjectDetail>(`projects/${p.id}/status`, {
          rowVersion: p.rowVersion,
          status,
          reason: why,
        }),
      );
      setTo(null);
      setReason('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Project status">
        {p.allowedMoves.map((s) => (
          <Button
            key={s}
            variant={s === 'cancelled' ? 'ghost' : 'secondary'}
            busy={busy && to === s}
            onClick={() => (REASON_NEEDED.includes(s) ? setTo(s) : void move(s, null))}
          >
            {MOVE_LABEL[s]}
          </Button>
        ))}
      </div>
      {to && REASON_NEEDED.includes(to) && (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void move(to, reason);
          }}
        >
          <Field label="Why?">
            <Input
              className="w-96"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </Field>
          <Button type="submit" busy={busy} disabled={!reason.trim()}>
            {MOVE_LABEL[to]}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setTo(null)}>
            Never mind
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

function Sites({
  project: p,
  onDone,
}: {
  project: ProjectDetail;
  onDone: (p: ProjectDetail) => void;
}) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<ProjectDetail>) => {
    setBusy(true);
    setError(null);
    try {
      onDone(await fn());
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={`Sites (${p.sites.length})`}>
      {p.sites.length === 0 ? (
        <p className="mb-3 text-sm text-fg-muted">
          No site yet. Each site&apos;s state decides GST&apos;s place of supply later.
        </p>
      ) : (
        <ul className="mb-3 divide-y divide-line text-sm" aria-label="Sites">
          {p.sites.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <span className={s.active ? 'font-medium' : 'text-fg-subtle line-through'}>
                  {s.name}
                </span>
                <div className="text-xs text-fg-muted">
                  {[s.address, s.stateCode && `GST state ${s.stateCode}`]
                    .filter(Boolean)
                    .join(' · ') || '-'}
                </div>
              </div>
              {p.canEdit && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void run(() =>
                      post<ProjectDetail>(`sites/${s.id}`, {
                        rowVersion: s.rowVersion,
                        active: !s.active,
                      }),
                    )
                  }
                >
                  {s.active ? 'Mark finished' : 'Reopen'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {p.canEdit && (
        <form
          className="grid gap-2 border-t border-line pt-3 md:grid-cols-[1fr_1fr_7rem_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              post<ProjectDetail>(`projects/${p.id}/sites`, {
                name,
                address,
                stateCode,
              }),
            ).then((ok) => {
              if (ok) {
                setName('');
                setAddress('');
                setStateCode('');
              }
            });
          }}
        >
          <Field label="Site name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Address">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label="GST state code">
            <Input
              inputMode="numeric"
              maxLength={2}
              placeholder="27"
              value={stateCode}
              onChange={(e) => setStateCode(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="secondary" busy={busy} disabled={name.trim().length < 2}>
              <Plus className="size-4" aria-hidden /> Add site
            </Button>
          </div>
        </form>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

function Team({
  project: p,
  onDone,
}: {
  project: ProjectDetail;
  onDone: (p: ProjectDetail) => void;
}) {
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api.request<Person[]>('/api/tenant/people'),
    enabled: p.canEdit,
  });
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');
  const [error, setError] = useState<string | null>(null);
  const set = async (user: string, r: ProjectRole | null) => {
    setError(null);
    try {
      onDone(await post<ProjectDetail>(`projects/${p.id}/team`, { userId: user, role: r }));
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const onTeam = new Set(p.team.map((m) => m.userId));
  return (
    <Card title={`Team (${p.team.length})`}>
      <ul className="divide-y divide-line text-sm" aria-label="Team">
        {p.team.map((m) => (
          <li key={m.userId} className="flex items-center gap-2 py-2">
            <span className="min-w-0 flex-1 truncate" title={m.displayName}>
              {m.displayName}
            </span>
            {p.canEdit ? (
              <>
                <div className="w-28 shrink-0">
                  <Select
                    aria-label={`Role of ${m.displayName}`}
                    value={m.role}
                    onChange={(e) => void set(m.userId, e.target.value as ProjectRole)}
                  >
                    {(Object.keys(ROLE_LABEL) as ProjectRole[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </Select>
                </div>
                <Button
                  variant="ghost"
                  aria-label={`Take ${m.displayName} off the team`}
                  onClick={() => void set(m.userId, null)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </>
            ) : (
              <Badge tone={m.role === 'lead' ? 'accent' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>
            )}
          </li>
        ))}
      </ul>
      {p.canEdit && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            void set(userId, role).then((ok) => ok && setUserId(''));
          }}
        >
          <Field label="Add to the team">
            <Select className="w-48" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Choose…</option>
              {(people.data ?? [])
                .filter((u) => !onTeam.has(u.id))
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="As">
            <Select
              className="w-28"
              value={role}
              onChange={(e) => setRole(e.target.value as ProjectRole)}
            >
              {(Object.keys(ROLE_LABEL) as ProjectRole[]).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" variant="secondary" disabled={!userId}>
            Add
          </Button>
        </form>
      )}
      <p className="mt-3 text-xs text-fg-muted">
        Leads change the project and its team; members work on it; viewers read it. A project always
        has a lead.
      </p>
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

// --- on a won tender's page ---

/** "Make the project" on a won tender, or the project it became. */
export function TenderProjectCard({ tenderId }: { tenderId: string }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const link = useQuery({
    queryKey: ['tender-project', tenderId],
    queryFn: () =>
      api.request<{
        project: { id: string | null; number: string; name: string | null } | null;
        canCreate: boolean;
      }>(`/api/tenant/tenders/${tenderId}/project`),
  });
  if (!link.data) return null;
  const { project, canCreate } = link.data;
  if (!project && !canCreate) return null;
  return (
    <Card title="Project">
      {project ? (
        project.id ? (
          <p className="text-sm">
            This tender is now{' '}
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="font-medium text-accent hover:underline"
            >
              {project.number} · {project.name}
            </Link>
            .
          </p>
        ) : (
          <p className="text-sm text-fg-muted">
            This tender became project {project.number}; you are not on its team.
          </p>
        )
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-fg-muted">
            Won. Make it a project: its name, client, location and our bid value carry over. The
            tender programme does not; the project gets its own schedule.
          </p>
          <Button
            busy={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                setError(null);
                try {
                  const p = await post<ProjectDetail>(`tenders/${tenderId}/project`);
                  await navigate({ to: '/projects/$projectId', params: { projectId: p.id } });
                } catch (err) {
                  setError(describeError(err));
                  setBusy(false);
                }
              })()
            }
          >
            Make it a project
          </Button>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Card>
  );
}
