import { Alert, AuthLayout, Button, Field, Input } from '@aerolith/ui';
import QRCode from 'qrcode';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorMessage } from '../format';
import { useSession } from '../session';

type LoginResult =
  | { status: 'ok'; accessToken: string; mustChangePassword: boolean }
  | { status: 'mfa_required' }
  | { status: 'mfa_enrollment_required'; enrollmentToken: string };

type Step =
  | { kind: 'credentials' }
  | { kind: 'code' }
  | { kind: 'enrol'; enrollmentToken: string; secret: string; qr: string }
  | { kind: 'recovery-codes'; codes: string[] };

const FOOTER = 'Aerolith Core · Owner console';

/** Email + password + authenticator code. A new operator sets up the authenticator first (MFA is mandatory). */
export function SignInScreen() {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const signIn = (withCode?: string) =>
    run(async () => {
      const result = await api.request<LoginResult>('/api/owner/auth/login', {
        method: 'POST',
        auth: false,
        body: {
          email: email.trim(),
          password,
          client: 'browser',
          ...(withCode ? { code: withCode } : {}),
        },
      });
      if (result.status === 'ok') return session.signedIn(result);
      if (result.status === 'mfa_required') return setStep({ kind: 'code' });
      const enrol = await api.request<{ secret: string; otpauthUri: string }>(
        '/api/auth/mfa/enroll',
        { method: 'POST', auth: false, body: { enrollmentToken: result.enrollmentToken } },
      );
      const qr = await QRCode.toDataURL(enrol.otpauthUri, { margin: 1, width: 200 });
      setStep({ kind: 'enrol', enrollmentToken: result.enrollmentToken, secret: enrol.secret, qr });
    });

  const confirmEnrolment = (e: FormEvent) => {
    e.preventDefault();
    if (step.kind !== 'enrol') return;
    void run(async () => {
      const { recoveryCodes } = await api.request<{ recoveryCodes: string[] }>(
        '/api/auth/mfa/confirm',
        {
          method: 'POST',
          auth: false,
          body: { enrollmentToken: step.enrollmentToken, code: code.trim() },
        },
      );
      setCode('');
      setStep({ kind: 'recovery-codes', codes: recoveryCodes });
    });
  };

  if (step.kind === 'enrol') {
    return (
      <AuthLayout
        title="Set up your authenticator"
        subtitle="The owner console always needs a code from an authenticator app."
        footer={FOOTER}
      >
        <form onSubmit={confirmEnrolment} className="space-y-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted">
            <li>Open your authenticator app.</li>
            <li>Scan this code, or type the key below.</li>
            <li>Enter the 6-digit code it shows.</li>
          </ol>
          <img
            src={step.qr}
            alt="Authenticator QR code"
            className="mx-auto size-[200px] rounded bg-white p-1"
          />
          <p
            className="break-all rounded bg-surface-2 px-2 py-1.5 text-center font-mono text-xs"
            data-testid="totp-secret"
          >
            {step.secret}
          </p>
          <Field label="6-digit code" error={error}>
            <Input
              name="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
            />
          </Field>
          <Button type="submit" className="w-full" busy={busy}>
            Confirm
          </Button>
        </form>
      </AuthLayout>
    );
  }

  if (step.kind === 'recovery-codes') {
    return (
      <AuthLayout
        title="Save your recovery codes"
        subtitle="These are your break-glass codes. Each works once. This is the only time they are shown."
        footer={FOOTER}
      >
        <div className="space-y-4">
          <ul
            className="grid grid-cols-2 gap-2 rounded bg-surface-2 p-3 font-mono text-sm"
            data-testid="recovery-codes"
          >
            {step.codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Alert tone="warning">
            You are the only owner. If you lose both your phone and these codes, the only way back
            in is the reset command on the server (docs/owner-console.md). Store them offline, away
            from your phone.
          </Alert>
          <Button className="w-full" onClick={() => setStep({ kind: 'code' })}>
            I have saved them, continue
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Owner console"
      subtitle="Sign in to manage tenants and licences."
      footer={FOOTER}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void signIn(step.kind === 'code' ? code.trim() : undefined);
        }}
        className="space-y-4"
      >
        {step.kind === 'credentials' ? (
          <>
            <Field label="Email">
              <Input
                name="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </Field>
            <Field label="Password">
              <Input
                name="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </Field>
          </>
        ) : (
          <Field label="Authenticator code" hint="Or one of your recovery codes.">
            <Input
              name="code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="one-time-code"
              autoFocus
            />
          </Field>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" className="w-full" busy={busy}>
          {step.kind === 'code' ? 'Verify' : 'Sign in'}
        </Button>
        {step.kind === 'code' && (
          <button
            type="button"
            className="w-full text-center text-sm text-fg-muted hover:underline"
            onClick={() => {
              setCode('');
              setStep({ kind: 'credentials' });
            }}
          >
            Back
          </button>
        )}
      </form>
    </AuthLayout>
  );
}
