// An employee (docs/wave3-plan.md step 11): the record (PAN and bank shown in full only to HR), where they have worked,
// their leave; and a site's attendance register for the project's team.
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
import type { Person, ProjectDetail, ProjectSummary } from '../../api/types';
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { sendOrKeep } from '../../offline';
import { shortDate } from '../../schedule/model';
import { usePermission } from '../../session/permissions';
import { SalaryCard, SettlementCard } from '../payroll/Payroll';
import { LeavePanel } from './MyAttendance';
import {
  FLAG_LABEL,
  STATUS_LABEL,
  type Employee,
  type EmployeeRow,
  type RegisterRow,
} from './model';
import { useDesignations } from './People';

const FIELDS: { key: keyof Employee; label: string; type?: string; hint?: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'birthDate', label: 'Born on', type: 'date' },
  { key: 'joinedOn', label: 'Joined on', type: 'date' },
  { key: 'leftOn', label: 'Left on', type: 'date' },
  { key: 'grade', label: 'Grade' },
  { key: 'department', label: 'Department' },
  { key: 'pan', label: 'PAN' },
  { key: 'uan', label: 'UAN' },
  { key: 'esiNumber', label: 'ESI number' },
  { key: 'aadhaarLast4', label: "Aadhaar's last 4 digits", hint: 'Never the full number' },
  { key: 'aadhaarConsentOn', label: 'Consent given on', type: 'date' },
  { key: 'bankAccount', label: 'Bank account' },
  { key: 'bankIfsc', label: 'IFSC' },
  { key: 'bankName', label: 'Bank' },
];

export function EmployeeScreen({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const mayEdit = usePermission('hr.edit');
  const key = ['employee', employeeId];
  const e = useQuery({
    queryKey: key,
    queryFn: () => api.request<Employee>(`/api/tenant/hr/employees/${employeeId}`),
  });
  const designations = useDesignations();
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api.request<Person[]>('/api/tenant/people'),
    enabled: mayEdit,
  });
  const colleagues = useQuery({
    queryKey: ['employees', e.data?.entityId],
    queryFn: () =>
      api.request<EmployeeRow[]>(`/api/tenant/hr/employees?entityId=${e.data!.entityId}`),
    enabled: mayEdit && Boolean(e.data),
  });
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (e.isPending) return <Spinner />;
  if (e.isError) return <Alert tone="danger">{describeError(e.error)}</Alert>;
  const d = e.data;
  const start = () =>
    setForm(
      Object.fromEntries(
        [...FIELDS.map((f) => f.key), 'designationId', 'managerId', 'userId', 'kind'].map((k) => [
          k,
          String(d[k as keyof Employee] ?? ''),
        ]),
      ),
    );
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!form) return;
    setError(null);
    try {
      const body: Record<string, unknown> = { rowVersion: d.rowVersion };
      for (const [k, v] of Object.entries(form))
        if (v !== String(d[k as keyof Employee] ?? ''))
          body[k] = v === '' && !['grade', 'department', 'bankName'].includes(k) ? null : v;
      qc.setQueryData(
        key,
        await api.request<Employee>(`/api/tenant/hr/employees/${employeeId}`, {
          method: 'PUT',
          body,
        }),
      );
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['employees'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title={`${d.code} ${d.name}`}
        subtitle={[d.designation, d.department, d.kind === 'worker' ? 'worker' : 'staff']
          .filter(Boolean)
          .join(' · ')}
        actions={
          mayEdit &&
          !form && (
            <Button type="button" onClick={start}>
              Edit
            </Button>
          )
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Record">
        {form ? (
          <form
            aria-label="Employee"
            className="grid gap-3 sm:grid-cols-3"
            onSubmit={(ev) => void save(ev)}
          >
            {FIELDS.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <Input
                  type={f.type ?? 'text'}
                  value={form[f.key] ?? ''}
                  onChange={(ev) => setForm({ ...form, [f.key]: ev.target.value })}
                />
              </Field>
            ))}
            <Field label="Designation">
              <Select
                value={form.designationId}
                onChange={(ev) => setForm({ ...form, designationId: ev.target.value })}
              >
                <option value="">None</option>
                {(designations.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reports to">
              <Select
                value={form.managerId}
                onChange={(ev) => setForm({ ...form, managerId: ev.target.value })}
              >
                <option value="">Nobody</option>
                {(colleagues.data ?? [])
                  .filter((x) => x.id !== d.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.code} {x.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Signs in as">
              <Select
                value={form.userId}
                onChange={(ev) => setForm({ ...form, userId: ev.target.value })}
              >
                <option value="">No sign-in</option>
                {(people.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end gap-2">
              <Button type="submit">Save</Button>
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <dt className="text-xs text-fg-muted">{f.label}</dt>
                <dd data-testid={`employee-${f.key}`}>
                  {f.type === 'date' && d[f.key]
                    ? shortDate(String(d[f.key]))
                    : String(d[f.key] || '—')}
                </dd>
              </div>
            ))}
            <div>
              <dt className="text-xs text-fg-muted">Reports to</dt>
              <dd>{d.manager ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Signs in as</dt>
              <dd>{d.username ?? '—'}</dd>
            </div>
          </dl>
        )}
        {d.masked && (
          <p className="mt-2 text-xs text-fg-muted">
            The PAN and the bank account show their last four only.
          </p>
        )}
      </Card>
      <Deployments employee={d} mayEdit={mayEdit} />
      <SalaryCard employeeId={d.id} />
      <SettlementCard employeeId={d.id} leftOn={d.leftOn} />
      <LeavePanel employeeId={d.id} />
    </div>
  );
}

function useProjects() {
  return useQuery({
    queryKey: ['projects', 'all-items'],
    queryFn: () => api.request<{ items: ProjectSummary[] }>('/api/tenant/projects'),
    select: (r) => r.items,
  });
}
function useSites(projectId: string) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.request<ProjectDetail>(`/api/tenant/projects/${projectId}`),
    enabled: Boolean(projectId),
    select: (p) => p.sites.filter((s) => s.active),
  });
}

function Deployments({ employee, mayEdit }: { employee: Employee; mayEdit: boolean }) {
  const qc = useQueryClient();
  const projects = useProjects();
  const [f, setF] = useState({ from: today(), projectId: '', siteId: '' });
  const sites = useSites(f.projectId);
  const [error, setError] = useState<string | null>(null);
  const deploy = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        ['employee', employee.id],
        await api.request<Employee>(`/api/tenant/hr/employees/${employee.id}/deployments`, {
          method: 'POST',
          body: { from: f.from, projectId: f.projectId || null, siteId: f.siteId || null },
        }),
      );
      void qc.invalidateQueries({ queryKey: ['employees'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Where they work">
      {employee.deployments.length === 0 ? (
        <p className="text-sm text-fg-muted">At the head office since joining.</p>
      ) : (
        <Table minWidth="28rem">
          <thead>
            <tr>
              <th>From</th>
              <th>Project</th>
              <th>Site</th>
            </tr>
          </thead>
          <tbody>
            {employee.deployments.map((x) => (
              <tr key={x.from}>
                <td>{shortDate(x.from)}</td>
                <td>{x.project ? `${x.project} ${x.projectName}` : 'Head office'}</td>
                <td>{x.site ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {mayEdit && (
        <form
          aria-label="Deploy"
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(ev) => void deploy(ev)}
        >
          <Field label="From">
            <Input
              type="date"
              value={f.from}
              onChange={(ev) => setF({ ...f, from: ev.target.value })}
              required
            />
          </Field>
          <Field label="Project">
            <Select
              value={f.projectId}
              onChange={(ev) => setF({ ...f, projectId: ev.target.value, siteId: '' })}
            >
              <option value="">Head office</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {f.projectId && (
            <Field label="Site">
              <Select value={f.siteId} onChange={(ev) => setF({ ...f, siteId: ev.target.value })}>
                <option value="">—</option>
                {(sites.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Button type="submit" variant="secondary">
            Deploy
          </Button>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

type MarkStatus = RegisterRow['status'];

export function SiteRegisterScreen() {
  const qc = useQueryClient();
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const [siteId, setSiteId] = useState('');
  const [day, setDay] = useState(today());
  const sites = useSites(projectId);
  const key = ['site-register', siteId, day];
  const register = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<{ rows: RegisterRow[] }>(`/api/tenant/hr/sites/${siteId}/attendance?date=${day}`),
    enabled: Boolean(siteId),
  });
  const [edits, setEdits] = useState<Record<string, Partial<RegisterRow>>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [queued, setQueued] = useState(false);
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    setError(null);
    setSaved(false);
    setQueued(false);
    try {
      const marks = Object.entries(edits).map(([employeeId, e]) => {
        const r = register.data!.rows.find((x) => x.employeeId === employeeId)!;
        const m = { ...r, ...e };
        return {
          employeeId,
          status: m.status,
          inTime: m.inTime || null,
          outTime: m.outTime || null,
          note: m.note ?? '',
        };
      });
      const sent = await sendOrKeep(
        `Attendance for ${day}`,
        `/api/tenant/hr/sites/${siteId}/attendance`,
        { date: day, marks },
      );
      if (sent.queued) setQueued(true);
      else qc.setQueryData(key, sent.result);
      setEdits({});
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title="Site attendance"
        subtitle="The day's register for the people deployed at a site."
      />
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Project">
            <Select
              value={projectId}
              onChange={(ev) => {
                setProjectId(ev.target.value);
                setSiteId('');
              }}
            >
              <option value="">Choose…</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.number} {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Site">
            <Select
              value={siteId}
              onChange={(ev) => setSiteId(ev.target.value)}
              disabled={!projectId}
            >
              <option value="">Choose…</option>
              {(sites.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Day">
            <Input
              type="date"
              value={day}
              max={today()}
              onChange={(ev) => {
                setDay(ev.target.value);
                setEdits({});
              }}
            />
          </Field>
        </div>
      </Card>
      {siteId &&
        (register.isPending ? (
          <Spinner />
        ) : register.isError ? (
          <Alert tone="danger">{describeError(register.error)}</Alert>
        ) : register.data.rows.length === 0 ? (
          <Alert tone="info">Nobody is deployed at this site on that day.</Alert>
        ) : (
          <Card title="Register">
            <form aria-label="Attendance register" onSubmit={(ev) => void save(ev)}>
              <Table minWidth="48rem">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Day</th>
                    <th>Mark</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {register.data.rows.map((r) => {
                    const m = { ...r, ...edits[r.employeeId] };
                    const set = (patch: Partial<RegisterRow>) =>
                      setEdits({ ...edits, [r.employeeId]: { ...edits[r.employeeId], ...patch } });
                    return (
                      <tr key={r.employeeId} aria-label={r.name}>
                        <td>
                          {r.code} {r.name}
                        </td>
                        <td className="text-xs">
                          {r.leave ? (
                            <Badge tone="accent">leave {r.leave}</Badge>
                          ) : r.day === 'holiday' ? (
                            (r.holiday ?? 'holiday')
                          ) : r.day === 'week_off' ? (
                            'weekly off'
                          ) : (
                            ''
                          )}
                          {r.flag && <Badge tone="warning">{FLAG_LABEL[r.flag] ?? r.flag}</Badge>}
                          {r.source && r.source !== 'register' && <Badge>{r.source}</Badge>}
                        </td>
                        <td>
                          <Select
                            aria-label="Mark"
                            value={m.status ?? ''}
                            onChange={(ev) =>
                              set({ status: (ev.target.value || null) as MarkStatus })
                            }
                          >
                            <option value="">—</option>
                            {Object.entries(STATUS_LABEL).map(([v, l]) => (
                              <option key={v} value={v}>
                                {l}
                              </option>
                            ))}
                          </Select>
                        </td>
                        <td>
                          <Input
                            type="time"
                            aria-label="In"
                            value={m.inTime ?? ''}
                            onChange={(ev) => set({ inTime: ev.target.value })}
                          />
                        </td>
                        <td>
                          <Input
                            type="time"
                            aria-label="Out"
                            value={m.outTime ?? ''}
                            onChange={(ev) => set({ outTime: ev.target.value })}
                          />
                        </td>
                        <td>
                          <Input
                            aria-label="Note"
                            value={m.note}
                            maxLength={300}
                            onChange={(ev) => set({ note: ev.target.value })}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <div className="mt-3 flex items-center gap-3">
                <Button type="submit" disabled={Object.keys(edits).length === 0}>
                  Save the register
                </Button>
                {saved && (
                  <span
                    className="text-sm text-fg-muted"
                    data-testid={queued ? 'attendance-queued' : undefined}
                  >
                    {queued
                      ? 'Saved on this phone; it will be sent when there is signal (see the Outbox).'
                      : 'Saved.'}
                  </span>
                )}
              </div>
              {error && <Alert tone="danger">{error}</Alert>}
            </form>
          </Card>
        ))}
    </div>
  );
}
