import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { ResetRequest, TenantUser } from '../api/types';
import { describeError, errorMessage, formatDateTime } from '../lib/format';
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
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const rename = useMutation({
    mutationFn: (r: { id: string; name: string }) =>
      api.request(`/api/tenant/users/${r.id}/name`, {
        method: 'POST',
        body: { displayName: r.name },
      }),
    onSuccess: (_d, r) => {
      if (r.id === session.user?.id) session.renamed(r.name.trim());
      setRenaming(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
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
                      {renaming?.id === u.id ? (
                        <form
                          className="flex items-center gap-1"
                          onSubmit={(e) => {
                            e.preventDefault();
                            rename.mutate(renaming);
                          }}
                        >
                          <Input
                            aria-label={`New name for ${u.username}`}
                            value={renaming.name}
                            onChange={(e) => setRenaming({ id: u.id, name: e.target.value })}
                            autoFocus
                          />
                          <Button type="submit" variant="secondary" busy={rename.isPending}>
                            Save
                          </Button>
                          <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                            Cancel
                          </Button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          className="text-left font-medium hover:underline"
                          title="Rename"
                          onClick={() => setRenaming({ id: u.id, name: u.displayName })}
                        >
                          {u.displayName}
                        </button>
                      )}
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
      <AccessProfiles users={users.data ?? []} readOnly={Boolean(readOnly)} />
    </div>
  );
}

interface Profile {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  rowVersion: number;
  users: { id: string; name: string; role: string }[];
}

/**
 * Access profiles: custom roles (docs/wave8-plan.md step 8g.4). A named set of permissions given to managers or
 * workers in place of their role's; admins can always do everything.
 */
function AccessProfiles({ users, readOnly }: { users: TenantUser[]; readOnly: boolean }) {
  const qc = useQueryClient();
  const profiles = useQuery({
    queryKey: ['access-profiles'],
    queryFn: () => api.request<Profile[]>('/api/tenant/permissions/profiles'),
  });
  const matrix = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api.request<PermissionMatrix>('/api/tenant/permissions'),
  });
  const [editing, setEditing] = useState<Profile | null>(null);
  const [form, setForm] = useState({ name: '', description: '', permissions: [] as string[] });
  const [assign, setAssign] = useState({ userId: '', profileId: '' });
  const [error, setError] = useState<string | null>(null);
  const done = (r: unknown) => {
    qc.setQueryData(['access-profiles'], r);
    void qc.invalidateQueries({ queryKey: ['my-permissions'] });
  };
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      done(await fn());
      return true;
    } catch (err) {
      setError(describeError(err));
      return false;
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() =>
      editing
        ? api.request(`/api/tenant/permissions/profiles/${editing.id}`, {
            method: 'POST',
            body: { ...form, rowVersion: editing.rowVersion },
          })
        : api.request('/api/tenant/permissions/profiles', { method: 'POST', body: form }),
    );
    if (ok) {
      setEditing(null);
      setForm({ name: '', description: '', permissions: [] });
    }
  };
  const all = matrix.data?.permissions ?? [];
  const staff = users.filter((u) => u.role !== 'admin' && u.status === 'active');
  return (
    <Card title="Access profiles (custom roles)">
      <p className="mb-3 text-sm text-fg-muted">
        A profile replaces a manager's or worker's role permissions with exactly the ones ticked
        here (a designation can still add to them). Admins are never limited.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {profiles.isPending ? (
        <Spinner />
      ) : (
        <ul className="mb-4 space-y-2" aria-label="Access profiles">
          {(profiles.data ?? []).map((p) => (
            <li key={p.id} className="rounded-md border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{p.name}</span>{' '}
                  <Badge>{p.permissions.length} permissions</Badge>
                  {p.description && <p className="text-fg-muted">{p.description}</p>}
                  <p className="text-fg-muted">
                    {p.users.length ? p.users.map((u) => u.name).join(', ') : 'Nobody has it yet.'}
                  </p>
                </div>
                {!readOnly && (
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setEditing(p);
                        setForm({
                          name: p.name,
                          description: p.description,
                          permissions: p.permissions,
                        });
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void run(() =>
                          api.request(`/api/tenant/permissions/profiles/${p.id}/delete`, {
                            method: 'POST',
                          }),
                        )
                      }
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <>
          <form onSubmit={(e) => void save(e)} className="space-y-3" aria-label="Access profile">
            <h3 className="font-medium">{editing ? `Edit ${editing.name}` : 'New profile'}</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  required
                  minLength={2}
                />
              </Field>
              <Field label="What it is for">
                <Input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </Field>
            </div>
            <fieldset className="grid gap-1 text-sm sm:grid-cols-2">
              <legend className="mb-1 font-medium">Permissions</legend>
              {all.map((p) => (
                <label key={p.key} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={form.permissions.includes(p.key)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        permissions: e.target.checked
                          ? [...form.permissions, p.key]
                          : form.permissions.filter((x) => x !== p.key),
                      })
                    }
                  />
                  <span>{p.label}</span>
                </label>
              ))}
            </fieldset>
            <div className="flex gap-2">
              <Button type="submit">{editing ? 'Save the profile' : 'Add the profile'}</Button>
              {editing && (
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setForm({ name: '', description: '', permissions: [] });
                  }}
                >
                  Cancel
                </Button>
              )}
            </div>
          </form>
          <form
            className="mt-5 flex flex-wrap items-end gap-3"
            aria-label="Give a profile"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() =>
                api.request('/api/tenant/permissions/profiles/assign', {
                  method: 'POST',
                  body: { userId: assign.userId, profileId: assign.profileId || null },
                }),
              );
            }}
          >
            <Field label="Person">
              <select
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
                value={assign.userId}
                onChange={(e) => setAssign({ ...assign, userId: e.target.value })}
                required
              >
                <option value="">Choose…</option>
                {staff.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName} ({u.role})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Profile">
              <select
                className="rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
                value={assign.profileId}
                onChange={(e) => setAssign({ ...assign, profileId: e.target.value })}
              >
                <option value="">Their role's permissions</option>
                {(profiles.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Button type="submit" variant="secondary" disabled={!assign.userId}>
              Give
            </Button>
          </form>
        </>
      )}
    </Card>
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
