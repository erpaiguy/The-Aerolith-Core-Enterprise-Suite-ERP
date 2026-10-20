import { Link } from '@tanstack/react-router';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { LoginResult } from '../api/types';
import { errorMessage } from '../lib/format';
import { load, save } from '../lib/storage';
import { clientKind } from '../platform';
import { useSession } from '../session/session';
import { LEGAL_DOCUMENTS } from '@aerolith/shared';
import { ReleaseNotice } from '../updates/Updates';
import { Alert, AuthLayout, Button, Field, Input } from '@aerolith/ui';

type Step =
  | { kind: 'credentials' }
  | { kind: 'code' }
  | { kind: 'enrol'; enrollmentToken: string; secret: string; qr: string }
  | { kind: 'recovery-codes'; codes: string[] };

const LAST_ID = 'aerolith.lastIdentifier';

/**
 * Admins sign in with their email (password + authenticator code); staff with their username (password only).
 * An admin without an authenticator is taken through enrolment first.
 */
export function SignInScreen() {
  const session = useSession();
  const [identifier, setIdentifier] = useState(load(LAST_ID) ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = identifier.includes('@');

  async function attempt(withCode?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.request<LoginResult>('/api/auth/login', {
        method: 'POST',
        auth: false,
        body: {
          entitlementToken: session.entitlementToken,
          identifier: identifier.trim(),
          password,
          client: clientKind(),
          ...(withCode ? { code: withCode } : {}),
        },
      });
      save(LAST_ID, identifier.trim());
      if (result.status === 'ok') return session.signedIn(result);
      if (result.status === 'mfa_required') return setStep({ kind: 'code' });
      const enrol = await api.request<{ secret: string; otpauthUri: string }>(
        '/api/auth/mfa/enroll',
        {
          method: 'POST',
          auth: false,
          body: { enrollmentToken: result.enrollmentToken },
        },
      );
      const qr = await QRCode.toDataURL(enrol.otpauthUri, { margin: 1, width: 200 });
      setStep({ kind: 'enrol', enrollmentToken: result.enrollmentToken, secret: enrol.secret, qr });
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : 'network_error'));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnrolment(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== 'enrol') return;
    setBusy(true);
    setError(null);
    try {
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
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : undefined));
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === 'enrol') {
    return (
      <AuthLayout
        title="Set up your authenticator"
        subtitle="Admin accounts need a code from an authenticator app at every sign-in."
      >
        <form onSubmit={confirmEnrolment} className="space-y-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-fg-muted">
            <li>Open Google Authenticator, Microsoft Authenticator or similar.</li>
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
        subtitle="Each code works once if you lose your phone. This is the only time they are shown."
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
            Print them or store them in a password manager. Do not keep them on the same phone.
          </Alert>
          <Button className="w-full" onClick={() => setStep({ kind: 'code' })}>
            I have saved them, continue to sign in
          </Button>
        </div>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Sign in"
      footer={<SignInFooter />}
      subtitle={
        session.entitlement
          ? `Licence ${session.entitlement.tier} · ${session.entitlement.seats} seats`
          : undefined
      }
    >
      {session.licenceProblem && (
        <div className="mb-4">
          <Alert tone="danger">{errorMessage(session.licenceProblem)}</Alert>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void attempt(step.kind === 'code' ? code.trim() : undefined);
        }}
        className="space-y-4"
      >
        {step.kind === 'credentials' ? (
          <>
            <Field label="Username or admin email">
              <Input
                name="identifier"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoComplete="username"
                autoFocus={!identifier}
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
                autoFocus={Boolean(identifier)}
                required
              />
            </Field>
          </>
        ) : (
          <Field label="Authenticator code" hint="Or one of your recovery codes, like 7K3M-Q9TX.">
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
        <div className="flex justify-between text-sm">
          <Link to="/forgot" search={{ admin: isAdmin }} className="text-accent hover:underline">
            Forgot password?
          </Link>
          {step.kind === 'code' && (
            <button
              type="button"
              className="text-fg-muted hover:underline"
              onClick={() => setStep({ kind: 'credentials' })}
            >
              Back
            </button>
          )}
        </div>
      </form>
      <DeviceFooter />
    </AuthLayout>
  );
}

function DeviceFooter() {
  const session = useSession();
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);
  return (
    <p className="mt-5 border-t border-line pt-4 text-center text-xs text-fg-subtle">
      Wrong company?{' '}
      <button
        type="button"
        className="text-fg-muted underline"
        onClick={() => (confirming ? session.forgetDevice() : setConfirming(true))}
      >
        {confirming
          ? 'Click again to remove the licence from this device'
          : 'Use a different licence key'}
      </button>
    </p>
  );
}

/** Under the sign-in form: the product, and its legal documents for anyone to read before signing in (step 9b.3). */
function SignInFooter() {
  return (
    <>
      <p>Aerolith Core · Construction ERP</p>
      <ReleaseNotice place="sign-in" />
      <nav aria-label="Legal" className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-1">
        {LEGAL_DOCUMENTS.map((d) => (
          <Link
            key={d.key}
            to="/legal/$key"
            params={{ key: d.key }}
            className="underline hover:text-fg"
          >
            {d.title}
          </Link>
        ))}
        <Link to="/licences" className="underline hover:text-fg">
          Third-party licences
        </Link>
      </nav>
    </>
  );
}
