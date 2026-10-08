import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { ResetRequest, TenantUser } from '../api/types';
import { errorMessage, formatDateTime } from '../lib/format';
import { useSession } from '../session/session';
import { Alert, Badge, Button, Card, Field, Input, Spinner } from '@aerolith/ui';

/** Shown once: the admin passes this to the user, who must replace it at first sign-in. */
function OneTimePassword({
  username,
  password,
  onDone,
}: {
  username: string;
  password: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Alert tone="success">
      <p>
        One-time password for <strong>{username}</strong>. It is shown only now; they will choose
        their own at first sign-in.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code
          className="rounded bg-surface px-2 py-1 font-mono text-base"
          data-testid="one-time-password"
        >
          {password}
        </code>
        <Button
          variant="ghost"
          onClick={() => {
            void navigator.clipboard?.writeText(password);
            setCopied(true);
          }}
        >
          <Copy className="size-4" aria-hidden /> {copied ? 'Copied' : 'Copy'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </Alert>
  );
}

interface PermissionMatrix {
  roles: ('manager' | 'worker')[];
  permissions: { key: string; label: string }[];
  grants: Record<'manager' | 'worker', Record<string, boolean>>;
}

/** "What each role can do": admins always can; managers and workers as set here. The server enforces it. */
function RolePermissions({ readOnly }: { readOnly: boolean }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // Clicked values shown at once, before the server answers (a controlled checkbox would otherwise snap back).
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const matrix = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api.request<PermissionMatrix>('/api/tenant/permissions'),
  });
  const set = useMutation({
    mutationFn: (b: { role: 'manager' | 'worker'; permission: string; granted: boolean }) =>
      api.request('/api/tenant/permissions', { method: 'POST', body: b }),
    // Tick the box at once; roll back if the server refuses.
    onMutate: (b) => {
      const before = qc.getQueryData<PermissionMatrix>(['permissions']);
      if (before)
        qc.setQueryData<PermissionMatrix>(['permissions'], {
          ...before,
          grants: {
            ...before.grants,
            [b.role]: { ...before.grants[b.role], [b.permission]: b.granted },
          },
        });
      return { before };
    },
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['my-permissions'] });
    },
    onError: (err, _b, ctx) => {
      if (ctx?.before) qc.setQueryData(['permissions'], ctx.before);
      setError(errorMessage(err instanceof ApiError ? err.code : undefined));
    },
    onSettled: async (_r, _e, b) => {
      await qc.invalidateQueries({ queryKey: ['permissions'] });
      setPending(({ [`${b.role}:${b.permission}`]: _done, ...rest }) => rest);
    },
  });
  return (
    <Card title="What each role can do">
      {matrix.isPending ? (
        <Spinner />
      ) : matrix.isError ? (
        <Alert tone="danger">{errorMessage(undefined)}</Alert>
      ) : (
        <>
          <p className="mb-3 text-sm text-fg-muted">
            Everyone can view tenders and BOQs. Admins can always change everything. Changes apply
            at once for new actions.
          </p>
          <div className="-mx-5 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm [&_td]:px-5 [&_td]:py-2.5 [&_th]:px-5 [&_th]:pb-2 [&_th]:text-xs [&_th]:font-medium [&_th]:text-fg-muted">
              <thead>
                <tr>
                  <th>Permission</th>
                  <th className="text-center">Admin</th>
                  <th className="text-center">Manager</th>
                  <th className="text-center">Worker</th>
                </tr>
              </thead>
              <tbody>
                {matrix.data.permissions.map((p) => (
                  <tr key={p.key} className="border-t border-line">
                    <td>{p.label}</td>
                    <td className="text-center">
                      <input type="checkbox" checked disabled aria-label={`Admin: ${p.label}`} />
                    </td>
                    {matrix.data.roles.map((role) => (
                      <td key={role} className="text-center">
                        <input
                          type="checkbox"
                          aria-label={`${role === 'manager' ? 'Manager' : 'Worker'}: ${p.label}`}
                          checked={
                            pending[`${role}:${p.key}`] ?? matrix.data.grants[role][p.key] ?? false
                          }
                          disabled={readOnly}
                          onChange={(e) => {
                            const granted = e.target.checked;
                            setPending((m) => ({ ...m, [`${role}:${p.key}`]: granted }));
                            set.mutate({ role, permission: p.key, granted });
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && (
            <div className="mt-3">
              <Alert tone="danger">{error}</Alert>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

export function UsersScreen() {
  const session = useSession();
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.request<TenantUser[]>('/api/tenant/users'),
  });
  const [form, setForm] = useState({
    username: '',
    displayName: '',
    role: 'worker' as 'manager' | 'worker',
  });
  const [issued, setIssued] = useState<{ username: string; temporaryPassword: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const readOnly = session.licence && !session.licence.featuresUnlocked;

  const create = useMutation({
    mutationFn: () =>
      api.request<{ username: string; temporaryPassword: string }>('/api/tenant/users', {
        method: 'POST',
        body: form,
      }),
    onSuccess: (res) => {
      setIssued(res);
      setForm({ username: '', displayName: '', role: 'worker' });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => setError(errorMessage(err instanceof ApiError ? err.code : undefined)),
  });
  const action = useMutation({
    mutationFn: ({
      id,
      op,
      role,
    }: {
      id: string;
      op: 'deactivate' | 'reactivate' | 'role';
      role?: string;
    }) =>
      api.request(`/api/tenant/users/${id}/${op}`, { method: 'POST', body: role ? { role } : {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (err) => setError(errorMessage(err instanceof ApiError ? err.code : undefined)),
  });
  const seats = session.entitlement?.seats ?? 0;
  const active = users.data?.filter((u) => u.status === 'active').length ?? 0;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold">Users</h1>
        <span className="text-sm text-fg-muted">
          {active} of {seats} seats in use
        </span>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {issued && (
        <OneTimePassword
          username={issued.username}
          password={issued.temporaryPassword}
          onDone={() => setIssued(null)}
        />
      )}
      <Card title="Add a user">
        {readOnly ? (
          <Alert tone="warning">{errorMessage('licence_read_only')}</Alert>
        ) : (
          <form
            className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setError(null);
              create.mutate();
            }}
          >
            <Field label="Username">
              <Input
                name="username"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                required
                autoComplete="off"
              />
            </Field>
            <Field label="Full name">
              <Input
                name="displayName"
                value={form.displayName}
                onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                required
              />
            </Field>
            <Field label="Role">
              <select
                name="role"
                className="block w-full rounded-md border border-line bg-surface px-3 py-2 text-sm"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as 'manager' | 'worker' })}
              >
                <option value="manager">Manager</option>
                <option value="worker">Worker</option>
              </select>
            </Field>
            <Button type="submit" busy={create.isPending}>
              Add user
            </Button>
          </form>
        )}
      </Card>
      <Card>
        {users.isLoading ? (
          <Spinner />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-fg-muted">
                  <th className="py-2 pr-3 font-medium">User</th>
                  <th className="py-2 pr-3 font-medium">Role</th>
                  <th className="py-2 pr-3 font-medium">Last sign-in</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.data?.map((u) => (
                  <tr key={u.id} className={u.status === 'deactivated' ? 'opacity-60' : ''}>
                    <td className="py-2.5 pr-3">
                      <div className="font-medium">{u.displayName}</div>
                      <div className="text-xs text-fg-muted">{u.username}</div>
                    </td>
                    <td className="py-2.5 pr-3">
                      {u.role === 'admin' ? (
                        <Badge tone="accent">Admin</Badge>
                      ) : (
                        <select
                          aria-label={`Role for ${u.username}`}
                          className="rounded border border-line bg-surface px-2 py-1 text-sm"
                          value={u.role}
                          disabled={Boolean(readOnly) || u.status !== 'active'}
                          onChange={(e) =>
                            action.mutate({ id: u.id, op: 'role', role: e.target.value })
                          }
                        >
                          <option value="manager">Manager</option>
                          <option value="worker">Worker</option>
                        </select>
                      )}
                      {u.status === 'deactivated' && <Badge>Deactivated</Badge>}
                      {u.mustChangePassword && u.status === 'active' && (
                        <Badge tone="warning">Awaiting first sign-in</Badge>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 text-fg-muted">
                      {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}
                    </td>
                    <td className="py-2.5 text-right">
                      {u.role !== 'admin' &&
                        (u.status === 'active' ? (
                          <Button
                            variant="ghost"
                            onClick={() => action.mutate({ id: u.id, op: 'deactivate' })}
                          >
                            Deactivate
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            disabled={Boolean(readOnly)}
                            onClick={() => action.mutate({ id: u.id, op: 'reactivate' })}
                          >
                            Reactivate
                          </Button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <RolePermissions readOnly={Boolean(readOnly)} />
    </div>
  );
}

export function ResetRequestsScreen() {
  const qc = useQueryClient();
  const requests = useQuery({
    queryKey: ['password-resets'],
    queryFn: () => api.request<ResetRequest[]>('/api/tenant/password-resets'),
  });
  const [issued, setIssued] = useState<{ username: string; temporaryPassword: string } | null>(
    null,
  );
  const act = useMutation({
    mutationFn: ({ id, op }: { id: string; op: 'issue' | 'dismiss' }) =>
      api.request<{ username: string; temporaryPassword: string } | { status: string }>(
        `/api/tenant/password-resets/${id}/${op}`,
        { method: 'POST', body: {} },
      ),
    onSuccess: (res) => {
      if ('temporaryPassword' in res) setIssued(res);
      void qc.invalidateQueries({ queryKey: ['password-resets'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    },
  });

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <h1 className="text-xl font-semibold">Password reset requests</h1>
      {issued && (
        <OneTimePassword
          username={issued.username}
          password={issued.temporaryPassword}
          onDone={() => setIssued(null)}
        />
      )}
      <Card>
        {requests.isLoading ? (
          <Spinner />
        ) : requests.data && requests.data.length > 0 ? (
          <ul className="divide-y divide-line">
            {requests.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <div className="text-sm font-medium">
                    {r.displayName} <span className="text-fg-muted">({r.username})</span>
                  </div>
                  <div className="text-xs text-fg-subtle">
                    Requested {formatDateTime(r.requestedAt)}
                    {r.deviceLabel ? ` from ${r.deviceLabel}` : ''}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={() => act.mutate({ id: r.id, op: 'dismiss' })}>
                    Dismiss
                  </Button>
                  <Button
                    onClick={() => act.mutate({ id: r.id, op: 'issue' })}
                    busy={act.isPending}
                  >
                    Issue one-time password
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-fg-muted">
            No pending requests. Staff who forget their password can ask you from the sign-in
            screen.
          </p>
        )}
      </Card>
      <p className="text-xs text-fg-subtle">
        Check with the person before issuing a password: anyone who knows a username can send a
        request.
      </p>
    </div>
  );
}
