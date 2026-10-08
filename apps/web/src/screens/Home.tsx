import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { Inbox, InboxItem, OwnerNotice } from '../api/types';
import { daysUntil, errorMessage, formatDate, formatDateTime } from '../lib/format';
import { apiBase } from '../platform';
import { useSession } from '../session/session';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '@aerolith/ui';

function ItemRow({ item, onRead }: { item: InboxItem; onRead?: (id: string) => void }) {
  const router = useRouter();
  const unread = !item.readAt;
  return (
    <li className="flex items-start gap-3 py-3">
      <span
        className={`mt-1.5 size-2 shrink-0 rounded-full ${unread ? 'bg-accent' : 'bg-transparent'}`}
        aria-label={unread ? 'Unread' : undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-sm ${unread ? 'font-semibold' : ''}`}>{item.title}</span>
          {item.kind === 'reminder' && <Badge tone="warning">Reminder</Badge>}
          {item.kind === 'tender_deadline' && <Badge tone="warning">Tender deadline</Badge>}
        </div>
        {item.body && <p className="mt-0.5 text-sm text-fg-muted">{item.body}</p>}
        <p className="mt-0.5 text-xs text-fg-subtle">
          {formatDateTime(item.dueAt ?? item.createdAt)}
        </p>
      </div>
      {item.link && item.link.startsWith('/') && (
        // In-app navigation: a full page load would restart the app (and the desktop shell).
        <button
          type="button"
          className="text-sm text-accent hover:underline"
          onClick={() => router.history.push(item.link!)}
        >
          Open
        </button>
      )}
      {unread && onRead && (
        <button
          type="button"
          className="text-xs text-fg-muted hover:underline"
          onClick={() => onRead(item.id)}
        >
          Mark read
        </button>
      )}
    </li>
  );
}

function ReminderForm() {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.request('/api/tenant/reminders', {
        method: 'POST',
        body: { title, dueAt: new Date(dueAt).toISOString() },
      }),
    onSuccess: () => {
      setTitle('');
      setDueAt('');
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (err) => setError(errorMessage(err instanceof ApiError ? err.code : undefined)),
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        setError(null);
        add.mutate();
      }}
    >
      <Field label="Remind me to">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Follow up on EMD return"
          required
        />
      </Field>
      <Field label="When">
        <Input
          type="datetime-local"
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          required
        />
      </Field>
      <Button type="submit" variant="secondary" busy={add.isPending}>
        Add reminder
      </Button>
      {error && (
        <div className="sm:col-span-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </form>
  );
}

/** "Suresh Patil" → "Suresh"; an admin whose name is still their email → the part before the @. */
const firstName = (name: string): string =>
  name.includes('@') ? name.split('@')[0]! : name.split(' ')[0]!;

export function HomeScreen() {
  const session = useSession();
  const qc = useQueryClient();
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api.request<Inbox>('/api/tenant/inbox'),
  });
  const notices = useQuery({
    queryKey: ['owner-notices'],
    queryFn: () =>
      fetch(`${apiBase()}/api/licences/notices`, {
        headers: { authorization: `Bearer ${session.entitlementToken}` },
      }).then((r) => (r.ok ? (r.json() as Promise<OwnerNotice[]>) : [])),
    enabled: Boolean(session.entitlementToken),
  });
  const markRead = useMutation({
    mutationFn: (id: string) =>
      api.request(`/api/tenant/notifications/${id}/read`, { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['inbox'] }),
  });
  const readAll = useMutation({
    mutationFn: () =>
      api.request('/api/tenant/notifications/read-all', { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['inbox'] }),
  });
  const ent = session.entitlement;

  return (
    <div className="mx-auto grid max-w-5xl gap-5 lg:grid-cols-[1fr_300px]">
      <div className="space-y-5">
        <h1 className="text-xl font-semibold">
          Good {new Date().getHours() < 12 ? 'morning' : 'day'},{' '}
          {firstName(session.user?.displayName ?? '')}
        </h1>
        {session.user?.role === 'admin' && (inbox.data?.pending.passwordResets ?? 0) > 0 && (
          <Alert tone="warning">
            {inbox.data!.pending.passwordResets} staff password reset request
            {inbox.data!.pending.passwordResets === 1 ? '' : 's'} waiting.{' '}
            <Link to="/password-resets" className="font-medium text-accent underline">
              Review
            </Link>
          </Alert>
        )}
        <Card
          title={
            <>
              Inbox{' '}
              {inbox.data?.unread ? <Badge tone="accent">{inbox.data.unread} new</Badge> : null}
            </>
          }
          actions={
            inbox.data?.unread ? (
              <Button variant="ghost" onClick={() => readAll.mutate()} busy={readAll.isPending}>
                Mark all read
              </Button>
            ) : null
          }
        >
          {inbox.isLoading ? (
            <Spinner />
          ) : inbox.data && inbox.data.items.length > 0 ? (
            <ul className="divide-y divide-line">
              {inbox.data.items.map((item) => (
                <ItemRow key={item.id} item={item} onRead={(id) => markRead.mutate(id)} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">
              Nothing needs your attention. Tender deadlines, approvals and reminders will appear
              here.
            </p>
          )}
        </Card>
        <Card title="Reminders">
          <ReminderForm />
          {inbox.data && inbox.data.upcoming.length > 0 && (
            <ul className="mt-4 divide-y divide-line border-t border-line">
              {inbox.data.upcoming.map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="space-y-5">
        {ent && (
          <Card title="Licence">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-fg-muted">Plan</dt>
                <dd className="capitalize">{ent.tier}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Seats</dt>
                <dd>{ent.seats}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">{ent.tier === 'trial' ? 'Trial ends' : 'Renews'}</dt>
                <dd>{formatDate(ent.ends)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-fg-muted">Days left</dt>
                <dd>{Math.max(0, daysUntil(ent.ends))}</dd>
              </div>
            </dl>
          </Card>
        )}
        {notices.data && notices.data.length > 0 && (
          <Card title="From Aerolith">
            <ul className="space-y-3">
              {notices.data.slice(0, 5).map((n) => (
                <li key={n.id} className="text-sm">
                  <div className="font-medium">{n.title}</div>
                  <div className="text-fg-muted">{n.body}</div>
                  <div className="text-xs text-fg-subtle">{formatDate(n.created_at)}</div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
