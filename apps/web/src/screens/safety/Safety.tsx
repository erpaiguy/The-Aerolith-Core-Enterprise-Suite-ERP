// Safety (docs/wave3-plan.md step 15), for a project: incidents investigated to closure, permits to work with their
// precautions, toolbox talks, safety inspections (step 14's checklists) and the injury rates from recorded man-hours.
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
import { describeError } from '../../lib/format';
import { useProjectParam } from '../../lib/project-param';

interface Register {
  incidents: {
    id: string;
    number: string;
    kind: string;
    occurredAt: string;
    location: string;
    description: string;
    injured: string | null;
    daysLost: number;
    status: string;
    openActions: number;
  }[];
  permits: {
    id: string;
    number: string;
    kind: string;
    location: string;
    work: string;
    validFrom: string;
    validTo: string;
    status: string;
    precautions: { text: string; confirmed: boolean }[];
    requestedBy: string;
  }[];
  toolboxTalks: {
    id: string;
    heldOn: string;
    topic: string;
    speaker: string;
    attendance: number;
  }[];
  inspections: { id: string; template: string; doneOn: string; location: string; result: string }[];
  mayManage: boolean;
}
interface Stats {
  staffHours: number;
  labourHours: number;
  manHours: number;
  lostTimeInjuries: number;
  daysLost: number;
  frequencyRate: number | null;
  severityRate: number | null;
}
interface Incident {
  id: string;
  number: string;
  status: string;
  rootCause: string;
  actions: {
    id: string;
    action: string;
    owner: string;
    dueOn: string | null;
    doneOn: string | null;
  }[];
}
const KINDS = ['near_miss', 'first_aid', 'medical', 'lost_time', 'fatal', 'property_damage'];
const PERMITS = ['height', 'hot_work', 'confined_space', 'excavation', 'electrical'];
const label = (s: string) => s.replace(/_/g, ' ');
const TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'accent'> = {
  closed: 'success',
  issued: 'accent',
  investigated: 'accent',
  open: 'warning',
  requested: 'warning',
  expired: 'danger',
  cancelled: 'neutral',
  passed: 'success',
  failed: 'danger',
};
const local = (v: string) => (v ? new Date(v).toISOString() : '');
const monthStart = () => `${today().slice(0, 7)}-01`;

export function SafetyScreen() {
  const projects = useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
  const [projectId, setProjectId] = useProjectParam();
  return (
    <div className="space-y-5">
      <PageHeader
        title="Safety"
        subtitle="Incidents, permits to work, toolbox talks and the injury rates."
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
      {projectId && <ProjectSafety key={projectId} projectId={projectId} />}
    </div>
  );
}

function ProjectSafety({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['safety', projectId];
  const r = useQuery({
    queryKey: key,
    queryFn: () => api.request<Register>(`/api/tenant/projects/${projectId}/safety`),
  });
  const [period, setPeriod] = useState({ from: monthStart(), to: today() });
  const stats = useQuery({
    queryKey: ['safety-stats', projectId, period],
    queryFn: () =>
      api.request<Stats>(
        `/api/tenant/projects/${projectId}/safety/statistics?from=${period.from}&to=${period.to}`,
      ),
  });
  const [error, setError] = useState<string | null>(null);
  const call = async (path: string, body: object) => {
    setError(null);
    try {
      await api.request(path, { method: 'POST', body });
      void qc.invalidateQueries({ queryKey: key });
      void qc.invalidateQueries({ queryKey: ['safety-stats', projectId] });
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const [inc, setInc] = useState({
    kind: 'near_miss',
    occurredAt: '',
    location: '',
    description: '',
    injuredName: '',
    daysLost: '0',
  });
  const [open, setOpen] = useState<string | null>(null);
  const [ptw, setPtw] = useState({
    kind: 'height',
    location: '',
    work: '',
    validFrom: '',
    validTo: '',
  });
  const [checks, setChecks] = useState<Record<string, boolean[]>>({});
  const [talk, setTalk] = useState({ heldOn: today(), topic: '', speaker: '', others: '' });
  if (r.isPending) return <Spinner />;
  if (r.isError) return <Alert tone="danger">{describeError(r.error)}</Alert>;
  const d = r.data;
  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card
        title="Man-hours and rates"
        actions={
          <div className="flex gap-2">
            <Input
              type="date"
              aria-label="From"
              value={period.from}
              onChange={(e) => setPeriod({ ...period, from: e.target.value })}
            />
            <Input
              type="date"
              aria-label="To"
              value={period.to}
              onChange={(e) => setPeriod({ ...period, to: e.target.value })}
            />
          </div>
        }
      >
        {stats.data && (
          <dl className="grid gap-3 text-sm sm:grid-cols-5" data-testid="safety-stats">
            {(
              [
                [
                  'Man-hours',
                  `${stats.data.manHours} (staff ${stats.data.staffHours}, labour ${stats.data.labourHours})`,
                ],
                ['Lost-time injuries', String(stats.data.lostTimeInjuries)],
                ['Days lost', String(stats.data.daysLost)],
                [
                  'Frequency rate',
                  stats.data.frequencyRate === null ? '—' : String(stats.data.frequencyRate),
                ],
                [
                  'Severity rate',
                  stats.data.severityRate === null ? '—' : String(stats.data.severityRate),
                ],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-fg-muted">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
        )}
        <p className="mt-2 text-xs text-fg-muted">
          Per million man-hours, from attendance and musters recorded at the project.
        </p>
      </Card>

      <Card title="Incidents">
        {d.incidents.length > 0 && (
          <Table minWidth="44rem">
            <thead>
              <tr>
                <th>No.</th>
                <th>When</th>
                <th>Kind</th>
                <th>What happened</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {d.incidents.map((i) => (
                <tr key={i.id} aria-label={i.number}>
                  <td>{i.number}</td>
                  <td>{i.occurredAt}</td>
                  <td>{label(i.kind)}</td>
                  <td>
                    {i.description}
                    {i.injured && <span className="text-fg-muted"> · {i.injured}</span>}
                    {i.daysLost > 0 && (
                      <span className="text-fg-muted"> · {i.daysLost} days lost</span>
                    )}
                  </td>
                  <td>
                    <Badge tone={TONE[i.status] ?? 'neutral'}>{i.status}</Badge>
                    {i.openActions > 0 && (
                      <span className="text-xs text-fg-muted"> {i.openActions} actions open</span>
                    )}
                  </td>
                  <td>
                    {i.status !== 'closed' && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setOpen(open === i.id ? null : i.id)}
                      >
                        Investigate
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {open && (
          <Investigation
            key={open}
            id={open}
            mayClose={d.mayManage}
            onChange={() => {
              void qc.invalidateQueries({ queryKey: key });
              void qc.invalidateQueries({ queryKey: ['safety-stats', projectId] });
            }}
          />
        )}
        <form
          aria-label="Report an incident"
          className="mt-3 grid gap-3 sm:grid-cols-6"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void call(`/api/tenant/projects/${projectId}/incidents`, {
              ...inc,
              occurredAt: local(inc.occurredAt),
              daysLost: Number(inc.daysLost || 0),
            });
          }}
        >
          <Field label="Kind">
            <Select value={inc.kind} onChange={(e) => setInc({ ...inc, kind: e.target.value })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="When">
            <Input
              type="datetime-local"
              value={inc.occurredAt}
              onChange={(e) => setInc({ ...inc, occurredAt: e.target.value })}
              required
            />
          </Field>
          <Field label="Where">
            <Input
              value={inc.location}
              onChange={(e) => setInc({ ...inc, location: e.target.value })}
            />
          </Field>
          <Field label="What happened">
            <Input
              value={inc.description}
              onChange={(e) => setInc({ ...inc, description: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <Field label="Who was hurt">
            <Input
              value={inc.injuredName}
              onChange={(e) => setInc({ ...inc, injuredName: e.target.value })}
            />
          </Field>
          <div className="flex items-end gap-2">
            {(inc.kind === 'lost_time' || inc.kind === 'fatal') && (
              <Field label="Days lost">
                <Input
                  inputMode="numeric"
                  value={inc.daysLost}
                  onChange={(e) => setInc({ ...inc, daysLost: e.target.value })}
                  className="w-20"
                />
              </Field>
            )}
            <Button type="submit">Report</Button>
          </div>
        </form>
      </Card>

      <Card title="Permits to work">
        {d.permits.map((p) => {
          const c = checks[p.id] ?? p.precautions.map(() => false);
          return (
            <div
              key={p.id}
              className="mb-3 rounded-md border border-line p-3 text-sm"
              role="group"
              aria-label={p.number}
            >
              <p>
                <strong>{p.number}</strong> {label(p.kind)} · {p.location}: {p.work} · {p.validFrom}{' '}
                to {p.validTo} <Badge tone={TONE[p.status] ?? 'neutral'}>{p.status}</Badge>
              </p>
              {p.status === 'requested' && d.mayManage && (
                <div className="mt-2 space-y-1">
                  {p.precautions.map((x, i) => (
                    <label key={x.text} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={c[i] ?? false}
                        onChange={(e) => {
                          const n = [...c];
                          n[i] = e.target.checked;
                          setChecks({ ...checks, [p.id]: n });
                        }}
                      />
                      {x.text}
                    </label>
                  ))}
                  <Button
                    type="button"
                    onClick={() => void call(`/api/tenant/permits/${p.id}/issue`, { confirmed: c })}
                  >
                    Issue
                  </Button>
                </div>
              )}
              {(p.status === 'issued' || p.status === 'expired') && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void call(`/api/tenant/permits/${p.id}/close`, { note: 'Work done' })
                  }
                >
                  Close
                </Button>
              )}
            </div>
          );
        })}
        <form
          aria-label="Ask for a permit"
          className="grid gap-3 sm:grid-cols-6"
          onSubmit={(e) => {
            e.preventDefault();
            void call(`/api/tenant/projects/${projectId}/permits`, {
              ...ptw,
              validFrom: local(ptw.validFrom),
              validTo: local(ptw.validTo),
            });
          }}
        >
          <Field label="Work at">
            <Select value={ptw.kind} onChange={(e) => setPtw({ ...ptw, kind: e.target.value })}>
              {PERMITS.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Location">
            <Input
              value={ptw.location}
              onChange={(e) => setPtw({ ...ptw, location: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <Field label="Work">
            <Input
              value={ptw.work}
              onChange={(e) => setPtw({ ...ptw, work: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <Field label="From">
            <Input
              type="datetime-local"
              value={ptw.validFrom}
              onChange={(e) => setPtw({ ...ptw, validFrom: e.target.value })}
              required
            />
          </Field>
          <Field label="To">
            <Input
              type="datetime-local"
              value={ptw.validTo}
              onChange={(e) => setPtw({ ...ptw, validTo: e.target.value })}
              required
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit">Ask</Button>
          </div>
        </form>
      </Card>

      <Card title="Toolbox talks">
        {d.toolboxTalks.length > 0 && (
          <ul className="mb-3 space-y-1 text-sm">
            {d.toolboxTalks.map((t) => (
              <li key={t.id}>
                {t.heldOn} · {t.topic} {t.speaker && `(${t.speaker})`} · {t.attendance} present
              </li>
            ))}
          </ul>
        )}
        <form
          aria-label="Toolbox talk"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void call(`/api/tenant/projects/${projectId}/toolbox-talks`, {
              ...talk,
              others: Number(talk.others || 0),
            });
          }}
        >
          <Field label="Held on">
            <Input
              type="date"
              value={talk.heldOn}
              onChange={(e) => setTalk({ ...talk, heldOn: e.target.value })}
              required
            />
          </Field>
          <Field label="Topic">
            <Input
              value={talk.topic}
              onChange={(e) => setTalk({ ...talk, topic: e.target.value })}
              required
              minLength={3}
            />
          </Field>
          <Field label="Speaker">
            <Input
              value={talk.speaker}
              onChange={(e) => setTalk({ ...talk, speaker: e.target.value })}
            />
          </Field>
          <Field label="Attended">
            <Input
              inputMode="numeric"
              value={talk.others}
              onChange={(e) => setTalk({ ...talk, others: e.target.value })}
              className="w-20"
            />
          </Field>
          <Button type="submit" variant="secondary">
            Record
          </Button>
        </form>
      </Card>

      <Card title="Safety inspections">
        {d.inspections.length === 0 ? (
          <p className="text-sm text-fg-muted">
            None yet: fill a checklist whose work type is Safety on the Quality page.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {d.inspections.map((i) => (
              <li key={i.id}>
                {i.doneOn} · {i.template} · {i.location}{' '}
                <Badge tone={TONE[i.result] ?? 'neutral'}>{i.result}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Investigation({
  id,
  mayClose,
  onChange,
}: {
  id: string;
  mayClose: boolean;
  onChange: () => void;
}) {
  const qc = useQueryClient();
  const key = ['incident', id];
  const i = useQuery({
    queryKey: key,
    queryFn: () => api.request<Incident>(`/api/tenant/incidents/${id}`),
  });
  const [f, setF] = useState({ rootCause: '', action: '', owner: '', dueOn: '' });
  const [error, setError] = useState<string | null>(null);
  const post = async (path: string, body: object) => {
    setError(null);
    try {
      qc.setQueryData(key, await api.request(path, { method: 'POST', body }));
      onChange();
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (!i.data) return <Spinner />;
  const d = i.data;
  return (
    <div
      className="mt-3 rounded-md border border-line p-3 text-sm"
      aria-label={`Investigation of ${d.number}`}
      role="group"
    >
      {d.rootCause && <p className="mb-2">Root cause: {d.rootCause}</p>}
      {d.actions.length > 0 && (
        <ul className="mb-2 space-y-1">
          {d.actions.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              {a.action} {a.owner && `(${a.owner})`}{' '}
              {a.doneOn ? (
                <Badge tone="success">done {a.doneOn}</Badge>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() =>
                    void post(`/api/tenant/incident-actions/${a.id}/done`, { doneOn: today() })
                  }
                >
                  Done
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {d.status !== 'closed' && (
        <form
          aria-label="Investigation"
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void post(`/api/tenant/incidents/${id}/investigation`, {
              rootCause: f.rootCause || d.rootCause,
              actions: f.action
                ? [{ action: f.action, owner: f.owner, dueOn: f.dueOn || null }]
                : [],
            });
          }}
        >
          <Field label="Root cause">
            <Input
              value={f.rootCause}
              placeholder={d.rootCause}
              onChange={(e) => setF({ ...f, rootCause: e.target.value })}
            />
          </Field>
          <Field label="Action">
            <Input value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} />
          </Field>
          <Field label="Owner">
            <Input value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} />
          </Field>
          <Button type="submit" variant="secondary">
            Save
          </Button>
          {mayClose && (
            <Button
              type="button"
              onClick={() => void post(`/api/tenant/incidents/${id}/close`, {})}
            >
              Close the incident
            </Button>
          )}
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
