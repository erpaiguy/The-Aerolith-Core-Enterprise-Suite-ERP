// Two-factor sign-in for staff (docs/wave8-plan.md step 8g.1): set up an authenticator app (scan the code, type one
// code back, keep the recovery codes), turn it off with a code, and, for an admin, the company's rule that admins and
// those who post to the books must use it. When the rule applies to someone who has not set it up, this is the only
// screen they see.
import { Alert, Badge, Button, Card, Field, Input, PageHeader, Spinner, Table } from '@aerolith/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useState } from 'react';
import { api } from '../api/client';
import { describeError } from '../lib/format';
import { useSession } from '../session/session';

interface Status {
  enabled: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
  requiredNow: boolean;
  requireMfa: boolean;
}

export function TwoFactorScreen({ forced = false }: { forced?: boolean }) {
  const session = useSession();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['mfa-status'],
    queryFn: () => api.request<Status>('/api/auth/two-factor'),
  });
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = session.user?.role === 'admin';
  const users = useQuery({
    queryKey: ['mfa-users'],
    queryFn: () =>
      api.request<
        { id: string; username: string; displayName: string; role: string; enabled: boolean }[]
      >('/api/auth/two-factor/users'),
    enabled: isAdmin && !forced,
  });
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
      void qc.invalidateQueries({ queryKey: ['mfa-status'] });
      void qc.invalidateQueries({ queryKey: ['mfa-users'] });
    } catch (err) {
      setError(describeError(err));
    }
  };
  const s = status.data;
  return (
    <div className={forced ? 'mx-auto max-w-xl space-y-5 p-6' : 'space-y-5'}>
      <PageHeader
        title="Two-factor sign-in"
        subtitle={
          forced
            ? 'Your company asks you to use an authenticator app when you sign in. Set it up to continue.'
            : 'A code from an authenticator app on your phone, as well as your password.'
        }
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {status.isPending ? (
        <Spinner />
      ) : recovery ? (
        <Card title="Your recovery codes">
          <p className="mb-2 text-sm">
            Keep these somewhere safe. Each one signs you in once if you lose your phone. They are
            not shown again.
          </p>
          <ul className="grid grid-cols-2 gap-1 font-mono text-sm" aria-label="Recovery codes">
            {recovery.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button
            className="mt-3"
            onClick={() => {
              setRecovery(null);
              if (forced) void session.mfaSetUp();
            }}
          >
            {forced ? 'I have kept them: continue' : 'Done'}
          </Button>
        </Card>
      ) : s?.enabled ? (
        <Card title="Set up">
          <p className="text-sm">
            <Badge tone="success">On</Badge> since {s.enabledAt?.slice(0, 10)};{' '}
            {s.recoveryCodesLeft} recovery codes left.
          </p>
          <form
            aria-label="Turn off two-factor sign-in"
            className="mt-3 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.request('/api/auth/two-factor/disable', {
                  method: 'POST',
                  body: { code },
                });
                setCode('');
              });
            }}
          >
            <Field label="A code from the app">
              <Input
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
              />
            </Field>
            <Button type="submit" variant="ghost">
              Turn it off
            </Button>
          </form>
        </Card>
      ) : setup ? (
        <Card title="Scan this with your authenticator app">
          <img src={setup.qr} alt="Authenticator set-up code" className="mb-2 h-48 w-48" />
          <p className="mb-3 text-sm">
            Or type this key into the app: <span className="font-mono">{setup.secret}</span>
          </p>
          <form
            aria-label="Confirm two-factor sign-in"
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const r = await api.request<{ recoveryCodes: string[] }>(
                  '/api/auth/two-factor/confirm',
                  {
                    method: 'POST',
                    body: { code: code.trim() },
                  },
                );
                setCode('');
                setSetup(null);
                setRecovery(r.recoveryCodes);
              });
            }}
          >
            <Field label="The six-digit code it shows">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                pattern="\d{6}"
              />
            </Field>
            <Button type="submit">Turn it on</Button>
          </form>
        </Card>
      ) : (
        <Card>
          <Button
            onClick={() =>
              void run(async () => {
                const r = await api.request<{ secret: string; otpauthUri: string }>(
                  '/api/auth/two-factor/start',
                  {
                    method: 'POST',
                    body: {},
                  },
                );
                setSetup({
                  secret: r.secret,
                  qr: await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 200 }),
                });
              })
            }
          >
            Set up an authenticator app
          </Button>
        </Card>
      )}
      {forced && (
        <Button variant="ghost" onClick={() => void session.signOut()}>
          Sign out
        </Button>
      )}
      {isAdmin && !forced && s && (
        <Card title="For the company">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.requireMfa}
              onChange={(e) =>
                void run(async () => {
                  await api.request('/api/auth/two-factor/policy', {
                    method: 'POST',
                    body: { requireMfa: e.target.checked },
                  });
                })
              }
            />
            Require it of admins and of everyone who posts to the books (from their next sign-in)
          </label>
          {(users.data ?? []).length > 0 && (
            <Table minWidth="28rem">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Role</th>
                  <th>Two-factor</th>
                </tr>
              </thead>
              <tbody aria-label="Two-factor by user">
                {users.data!.map((u) => (
                  <tr key={u.id}>
                    <td>
                      {u.displayName} <span className="text-fg-muted">{u.username}</span>
                    </td>
                    <td>{u.role}</td>
                    <td>
                      {u.enabled ? (
                        <Badge tone="success">on</Badge>
                      ) : (
                        <Badge tone="neutral">off</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
