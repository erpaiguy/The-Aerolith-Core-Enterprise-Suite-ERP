import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Spinner,
  toast,
  useConfirm,
} from '@aerolith/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type EmailRow, type Suppression } from '../api';
import { errorMessage, formatDateTime } from '../format';
import { useAction } from '../hooks';
import { useSession } from '../session';
import { PageHeader, Stat, Table } from './Shell';

const STATUSES = ['all', 'failed', 'queued', 'sent', 'suppressed'] as const;
type Filter = (typeof STATUSES)[number];

const statusTone = (s: EmailRow['status']) =>
  s === 'sent' ? 'success' : s === 'failed' ? 'danger' : s === 'suppressed' ? 'warning' : 'neutral';

function TestEmail() {
  const { operator } = useSession();
  const [to, setTo] = useState(operator?.email ?? '');
  const send = useAction(() => api.post('/api/owner/emails/test', { email: to.trim() }), {
    invalidate: [['emails']],
    success: () => 'Queued. The worker sends it within about 10 seconds; watch the list below.',
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send.run();
  };
  return (
    <Card title="Send a test email">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="min-w-[16rem] flex-1">
          <Field label="To">
            <Input
              name="testEmail"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              required
            />
          </Field>
        </div>
        <Button type="submit" variant="secondary" busy={send.busy}>
          Send test
        </Button>
      </form>
      {send.done && (
        <div className="mt-3">
          <Alert tone="success">{send.done}</Alert>
        </div>
      )}
      {send.error && (
        <div className="mt-3">
          <Alert tone="danger">{send.error}</Alert>
        </div>
      )}
    </Card>
  );
}

function Suppressions() {
  const { canWrite } = useSession();
  const confirm = useConfirm();
  const [email, setEmail] = useState('');
  const list = useQuery({
    queryKey: ['suppressions'],
    queryFn: () => api.get<Suppression[]>('/api/owner/email-suppressions'),
  });
  const add = useAction(
    () =>
      api.post('/api/owner/email-suppressions', { email: email.trim(), detail: 'added by owner' }),
    {
      invalidate: [['suppressions']],
      success: () => {
        toast.success('Added to the do-not-send list');
        return null;
      },
    },
  );
  const remove = useAction(
    (address: string) => api.post('/api/owner/email-suppressions/remove', { email: address }),
    {
      invalidate: [['suppressions']],
      success: () => {
        toast.success('Removed from the do-not-send list');
        return null;
      },
    },
  );
  return (
    <Card title="Do-not-send list">
      <p className="mb-3 text-sm text-fg-muted">
        Addresses that bounced permanently, or that you added. Nothing is sent to them until
        removed.
      </p>
      {canWrite && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void add.run().then(() => setEmail(''));
          }}
          className="mb-4 flex flex-wrap items-end gap-3"
        >
          <div className="min-w-[16rem] flex-1">
            <Field label="Add address">
              <Input
                name="suppressEmail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </Field>
          </div>
          <Button type="submit" variant="secondary" busy={add.busy}>
            Add
          </Button>
        </form>
      )}
      {(add.error ?? remove.error) && (
        <div className="mb-3">
          <Alert tone="danger">{add.error ?? remove.error}</Alert>
        </div>
      )}
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : list.data.length === 0 ? (
        <EmptyState title="Empty">
          Addresses that bounce permanently are added by themselves; add one above to stop mail to
          it.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Reason</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={s.email}>
                <td>{s.email}</td>
                <td className="text-fg-muted" title={s.detail}>
                  {s.reason.replace('_', ' ')}
                </td>
                <td className="whitespace-nowrap text-fg-muted">{formatDateTime(s.createdAt)}</td>
                <td className="text-right">
                  {canWrite && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={async () => {
                        if (
                          !(await confirm({
                            title: `Remove ${s.email} from the do-not-send list?`,
                            body: 'Email is sent to this address again.',
                            confirmLabel: 'Remove the address',
                            tone: 'danger',
                          }))
                        )
                          return;
                        void remove.run(s.email);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

export function EmailScreen() {
  const { canWrite } = useSession();
  const [filter, setFilter] = useState<Filter>('all');
  const summary = useQuery({
    queryKey: ['emails', 'summary'],
    queryFn: () =>
      api.get<{ last7Days: Record<string, number>; sentLastHour: number }>(
        '/api/owner/emails/summary',
      ),
    refetchInterval: 15_000,
  });
  const emails = useQuery({
    queryKey: ['emails', filter],
    queryFn: () =>
      api.get<EmailRow[]>(
        `/api/owner/emails?limit=100${filter === 'all' ? '' : `&status=${filter}`}`,
      ),
    refetchInterval: 15_000,
  });
  const retry = useAction((id: string) => api.post(`/api/owner/emails/${id}/retry`), {
    invalidate: [['emails']],
    success: () => {
      toast.success('Email queued to send again');
      return null;
    },
  });
  const s = summary.data?.last7Days ?? {};

  return (
    <div className="space-y-6">
      <PageHeader title="Email" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Sent (7 days)" value={s.sent ?? 0} />
        <Stat label="Sent (last hour)" value={summary.data?.sentLastHour ?? 0} />
        <Stat label="Waiting" value={(s.queued ?? 0) + (s.sending ?? 0)} />
        <Stat
          label="Failed (7 days)"
          value={s.failed ?? 0}
          {...(s.failed ? { tone: 'danger' as const } : {})}
        />
      </div>

      {canWrite && <TestEmail />}

      <Card
        title="Recent emails"
        actions={
          <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
            {STATUSES.map((st) => (
              <button
                key={st}
                type="button"
                aria-pressed={filter === st}
                onClick={() => setFilter(st)}
                className={`rounded-md px-2.5 py-1 text-xs ${filter === st ? 'bg-surface-3 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2'}`}
              >
                {st}
              </button>
            ))}
          </div>
        }
      >
        <p className="mb-3 text-xs text-fg-muted">
          Links, licence keys and message bodies are never shown here.
        </p>
        {retry.error && (
          <div className="mb-3">
            <Alert tone="danger">{retry.error}</Alert>
          </div>
        )}
        {emails.isPending ? (
          <Spinner />
        ) : emails.isError ? (
          <Alert tone="danger">{errorMessage(emails.error)}</Alert>
        ) : emails.data.length === 0 ? (
          <EmptyState title="No emails">
            {filter === 'all'
              ? 'Email the console or the apps send is listed here.'
              : 'None with this status; choose another filter.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Created</th>
                <th>To</th>
                <th>Template</th>
                <th>Status</th>
                <th>Attempts</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {emails.data.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap text-fg-muted">{formatDateTime(e.createdAt)}</td>
                  <td>{e.to}</td>
                  <td className="text-fg-muted">{e.template.replaceAll('_', ' ')}</td>
                  <td>
                    <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                    {e.lastError && (
                      <div
                        className="mt-1 max-w-[20rem] truncate font-mono text-xs text-fg-subtle"
                        title={e.lastError}
                      >
                        {e.lastError}
                      </div>
                    )}
                  </td>
                  <td className="tabular-nums text-fg-muted">{e.attempts}</td>
                  <td className="text-right">
                    {canWrite && (e.status === 'failed' || e.status === 'suppressed') && (
                      <Button type="button" variant="ghost" onClick={() => void retry.run(e.id)}>
                        Retry
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Suppressions />
    </div>
  );
}
