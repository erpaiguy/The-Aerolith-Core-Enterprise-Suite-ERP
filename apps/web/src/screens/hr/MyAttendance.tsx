// One's own attendance and leave (docs/wave3-plan.md step 11): marking in and out with the phone's location, the
// week's marks, leave balances and applications. Also the leave form HR uses for someone without a sign-in, and a
// leave application's own page (where approvals link).
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
import { Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../../api/client';
import { ApprovalSteps } from '../../approvals/ApprovalTrail';
import { today } from '../../accounts/model';
import { describeError } from '../../lib/format';
import { usePermission } from '../../session/permissions';
import { shortDate } from '../../schedule/model';
import { MyPayslips } from '../payroll/Payroll';
import {
  FLAG_LABEL,
  STATUS_LABEL,
  type EmployeeLeave,
  type LeaveDetail,
  type LeaveType,
  type Me,
} from './model';

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  approved: 'success',
  pending: 'warning',
  rejected: 'danger',
};

export function MyAttendanceScreen() {
  const me = useQuery({
    queryKey: ['hr-me'],
    queryFn: () => api.request<Me>('/api/tenant/hr/attendance/me'),
  });
  if (me.isPending) return <Spinner />;
  if (me.isError) return <Alert tone="danger">{describeError(me.error)}</Alert>;
  return (
    <div className="space-y-5">
      <PageHeader title="My attendance" subtitle="Mark yourself in and out, and apply for leave." />
      {!me.data.employee ? (
        <Alert tone="info">You have no employee record. Ask HR to link one to your sign-in.</Alert>
      ) : (
        <>
          <Today me={me.data} />
          <LeavePanel employeeId={me.data.employee.id} self />
          <MyPayslips />
        </>
      )}
    </div>
  );
}

function Today({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const punch = (action: 'in' | 'out') => {
    setError(null);
    if (!navigator.geolocation) {
      setError('This device cannot tell where it is.');
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        api
          .request<Me>('/api/tenant/hr/attendance/me', {
            method: 'POST',
            body: { action, latitude: pos.coords.latitude, longitude: pos.coords.longitude },
          })
          .then((data) => qc.setQueryData(['hr-me'], data))
          .catch((err: unknown) => setError(describeError(err)))
          .finally(() => setBusy(false));
      },
      () => {
        setBusy(false);
        setError('Allow this page to use your location to mark attendance.');
      },
      { enableHighAccuracy: true, timeout: 20_000 },
    );
  };
  const t = me.today;
  return (
    <Card title={`Today, ${shortDate(me.day!)}`}>
      <p className="mb-3 text-sm text-fg-muted">
        {me.site ? `${me.site.project}, ${me.site.name}` : 'Head office'}
        {me.kind === 'holiday' ? ' · a holiday' : me.kind === 'week_off' ? ' · a weekly off' : ''}
      </p>
      {t ? (
        <p className="mb-3 text-sm" data-testid="today-mark">
          <strong>{STATUS_LABEL[t.status]}</strong>
          {t.inTime && ` · in ${t.inTime}`}
          {t.outTime && ` · out ${t.outTime}`}
          {t.flag && (
            <>
              {' '}
              <Badge tone="warning">{FLAG_LABEL[t.flag] ?? t.flag}</Badge>
            </>
          )}
        </p>
      ) : (
        <p className="mb-3 text-sm text-fg-muted">Not marked yet.</p>
      )}
      <div className="flex gap-2">
        {!t && (
          <Button type="button" busy={busy} onClick={() => punch('in')}>
            Mark in
          </Button>
        )}
        {t?.inTime && !t.outTime && t.source === 'phone' && (
          <Button type="button" busy={busy} onClick={() => punch('out')}>
            Mark out
          </Button>
        )}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {me.recent && me.recent.length > 0 && (
        <Table minWidth="24rem">
          <thead>
            <tr>
              <th>Day</th>
              <th>Mark</th>
              <th>In</th>
              <th>Out</th>
            </tr>
          </thead>
          <tbody>
            {me.recent.map((r) => (
              <tr key={r.day}>
                <td>{shortDate(r.day)}</td>
                <td>
                  {STATUS_LABEL[r.status]}{' '}
                  {r.flag && <Badge tone="warning">{FLAG_LABEL[r.flag] ?? r.flag}</Badge>}
                </td>
                <td>{r.inTime ?? '—'}</td>
                <td>{r.outTime ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

/** An employee's leave for a year: balances, applications and the form to apply. */
export function LeavePanel({ employeeId, self = false }: { employeeId: string; self?: boolean }) {
  const qc = useQueryClient();
  const [year, setYear] = useState(Number(today().slice(0, 4)));
  const key = ['hr-leave', employeeId, year];
  const leave = useQuery({
    queryKey: key,
    queryFn: () =>
      api.request<EmployeeLeave>(`/api/tenant/hr/employees/${employeeId}/leave?year=${year}`),
  });
  const types = useQuery({
    queryKey: ['leave-types'],
    queryFn: () => api.request<LeaveType[]>('/api/tenant/hr/leave-types'),
  });
  const [f, setF] = useState({
    leaveTypeId: '',
    from: today(),
    to: today(),
    halfDay: false,
    reason: '',
  });
  const [error, setError] = useState<string | null>(null);
  const apply = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request('/api/tenant/hr/leave', {
        method: 'POST',
        body: { ...f, to: f.halfDay ? f.from : f.to, employeeId: self ? null : employeeId },
      });
      setF({ ...f, reason: '' });
      void qc.invalidateQueries({ queryKey: ['hr-leave', employeeId] });
      void qc.invalidateQueries({ queryKey: ['hr-leave-list'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  // HR sets each year's opening balance (carried from before the books, or corrected) for someone else's leave.
  const mayEdit = usePermission('hr.edit') && !self;
  const [o, setO] = useState({ leaveTypeId: '', days: '' });
  const setOpening = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request(`/api/tenant/hr/employees/${employeeId}/leave-openings`, {
        method: 'PUT',
        body: { year, leaveTypeId: o.leaveTypeId, days: o.days },
      });
      setO({ leaveTypeId: '', days: '' });
      void qc.invalidateQueries({ queryKey: ['hr-leave', employeeId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const withdraw = async (id: string) => {
    setError(null);
    try {
      await api.request(`/api/tenant/hr/leave/${id}/withdraw`, { method: 'POST' });
      void qc.invalidateQueries({ queryKey: ['hr-leave', employeeId] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  return (
    <Card
      title="Leave"
      actions={
        <Select
          aria-label="Leave year"
          value={String(year)}
          onChange={(e) => setYear(Number(e.target.value))}
        >
          {[year - 1, year, year + 1].map((y) => (
            <option key={y}>{y}</option>
          ))}
        </Select>
      }
    >
      {leave.isPending ? (
        <Spinner />
      ) : leave.isError ? (
        <Alert tone="danger">{describeError(leave.error)}</Alert>
      ) : (
        <>
          <Table minWidth="32rem">
            <thead>
              <tr>
                <th>Leave</th>
                <th className="text-right">Opening</th>
                <th className="text-right">Accrued</th>
                <th className="text-right">Taken</th>
                <th className="text-right">Waiting</th>
                <th className="text-right">Available</th>
              </tr>
            </thead>
            <tbody>
              {leave.data.balances.map((b) => (
                <tr key={b.leaveTypeId} data-testid={`balance-${b.code}`}>
                  <td>
                    {b.name} {!b.paid && <Badge>unpaid</Badge>}
                  </td>
                  <td className="text-right">{b.opening}</td>
                  <td className="text-right">{b.accrued}</td>
                  <td className="text-right">{b.taken}</td>
                  <td className="text-right">{b.pending}</td>
                  <td className="text-right font-medium">{b.available ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="mt-1 text-xs text-fg-muted">Accrued up to {shortDate(leave.data.asOf)}.</p>
          {mayEdit && (
            <form
              aria-label="Opening balance"
              className="mt-3 flex flex-wrap items-end gap-3"
              onSubmit={(e) => void setOpening(e)}
            >
              <Field label={`Opening for ${year}`}>
                <Select
                  value={o.leaveTypeId}
                  onChange={(e) => setO({ ...o, leaveTypeId: e.target.value })}
                  required
                >
                  <option value="">Leave…</option>
                  {leave.data.balances
                    .filter((b) => b.paid)
                    .map((b) => (
                      <option key={b.leaveTypeId} value={b.leaveTypeId}>
                        {b.name}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Days">
                <Input
                  inputMode="decimal"
                  value={o.days}
                  onChange={(e) => setO({ ...o, days: e.target.value })}
                  placeholder="e.g. 4.5"
                  required
                />
              </Field>
              <Button type="submit" variant="secondary">
                Set opening
              </Button>
            </form>
          )}
          {leave.data.applications.length > 0 && (
            <Table minWidth="32rem">
              <thead>
                <tr>
                  <th>Leave</th>
                  <th>From</th>
                  <th>To</th>
                  <th className="text-right">Days</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {leave.data.applications.map((a) => (
                  <tr key={a.id}>
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
                    <td>
                      <Badge tone={STATUS_TONE[a.status] ?? 'neutral'}>{a.status}</Badge>
                    </td>
                    <td>
                      {a.status === 'pending' && self && (
                        <Button type="button" variant="ghost" onClick={() => void withdraw(a.id)}>
                          Withdraw
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </>
      )}
      <form
        aria-label="Apply for leave"
        className="mt-4 grid gap-3 sm:grid-cols-5"
        onSubmit={(e) => void apply(e)}
      >
        <Field label="Leave">
          <Select
            value={f.leaveTypeId}
            onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}
            required
          >
            <option value="">Choose…</option>
            {(types.data ?? [])
              .filter((t) => t.active)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="From">
          <Input
            type="date"
            value={f.from}
            onChange={(e) => setF({ ...f, from: e.target.value })}
            required
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={f.halfDay ? f.from : f.to}
            disabled={f.halfDay}
            onChange={(e) => setF({ ...f, to: e.target.value })}
            required
          />
        </Field>
        <Field label="Reason">
          <Input
            value={f.reason}
            maxLength={500}
            onChange={(e) => setF({ ...f, reason: e.target.value })}
          />
        </Field>
        <div className="flex items-end gap-3">
          <label className="flex items-center gap-1.5 pb-2 text-sm">
            <input
              type="checkbox"
              checked={f.halfDay}
              onChange={(e) => setF({ ...f, halfDay: e.target.checked })}
            />
            Half day
          </label>
          <Button type="submit">Apply</Button>
        </div>
      </form>
      {error && <Alert tone="danger">{error}</Alert>}
    </Card>
  );
}

export function LeaveScreen({ leaveId }: { leaveId: string }) {
  const qc = useQueryClient();
  const key = ['hr-leave-application', leaveId];
  const l = useQuery({
    queryKey: key,
    queryFn: () => api.request<LeaveDetail>(`/api/tenant/hr/leave/${leaveId}`),
  });
  const [error, setError] = useState<string | null>(null);
  const act = async (what: 'withdraw' | 'cancel') => {
    setError(null);
    try {
      qc.setQueryData(
        key,
        await api.request<LeaveDetail>(`/api/tenant/hr/leave/${leaveId}/${what}`, {
          method: 'POST',
        }),
      );
      void qc.invalidateQueries({ queryKey: ['hr-leave'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  if (l.isPending) return <Spinner />;
  if (l.isError) return <Alert tone="danger">{describeError(l.error)}</Alert>;
  const d = l.data;
  return (
    <div className="space-y-5">
      <PageHeader
        title={`${d.leaveType}: ${d.employee}`}
        subtitle={`${d.employeeCode} · ${shortDate(d.from)}${d.halfDay ? ' (half day)' : d.to !== d.from ? ` to ${shortDate(d.to)}` : ''} · ${d.days} days`}
        actions={
          <div className="flex gap-2">
            {d.mayWithdraw && (
              <Button type="button" variant="secondary" onClick={() => void act('withdraw')}>
                Withdraw
              </Button>
            )}
            {d.mayCancel && (
              <Button type="button" variant="secondary" onClick={() => void act('cancel')}>
                Cancel the leave
              </Button>
            )}
          </div>
        }
      />
      <Card>
        <p className="text-sm">
          <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{d.status}</Badge>{' '}
          {d.paid ? 'Paid leave' : 'Unpaid leave'}
          {d.reason && ` · ${d.reason}`}
        </p>
        {d.approval && <ApprovalSteps approval={d.approval} />}
      </Card>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
