// People (docs/wave3-plan.md step 11): the employees, each month's days for payroll, leave applications, a biometric
// device's file, and the setup: designations (what they add, who approves), calendars, sites and leave types.
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Spinner,
  Table,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { shortDate } from '../../schedule/model';
import { usePermission } from '../../session/permissions';
import { Books } from '../accounts/Vouchers';
import {
  WEEKDAYS,
  type Calendar,
  type Designation,
  type EmployeeRow,
  type HrSite,
  type LeaveApplicationRow,
  type LeaveType,
  type MonthRow,
} from './model';
import { useFocusForm, useNewParam } from '../../lib/new-param';

const TABS = ['Employees', 'Month', 'Leave', 'Import', 'Setup'] as const;
type Tab = (typeof TABS)[number];
const prevMonth = () => {
  const d = today();
  const [y, m] = [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export function PeopleScreen() {
  const [tab, setTab] = useState<Tab>('Employees');
  const mayEdit = usePermission('hr.edit');
  return (
    <Books title="People">
      {(entityId) => (
        <>
          <div className="flex flex-wrap gap-1" role="tablist">
            {TABS.filter((t) => mayEdit || (t !== 'Import' && t !== 'Setup')).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`rounded-md px-3 py-1.5 text-sm ${tab === t ? 'bg-surface-2 font-medium' : 'text-fg-muted hover:bg-surface-2'}`}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === 'Employees' && <Employees entityId={entityId} />}
          {tab === 'Month' && <Month entityId={entityId} />}
          {tab === 'Leave' && <LeaveList entityId={entityId} />}
          {tab === 'Import' && <Import entityId={entityId} />}
          {tab === 'Setup' && (
            <>
              <Designations />
              <Calendars entityId={entityId} />
              <Sites entityId={entityId} />
              <LeaveTypes entityId={entityId} />
            </>
          )}
        </>
      )}
    </Books>
  );
}

export function useDesignations() {
  return useQuery({
    queryKey: ['designations'],
    queryFn: () => api.request<Designation[]>('/api/tenant/hr/designations'),
  });
}

function Employees({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const mayEdit = usePermission('hr.edit');
  const key = ['employees', entityId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => api.request<EmployeeRow[]>(`/api/tenant/hr/employees?entityId=${entityId}`),
  });
  const designations = useDesignations();
  const asked = useNewParam('employee');
  const [adding, setAdding] = useState(asked);
  useEffect(() => {
    if (asked) setAdding(true);
  }, [asked]);
  useFocusForm('New employee', asked && adding);
  const [f, setF] = useState({
    code: '',
    name: '',
    kind: 'staff',
    joinedOn: today(),
    designationId: '',
    department: '',
  });
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request('/api/tenant/hr/employees', {
        method: 'POST',
        body: { entityId, ...f, designationId: f.designationId || null },
      });
      setAdding(false);
      toast.success(`Employee ${f.code} ${f.name} added`);
      setF({ ...f, code: '', name: '' });
      void qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card
      title="Employees"
      actions={
        mayEdit &&
        !adding && (
          <Button type="button" onClick={() => setAdding(true)}>
            Add an employee
          </Button>
        )
      }
    >
      {adding && (
        <form
          aria-label="New employee"
          className="mb-4 grid gap-3 sm:grid-cols-4"
          onSubmit={(e) => void add(e)}
        >
          <Field label="Code">
            <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required />
          </Field>
          <Field label="Name">
            <Input
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <Field label="Staff or worker">
            <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
              <option value="staff">Staff</option>
              <option value="worker">Worker</option>
            </Select>
          </Field>
          <Field label="Joined on">
            <Input
              type="date"
              value={f.joinedOn}
              onChange={(e) => setF({ ...f, joinedOn: e.target.value })}
              required
            />
          </Field>
          <Field label="Designation">
            <Select
              value={f.designationId}
              onChange={(e) => setF({ ...f, designationId: e.target.value })}
            >
              <option value="">None</option>
              {(designations.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Department">
            <Input
              value={f.department}
              onChange={(e) => setF({ ...f, department: e.target.value })}
            />
          </Field>
          <div className="flex items-end gap-2">
            <Button type="submit">Add</Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{describeError(list.error)}</Alert>
      ) : list.data.length === 0 ? (
        <EmptyState title="No employees yet.">
          Add an employee to deploy them, mark attendance and run payroll.
        </EmptyState>
      ) : (
        <Table minWidth="44rem">
          <thead>
            <tr>
              <th>Code</th>
              <th>Name</th>
              <th>Designation</th>
              <th>Where</th>
              <th>Joined</th>
              <th>Sign-in</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((e) => (
              <tr key={e.id}>
                <td>
                  <Link
                    to="/hr/employees/$employeeId"
                    params={{ employeeId: e.id }}
                    className="font-medium hover:underline"
                  >
                    {e.code}
                  </Link>
                </td>
                <td>
                  {e.name} {e.kind === 'worker' && <Badge>worker</Badge>}
                </td>
                <td>{e.designation ?? '—'}</td>
                <td>
                  {e.place?.project ? `${e.place.project}, ${e.place.site ?? '—'}` : 'Head office'}
                </td>
                <td>{shortDate(e.joinedOn)}</td>
                <td>{e.username ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Month({ entityId }: { entityId: string }) {
  const [month, setMonth] = useState(prevMonth());
  const m = useQuery({
    queryKey: ['hr-month', entityId, month],
    queryFn: () =>
      api.request<{ days: string[]; rows: MonthRow[] }>(
        `/api/tenant/hr/attendance/month?entityId=${entityId}&month=${month}`,
      ),
  });
  return (
    <Card
      title="The month's days"
      actions={
        <Input
          type="month"
          aria-label="Month"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
        />
      }
    >
      <p className="mb-2 text-xs text-fg-muted">
        P present · H half day · L paid leave · U unpaid · HO holiday · WO weekly off · A absent.
        Payable: present, paid leave, holidays and weekly offs.
      </p>
      {m.isPending ? (
        <Spinner />
      ) : m.isError ? (
        <Alert tone="danger">{describeError(m.error)}</Alert>
      ) : (
        <Table minWidth="60rem">
          <thead>
            <tr>
              <th>Employee</th>
              <th className="text-right">Present</th>
              <th className="text-right">Half</th>
              <th className="text-right">Leave</th>
              <th className="text-right">Unpaid</th>
              <th className="text-right">Holidays</th>
              <th className="text-right">Weekly off</th>
              <th className="text-right">Absent</th>
              <th className="text-right">Payable</th>
              <th>Days</th>
            </tr>
          </thead>
          <tbody>
            {m.data.rows.map((r) => (
              <tr key={r.employeeId} data-testid={`month-${r.code}`}>
                <td>
                  {r.code} {r.name}{' '}
                  {r.flagged > 0 && <Badge tone="warning">{r.flagged} flagged</Badge>}
                </td>
                <td className="text-right">{Number(r.present) + Number(r.onDuty)}</td>
                <td className="text-right">{r.halfDays}</td>
                <td className="text-right">{r.paidLeave}</td>
                <td className="text-right">{r.unpaidLeave}</td>
                <td className="text-right">{r.holidays}</td>
                <td className="text-right">{r.weeklyOffs}</td>
                <td className="text-right">{r.absent}</td>
                <td className="text-right font-medium">{r.payable}</td>
                <td className="whitespace-nowrap font-mono text-[10px]">
                  {r.codes.map((c) => c || '·').join(' ')}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function LeaveList({ entityId }: { entityId: string }) {
  const [status, setStatus] = useState('pending');
  const list = useQuery({
    queryKey: ['hr-leave-list', entityId, status],
    queryFn: () =>
      api.request<LeaveApplicationRow[]>(
        `/api/tenant/hr/leave?entityId=${entityId}${status ? `&status=${status}` : ''}`,
      ),
  });
  return (
    <Card
      title="Leave applications"
      actions={
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">Waiting</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </Select>
      }
    >
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{describeError(list.error)}</Alert>
      ) : list.data.length === 0 ? (
        <EmptyState title="None.">Leave people apply for shows here.</EmptyState>
      ) : (
        <Table minWidth="40rem">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Leave</th>
              <th>From</th>
              <th>To</th>
              <th className="text-right">Days</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.employeeCode} {a.employee}
                </td>
                <td>
                  <Link
                    to="/hr/leave/$leaveId"
                    params={{ leaveId: a.id }}
                    className="hover:underline"
                  >
                    {a.leaveType}
                  </Link>
                </td>
                <td>{shortDate(a.from)}</td>
                <td>{a.halfDay ? 'half day' : shortDate(a.to)}</td>
                <td className="text-right">{a.days}</td>
                <td>{a.status}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Import({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    problems: { code: string; day: string; reason: string }[];
    unreadRows: number[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.upload<NonNullable<typeof result>>(
        `/api/tenant/hr/attendance/import?entityId=${entityId}`,
        file,
      );
      setResult(r);
      toast.success(`${r.imported} attendance days imported`);
      void qc.invalidateQueries({ queryKey: ['hr-month'] });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="A biometric device's file">
      <p className="mb-3 text-sm text-fg-muted">
        CSV or Excel with a header row: the employee code, the date and the time of each punch (or
        one column with both). First punch in, last out; four hours or more is a full day.
      </p>
      <form
        aria-label="Import punches"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => void send(e)}
      >
        <Field label="File">
          <Input
            type="file"
            accept=".csv,.xlsx,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            required
          />
        </Field>
        <Button type="submit" busy={busy}>
          Import
        </Button>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
      {result && (
        <div className="mt-3 space-y-2 text-sm" data-testid="import-result">
          <p>
            {result.imported} days imported
            {result.unreadRows.length > 0 && `; rows not read: ${result.unreadRows.join(', ')}`}.
          </p>
          {result.problems.length > 0 && (
            <ul className="list-disc pl-5">
              {result.problems.map((p) => (
                <li key={`${p.code}-${p.day}`}>
                  {p.code}, {shortDate(p.day)}: {p.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function Designations() {
  const qc = useQueryClient();
  const list = useDesignations();
  const permissions = useQuery({
    queryKey: ['hr-permissions'],
    queryFn: () => api.request<{ key: string; label: string }[]>('/api/tenant/hr/permissions'),
  });
  const [edit, setEdit] = useState<{
    id: string | null;
    name: string;
    permissions: string[];
    rowVersion?: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    setError(null);
    try {
      await api.request(`/api/tenant/hr/designations${edit.id ? `/${edit.id}` : ''}`, {
        method: edit.id ? 'PUT' : 'POST',
        body: { name: edit.name, permissions: edit.permissions, rowVersion: edit.rowVersion },
      });
      toast.success(`Designation ${edit.name} saved`);
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ['designations'] });
      void qc.invalidateQueries({ queryKey: ['my-permissions'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card
      title="Designations"
      actions={
        !edit && (
          <Button type="button" onClick={() => setEdit({ id: null, name: '', permissions: [] })}>
            Add a designation
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-fg-muted">
        A designation adds permissions to its holders&apos; role (never takes any away), and
        approval rules can name it as the approver.
      </p>
      {edit && (
        <form aria-label="Designation" className="mb-4 space-y-3" onSubmit={(e) => void save(e)}>
          <Field label="Name">
            <Input
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              required
              minLength={2}
            />
          </Field>
          <fieldset className="grid gap-1 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-medium">Adds</legend>
            {(permissions.data ?? []).map((p) => (
              <label key={p.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={edit.permissions.includes(p.key)}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      permissions: e.target.checked
                        ? [...edit.permissions, p.key]
                        : edit.permissions.filter((x) => x !== p.key),
                    })
                  }
                />
                <span>{p.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <Button type="submit">Save</Button>
            <Button type="button" variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {list.data && list.data.length > 0 && (
        <Table minWidth="30rem">
          <thead>
            <tr>
              <th>Designation</th>
              <th>Adds</th>
              <th className="text-right">Holders</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td className="text-xs">{d.permissions.join(', ') || '—'}</td>
                <td className="text-right">{d.holders}</td>
                <td>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      setEdit({
                        id: d.id,
                        name: d.name,
                        permissions: d.permissions,
                        rowVersion: d.rowVersion,
                      })
                    }
                  >
                    Edit
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function useCalendars(entityId: string) {
  return useQuery({
    queryKey: ['hr-calendars', entityId],
    queryFn: () => api.request<Calendar[]>(`/api/tenant/hr/calendars?entityId=${entityId}`),
  });
}

function Calendars({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const list = useCalendars(entityId);
  const [f, setF] = useState({ name: '', workWeek: 63, isDefault: false });
  const [holiday, setHoliday] = useState<Record<string, { day: string; name: string }>>({});
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const done = (data: Calendar[]) => qc.setQueryData(['hr-calendars', entityId], data);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      done(
        await api.request('/api/tenant/hr/calendars', { method: 'POST', body: { entityId, ...f } }),
      );
      toast.success(`Calendar ${f.name} added`);
      setF({ name: '', workWeek: 63, isDefault: false });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const setDay = async (calendarId: string, day: string, name: string | null, was = '') => {
    if (
      name === null &&
      !(await confirm({
        title: `Remove the holiday ${was} on ${shortDate(day)}?`,
        body: 'The day becomes a working day on this calendar, for attendance and payroll.',
        confirmLabel: 'Remove the holiday',
        tone: 'danger',
      }))
    )
      return;
    setError(null);
    try {
      done(
        await api.request(`/api/tenant/hr/calendars/${calendarId}/holidays`, {
          method: 'PUT',
          body: { day, name },
        }),
      );
      setHoliday({ ...holiday, [calendarId]: { day: '', name: '' } });
      toast.success(name === null ? 'Holiday removed' : `Holiday ${name} added`);
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Holiday calendars">
      {error && <Alert tone="danger">{error}</Alert>}
      {(list.data ?? []).map((c) => {
        const h = holiday[c.id] ?? { day: '', name: '' };
        return (
          <div
            key={c.id}
            className="mb-4 rounded-md border border-line p-3"
            aria-label={`Calendar ${c.name}`}
            role="group"
          >
            <p className="text-sm font-medium">
              {c.name} {c.isDefault && <Badge tone="accent">default</Badge>}{' '}
              <span className="font-normal text-fg-muted">
                {WEEKDAYS.filter((_, i) => c.workWeek & (1 << i)).join(', ')}
              </span>
            </p>
            {c.sites.length > 0 && (
              <p className="text-xs text-fg-muted">
                Sites: {c.sites.map((s) => `${s.project} ${s.site}`).join('; ')}
              </p>
            )}
            <ul className="my-2 text-sm">
              {c.holidays.map((x) => (
                <li key={x.day} className="flex items-center gap-2">
                  {shortDate(x.day)} {x.name}
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void setDay(c.id, x.day, null, x.name)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
            <form
              className="flex flex-wrap items-end gap-2"
              aria-label={`Holiday for ${c.name}`}
              onSubmit={(e) => {
                e.preventDefault();
                void setDay(c.id, h.day, h.name);
              }}
            >
              <Field label="Holiday">
                <Input
                  type="date"
                  value={h.day}
                  onChange={(e) =>
                    setHoliday({ ...holiday, [c.id]: { ...h, day: e.target.value } })
                  }
                  required
                />
              </Field>
              <Field label="Name">
                <Input
                  value={h.name}
                  onChange={(e) =>
                    setHoliday({ ...holiday, [c.id]: { ...h, name: e.target.value } })
                  }
                  required
                  minLength={2}
                />
              </Field>
              <Button type="submit" variant="secondary">
                Add holiday
              </Button>
            </form>
          </div>
        );
      })}
      <form
        aria-label="New calendar"
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => void add(e)}
      >
        <Field label="Calendar">
          <Input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <fieldset className="flex gap-2 pb-2 text-sm">
          <legend className="sr-only">Working days</legend>
          {WEEKDAYS.map((d, i) => (
            <label key={d} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={Boolean(f.workWeek & (1 << i))}
                onChange={(e) =>
                  setF({
                    ...f,
                    workWeek: e.target.checked ? f.workWeek | (1 << i) : f.workWeek & ~(1 << i),
                  })
                }
              />
              {d}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-1 pb-2 text-sm">
          <input
            type="checkbox"
            checked={f.isDefault}
            onChange={(e) => setF({ ...f, isDefault: e.target.checked })}
          />
          The company&apos;s default
        </label>
        <Button type="submit">Add calendar</Button>
      </form>
    </Card>
  );
}

function Sites({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const sites = useQuery({
    queryKey: ['hr-sites', entityId],
    queryFn: () => api.request<HrSite[]>(`/api/tenant/hr/sites?entityId=${entityId}`),
  });
  const calendars = useCalendars(entityId);
  const [edits, setEdits] = useState<Record<string, Partial<HrSite>>>({});
  const [error, setError] = useState<string | null>(null);
  const save = async (s: HrSite) => {
    const e = { ...s, ...edits[s.id] };
    setError(null);
    try {
      await api.request(`/api/tenant/hr/sites/${s.id}`, {
        method: 'PUT',
        body: {
          calendarId: e.calendarId || null,
          latitude: e.latitude || null,
          longitude: e.longitude || null,
          radiusM: e.radiusM ? Number(e.radiusM) : null,
        },
      });
      toast.success(`Site ${s.name} saved`);
      void qc.invalidateQueries({ queryKey: ['hr-sites', entityId] });
      void qc.invalidateQueries({ queryKey: ['hr-calendars', entityId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Sites">
      <p className="mb-3 text-sm text-fg-muted">
        Each site&apos;s calendar (else the company&apos;s default) and where it is, for marking
        attendance by phone.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {sites.data && sites.data.length > 0 ? (
        <Table minWidth="48rem">
          <thead>
            <tr>
              <th>Site</th>
              <th>Calendar</th>
              <th>Latitude</th>
              <th>Longitude</th>
              <th>Radius (m)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sites.data.map((s) => {
              const e = { ...s, ...edits[s.id] };
              const set = (patch: Partial<HrSite>) =>
                setEdits({ ...edits, [s.id]: { ...edits[s.id], ...patch } });
              return (
                <tr key={s.id} aria-label={`Site ${s.name}`}>
                  <td>
                    {s.project} {s.name}
                  </td>
                  <td>
                    <Select
                      aria-label="Calendar"
                      value={e.calendarId ?? ''}
                      onChange={(x) => set({ calendarId: x.target.value || null })}
                    >
                      <option value="">The default</option>
                      {(calendars.data ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td>
                    <Input
                      aria-label="Latitude"
                      inputMode="decimal"
                      value={e.latitude ?? ''}
                      onChange={(x) => set({ latitude: x.target.value })}
                    />
                  </td>
                  <td>
                    <Input
                      aria-label="Longitude"
                      inputMode="decimal"
                      value={e.longitude ?? ''}
                      onChange={(x) => set({ longitude: x.target.value })}
                    />
                  </td>
                  <td>
                    <Input
                      aria-label="Radius"
                      inputMode="numeric"
                      value={e.radiusM ?? ''}
                      onChange={(x) =>
                        set({ radiusM: x.target.value ? Number(x.target.value) : null })
                      }
                    />
                  </td>
                  <td>
                    <Button type="button" variant="secondary" onClick={() => void save(s)}>
                      Save
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      ) : (
        <EmptyState title="No sites on this company's projects.">
          Add sites to the company&apos;s projects to give them a calendar and a place for marking
          attendance.
        </EmptyState>
      )}
    </Card>
  );
}

function LeaveTypes({ entityId }: { entityId: string }) {
  const qc = useQueryClient();
  const types = useQuery({
    queryKey: ['leave-types'],
    queryFn: () => api.request<LeaveType[]>('/api/tenant/hr/leave-types'),
  });
  const [f, setF] = useState({
    code: '',
    name: '',
    paid: true,
    daysPerYear: '12',
    accrual: 'annual',
    carryForwardMax: '0',
  });
  const [year, setYear] = useState(String(Number(today().slice(0, 4)) - 1));
  const [carried, setCarried] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      qc.setQueryData(
        ['leave-types'],
        await api.request('/api/tenant/hr/leave-types', { method: 'POST', body: f }),
      );
      toast.success(`Leave type ${f.name} added`);
      setF({ ...f, code: '', name: '' });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const confirm = useConfirm();
  const carry = async () => {
    if (
      !(await confirm({
        title: `Close the leave year ${year}?`,
        body: `Each person's unused leave, up to each type's limit, is carried into ${Number(year) + 1} as its opening balance.`,
        confirmLabel: 'Carry balances forward',
        tone: 'primary',
      }))
    )
      return;
    setError(null);
    try {
      const r = await api.request<{ rows: unknown[] }>('/api/tenant/hr/leave/carry-forward', {
        method: 'POST',
        body: { entityId, year: Number(year) },
      });
      setCarried(`${r.rows.length} balances carried into ${Number(year) + 1}.`);
      toast.success(`Leave year ${year} closed`);
      void qc.invalidateQueries({ queryKey: ['hr-leave'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card title="Leave types">
      {error && <Alert tone="danger">{error}</Alert>}
      {types.data && types.data.length > 0 && (
        <Table minWidth="36rem">
          <thead>
            <tr>
              <th>Code</th>
              <th>Leave</th>
              <th className="text-right">Days a year</th>
              <th>Credited</th>
              <th className="text-right">Carried up to</th>
            </tr>
          </thead>
          <tbody>
            {types.data.map((t) => (
              <tr key={t.id}>
                <td>{t.code}</td>
                <td>
                  {t.name} {!t.paid && <Badge>unpaid</Badge>} {!t.active && <Badge>retired</Badge>}
                </td>
                <td className="text-right">{t.daysPerYear}</td>
                <td>{t.accrual === 'monthly' ? 'Monthly' : 'On 1 January'}</td>
                <td className="text-right">{t.carryForwardMax}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <form
        aria-label="New leave type"
        className="mt-3 grid gap-3 sm:grid-cols-6"
        onSubmit={(e) => void add(e)}
      >
        <Field label="Code">
          <Input
            value={f.code}
            maxLength={6}
            onChange={(e) => setF({ ...f, code: e.target.value })}
            required
          />
        </Field>
        <Field label="Name">
          <Input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            required
            minLength={2}
          />
        </Field>
        <Field label="Days a year">
          <Input
            inputMode="decimal"
            value={f.daysPerYear}
            onChange={(e) => setF({ ...f, daysPerYear: e.target.value })}
          />
        </Field>
        <Field label="Credited">
          <Select value={f.accrual} onChange={(e) => setF({ ...f, accrual: e.target.value })}>
            <option value="annual">On 1 January</option>
            <option value="monthly">Monthly</option>
          </Select>
        </Field>
        <Field label="Carry up to">
          <Input
            inputMode="decimal"
            value={f.carryForwardMax}
            onChange={(e) => setF({ ...f, carryForwardMax: e.target.value })}
          />
        </Field>
        <div className="flex items-end gap-3">
          <label className="flex items-center gap-1 pb-2 text-sm">
            <input
              type="checkbox"
              checked={f.paid}
              onChange={(e) => setF({ ...f, paid: e.target.checked })}
            />
            Paid
          </label>
          <Button type="submit">Add</Button>
        </div>
      </form>
      <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-3">
        <Field label="Close the leave year">
          <Input
            inputMode="numeric"
            value={year}
            onChange={(e) => setYear(e.target.value)}
            className="w-24"
          />
        </Field>
        <Button type="button" variant="secondary" onClick={() => void carry()}>
          Carry balances forward
        </Button>
        {carried && <span className="pb-2 text-sm text-fg-muted">{carried}</span>}
      </div>
    </Card>
  );
}
