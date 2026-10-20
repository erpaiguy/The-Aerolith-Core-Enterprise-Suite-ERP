// Approvals (docs/wave2b-plan.md step 1): what waits on me, what I submitted, what I decided; and someone to stand in
// for me while I am away.
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
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api/client';
import type { Person } from '../api/types';
import { APPROVAL_STATUS, APPROVAL_TONE, useRun, type ApprovalRow } from '../approvals/model';
import { describeError, formatDateTime, formatInr } from '../lib/format';
import { shortDate } from '../schedule/model';
import { useSession } from '../session/session';

type View = 'waiting' | 'mine' | 'decided';
const VIEWS: { key: View; label: string }[] = [
  { key: 'waiting', label: 'Waiting on me' },
  { key: 'mine', label: 'Submitted by me' },
  { key: 'decided', label: 'Decided by me' },
];

export function ApprovalsScreen() {
  const [view, setView] = useState<View>('waiting');
  const rows = useQuery({
    queryKey: ['approvals', view],
    queryFn: () => api.request<ApprovalRow[]>(`/api/tenant/approvals?view=${view}`),
  });
  return (
    <div className="space-y-5">
      <PageHeader
        title="Approvals"
        subtitle="Requisitions and other documents waiting for a decision, and those you sent or decided."
      />
      <div className="flex flex-wrap gap-1" role="tablist" aria-label="Approvals">
        {VIEWS.map((v) => (
          <Button
            key={v.key}
            role="tab"
            aria-selected={view === v.key}
            variant={view === v.key ? 'primary' : 'ghost'}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </Button>
        ))}
      </div>
      <Card>
        {rows.isPending ? (
          <Spinner />
        ) : rows.isError ? (
          <Alert tone="danger">{describeError(rows.error)}</Alert>
        ) : rows.data.length === 0 ? (
          <EmptyState title={view === 'waiting' ? 'Nothing waits on you.' : 'None yet.'}>
            {view === 'waiting'
              ? 'Requests that need your decision appear here.'
              : view === 'mine'
                ? 'Documents you put up for approval appear here.'
                : 'Requests you approve or reject appear here.'}
          </EmptyState>
        ) : (
          <Table minWidth="48rem">
            <thead>
              <tr>
                <th>Document</th>
                <th>Project</th>
                <th className="text-right">Amount</th>
                <th>Submitted</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody aria-label={VIEWS.find((v) => v.key === view)!.label}>
              {rows.data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link
                      to="/approvals/$approvalId"
                      params={{ approvalId: r.id }}
                      className="text-accent hover:underline"
                    >
                      {r.title}
                    </Link>
                    <span className="block text-xs text-fg-muted">{r.docLabel}</span>
                  </td>
                  <td className="text-sm">
                    {r.project ? `${r.project.number} · ${r.project.name}` : ''}
                  </td>
                  <td className="text-right tabular-nums">{formatInr(r.amount)}</td>
                  <td className="text-sm">
                    {r.submittedBy}
                    <span className="block text-xs text-fg-muted">
                      {formatDateTime(r.submittedAt)}
                    </span>
                  </td>
                  <td>
                    <Badge tone={APPROVAL_TONE[r.status]}>{APPROVAL_STATUS[r.status]}</Badge>
                    {r.status === 'pending' && r.levels > 0 && (
                      <span className="block text-xs text-fg-muted">
                        level {r.level} of {r.levels}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <StandIns />
    </div>
  );
}

interface Delegation {
  id: string;
  fromUserId: string;
  fromName: string;
  toUserId: string;
  toName: string;
  startsOn: string;
  endsOn: string;
  reason: string;
  active: boolean;
}

const indiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/** Someone approves for me (or, for the admin, for anyone) between two days. */
function StandIns() {
  const { user } = useSession();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const list = useQuery({
    queryKey: ['approval-delegations'],
    queryFn: () => api.request<Delegation[]>('/api/tenant/approval-delegations'),
  });
  const people = useQuery({
    queryKey: ['people'],
    queryFn: () => api.request<Person[]>('/api/tenant/people'),
  });
  const { run, busy, error } = useRun(
    () => void qc.invalidateQueries({ queryKey: ['approval-delegations'] }),
  );
  const [v, setV] = useState({
    fromUserId: '',
    toUserId: '',
    startsOn: indiaToday(),
    endsOn: '',
    reason: '',
  });
  const isAdmin = user?.role === 'admin';
  const others = (people.data ?? []).filter((p) => p.id !== (v.fromUserId || user?.id));
  return (
    <Card title="Standing in while away">
      <p className="mb-3 text-sm text-fg-muted">
        While you are away, someone else approves what waits on you, on your behalf. It shows who
        acted for whom. Nobody stands in on a request they submitted.
      </p>
      {list.data && list.data.length > 0 && (
        <ul className="mb-4 space-y-1.5 text-sm" aria-label="Stand-ins">
          {list.data.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2">
              <span>
                <b>{d.toName}</b> for <b>{d.fromName}</b>, {shortDate(d.startsOn)} –{' '}
                {shortDate(d.endsOn)}
                {d.reason && <span className="text-fg-muted"> ({d.reason})</span>}
              </span>
              {d.active && <Badge tone="success">now</Badge>}
              {(isAdmin || d.fromUserId === user?.id) && (
                <Button
                  variant="ghost"
                  busy={busy === d.id}
                  onClick={async () => {
                    if (
                      !(await confirm({
                        title: `Cancel ${d.toName}'s stand-in for ${d.fromName}?`,
                        body: `From now on, what waits on ${d.fromName} is no longer approved by ${d.toName}.`,
                        confirmLabel: 'Cancel the stand-in',
                        cancelLabel: 'Keep it',
                        tone: 'danger',
                      }))
                    )
                      return;
                    if (
                      await run(d.id, () =>
                        api.request(`/api/tenant/approval-delegations/${d.id}/cancel`, {
                          method: 'POST',
                        }),
                      )
                    )
                      toast.success('Stand-in cancelled');
                  }}
                >
                  Cancel
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="New stand-in"
        onSubmit={(e) => {
          e.preventDefault();
          void run('new', () =>
            api.request('/api/tenant/approval-delegations', {
              method: 'POST',
              body: { ...v, fromUserId: v.fromUserId || null },
            }),
          ).then((ok) => {
            if (!ok) return;
            setV({ ...v, toUserId: '', endsOn: '', reason: '' });
            toast.success('Stand-in added');
          });
        }}
      >
        {isAdmin && (
          <div className="w-48">
            <Field label="Approver away">
              <Select
                value={v.fromUserId}
                onChange={(e) => setV({ ...v, fromUserId: e.target.value })}
              >
                <option value="">Me</option>
                {(people.data ?? [])
                  .filter((p) => p.id !== user?.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="w-48">
          <Field label="Stands in">
            <Select
              value={v.toUserId}
              onChange={(e) => setV({ ...v, toUserId: e.target.value })}
              required
            >
              <option value="">Choose…</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="From">
          <Input
            type="date"
            value={v.startsOn}
            onChange={(e) => setV({ ...v, startsOn: e.target.value })}
            required
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={v.endsOn}
            min={v.startsOn}
            onChange={(e) => setV({ ...v, endsOn: e.target.value })}
            required
          />
        </Field>
        <Field label="Reason">
          <Input
            value={v.reason}
            maxLength={300}
            onChange={(e) => setV({ ...v, reason: e.target.value })}
          />
        </Field>
        <Button type="submit" variant="secondary" busy={busy === 'new'}>
          Add stand-in
        </Button>
      </form>
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}
