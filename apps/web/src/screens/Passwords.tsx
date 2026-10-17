import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { errorMessage } from '../lib/format';
import { useSession } from '../session/session';
import { Alert, AuthLayout, Button, Field, Input } from '@aerolith/ui';

function useSubmit() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : 'network_error'));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, run };
}

function NewPasswordFields({
  value,
  onChange,
  confirm,
  onConfirm,
}: {
  value: string;
  onChange: (v: string) => void;
  confirm: string;
  onConfirm: (v: string) => void;
}) {
  return (
    <>
      <Field
        label="New password"
        hint="At least 10 characters. A short phrase is easier to remember than symbols."
      >
        <Input
          name="newPassword"
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
      <Field
        label="Repeat new password"
        error={confirm && confirm !== value ? 'The passwords do not match.' : null}
      >
        <Input
          name="confirmPassword"
          type="password"
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
    </>
  );
}

/** Staff ask their admin; admins get an email link. Neither response reveals whether the account exists. */
export function ForgotScreen({ admin }: { admin: boolean }) {
  const session = useSession();
  const [value, setValue] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const { error, busy, run } = useSubmit();
  const [asAdmin, setAsAdmin] = useState(admin);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const res = asAdmin
        ? await api.request<{ message: string }>('/api/auth/admin/forgot-password', {
            method: 'POST',
            auth: false,
            body: { email: value.trim() },
          })
        : await api.request<{ message: string }>('/api/auth/password-reset-request', {
            method: 'POST',
            auth: false,
            body: {
              entitlementToken: session.entitlementToken,
              username: value.trim(),
              deviceLabel: null,
            },
          });
      setDone(res.message);
    });
  };

  return (
    <AuthLayout
      title="Forgot password"
      subtitle={
        asAdmin
          ? 'We will email you a link to set a new password.'
          : 'Your admin will be asked to give you a new password.'
      }
    >
      {done ? (
        <div className="space-y-4">
          <Alert tone="success">{done}</Alert>
          <Link to="/sign-in" className="block text-center text-sm text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label={asAdmin ? 'Admin email' : 'Username'}>
            <Input
              name="identifier"
              type={asAdmin ? 'email' : 'text'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoFocus
              required
            />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" className="w-full" busy={busy}>
            {asAdmin ? 'Email me a link' : 'Ask my admin'}
          </Button>
          <div className="flex justify-between text-sm">
            <Link to="/sign-in" className="text-fg-muted hover:underline">
              Back
            </Link>
            <button
              type="button"
              className="text-accent hover:underline"
              onClick={() => setAsAdmin(!asAdmin)}
            >
              {asAdmin ? 'I am a staff user' : 'I am the admin'}
            </button>
          </div>
        </form>
      )}
    </AuthLayout>
  );
}

/** Target of the emailed setup and reset links (/account/set-password, /account/reset-password). */
export function SetPasswordScreen({
  token,
  purpose,
}: {
  token: string;
  purpose: 'setup' | 'reset';
}) {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { error, busy, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return;
    void run(async () => {
      await api.request('/api/auth/admin/set-password', {
        method: 'POST',
        auth: false,
        body: { token, newPassword: password },
      });
      setDone(true);
    });
  };

  return (
    <AuthLayout title={purpose === 'setup' ? 'Create your admin password' : 'Set a new password'}>
      {done ? (
        <div className="space-y-4">
          <Alert tone="success">
            Password saved. Sign in with your email, this password and your authenticator app.
          </Alert>
          <Button className="w-full" onClick={() => void navigate({ to: '/sign-in' })}>
            Go to sign in
          </Button>
        </div>
      ) : !token ? (
        <Alert tone="danger">{errorMessage('link_invalid')}</Alert>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <NewPasswordFields
            value={password}
            onChange={setPassword}
            confirm={confirm}
            onConfirm={setConfirm}
          />
          {error && <Alert tone="danger">{error}</Alert>}
          <Button
            type="submit"
            className="w-full"
            busy={busy}
            disabled={!password || password !== confirm}
          >
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

/** Forced after an admin-issued one-time password; also reachable from the account menu. */
export function ChangePasswordScreen({ forced }: { forced: boolean }) {
  const session = useSession();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { error, busy, run } = useSubmit();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return;
    void run(async () => {
      const { accessToken } = await api.request<{ accessToken: string }>(
        '/api/auth/change-password',
        {
          method: 'POST',
          body: { currentPassword: current, newPassword: password },
        },
      );
      session.passwordChanged(accessToken);
      await navigate({ to: '/' });
    });
  };

  return (
    <AuthLayout
      title={forced ? 'Choose your own password' : 'Change password'}
      subtitle={
        forced ? 'You signed in with a one-time password. Set your own to continue.' : undefined
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={forced ? 'One-time password' : 'Current password'}>
          <Input
            name="currentPassword"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
            autoFocus
          />
        </Field>
        <NewPasswordFields
          value={password}
          onChange={setPassword}
          confirm={confirm}
          onConfirm={setConfirm}
        />
        {error && <Alert tone="danger">{error}</Alert>}
        <Button
          type="submit"
          className="w-full"
          busy={busy}
          disabled={!password || password !== confirm}
        >
          Save password
        </Button>
        <button
          type="button"
          className="w-full text-center text-sm text-fg-muted hover:underline"
          onClick={() => void session.signOut()}
        >
          Sign out
        </button>
      </form>
    </AuthLayout>
  );
}

/** The signed-in user's name, as shown on tenders, reminders and in activity logs. */
export function YourNameCard() {
  const session = useSession();
  const [name, setName] = useState(session.user?.displayName ?? '');
  const [saved, setSaved] = useState(false);
  const { error, busy, run } = useSubmit();
  return (
    <form
      className="mx-auto mb-6 w-full max-w-sm space-y-3 rounded-lg border border-line bg-surface p-5"
      aria-label="Your name"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        void run(async () => {
          const r = await api.request<{ displayName: string }>('/api/tenant/me/name', {
            method: 'POST',
            body: { displayName: name },
          });
          session.renamed(r.displayName);
          setSaved(true);
        });
      }}
    >
      <h2 className="font-semibold">Your name</h2>
      <Field label="Name" hint="Shown on tenders, reminders and in activity logs.">
        <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      {saved && <Alert tone="success">Saved.</Alert>}
      <Button type="submit" busy={busy} disabled={name.trim().length < 2}>
        Save name
      </Button>
    </form>
  );
}

/** The morning email digest (docs/wave8-plan.md step 8g.3): the person's address, on or off, and today's preview. */
export function DigestCard() {
  const data = useQuery({
    queryKey: ['digest'],
    queryFn: () =>
      api.request<{
        email: string | null;
        enabled: boolean;
        preview: { title: string; lines: string[]; more: number }[];
      }>('/api/tenant/me/digest'),
  });
  const qc = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);
  const { error, busy, run } = useSubmit();
  const d = data.data;
  const shownEmail = email ?? d?.email ?? '';
  const shownEnabled = enabled ?? d?.enabled ?? true;
  return (
    <form
      className="mx-auto mb-6 w-full max-w-sm space-y-3 rounded-lg border border-line bg-surface p-5"
      aria-label="Morning email"
      onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        void run(async () => {
          const r = await api.request('/api/tenant/me/digest', {
            method: 'POST',
            body: { email: shownEmail, enabled: shownEnabled },
          });
          qc.setQueryData(['digest'], r);
          setEmail(null);
          setEnabled(null);
          setSaved(true);
        });
      }}
    >
      <h2 className="font-semibold">Morning email</h2>
      <p className="text-sm text-fg-muted">
        Each morning there is something for you: what is overdue, due this week, waiting on you, and
        guarantees, insurance, permits and documents about to lapse.
      </p>
      <Field label="Email address">
        <Input type="email" value={shownEmail} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={shownEnabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Send me the morning email
      </label>
      {error && <Alert tone="danger">{error}</Alert>}
      {saved && <Alert tone="success">Saved.</Alert>}
      <Button type="submit" busy={busy}>
        Save
      </Button>
      {d && d.preview.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-fg-muted">What it would say today</summary>
          {d.preview.map((s) => (
            <div key={s.title} className="mt-2">
              <p className="font-medium">{s.title}</p>
              <ul className="list-disc pl-5">
                {s.lines.map((l) => (
                  <li key={l}>{l}</li>
                ))}
                {s.more > 0 && <li>and {s.more} more</li>}
              </ul>
            </div>
          ))}
        </details>
      )}
    </form>
  );
}
