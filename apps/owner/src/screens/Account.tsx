import { Alert, AuthLayout, Badge, Button, Card, Field, Input } from '@aerolith/ui';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorMessage } from '../format';
import { useSession } from '../session';

function PasswordForm({ forced, onDone }: { forced: boolean; onDone?: () => void }) {
  const session = useSession();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && password !== confirm;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      const { accessToken } = await api.post<{ accessToken: string }>(
        '/api/owner/auth/change-password',
        { currentPassword: current, newPassword: password },
      );
      session.passwordChanged(accessToken);
      setCurrent('');
      setPassword('');
      setConfirm('');
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4">
      <Field label={forced ? 'One-time password' : 'Current password'}>
        <Input
          name="currentPassword"
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
          autoFocus={forced}
        />
      </Field>
      <Field
        label="New password"
        hint="At least 10 characters. A passphrase of 3-4 words is ideal."
      >
        <Input
          name="newPassword"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={10}
          required
        />
      </Field>
      <Field label="Repeat new password" error={mismatch ? 'The passwords do not match.' : null}>
        <Input
          name="confirmPassword"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
      </Field>
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" busy={busy} disabled={!password || password !== confirm}>
        Save password
      </Button>
    </form>
  );
}

/** Shown after the first sign-in with the one-time password from the CLI. */
export function ForcedPasswordScreen() {
  const session = useSession();
  return (
    <AuthLayout
      title="Choose your own password"
      subtitle="You signed in with the one-time password from the command line. Set your own to continue."
      footer="Aerolith Core · Owner console"
    >
      <PasswordForm forced />
      <button
        type="button"
        className="mt-4 w-full text-center text-sm text-fg-muted hover:underline"
        onClick={() => void session.signOut()}
      >
        Sign out
      </button>
    </AuthLayout>
  );
}

export function AccountScreen() {
  const { operator } = useSession();
  const [saved, setSaved] = useState(false);
  if (!operator) return null;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-xl font-semibold">Account</h1>
      <Card title="You">
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-fg-muted">Name</dt>
          <dd>{operator.displayName}</dd>
          <dt className="text-fg-muted">Email</dt>
          <dd>{operator.email}</dd>
          <dt className="text-fg-muted">Role</dt>
          <dd>
            <Badge>{operator.role}</Badge>
          </dd>
          <dt className="text-fg-muted">Recovery codes</dt>
          <dd>
            {operator.recoveryCodesLeft} left
            {operator.recoveryCodesLeft <= 3 && (
              <span className="ml-2">
                <Badge tone="warning">running low</Badge>
              </span>
            )}
          </dd>
        </dl>
      </Card>
      <Card title="Change password">
        {saved && (
          <div className="mb-4">
            <Alert tone="success">Password changed. Other sessions were signed out.</Alert>
          </div>
        )}
        <PasswordForm forced={false} onDone={() => setSaved(true)} />
      </Card>
    </div>
  );
}
