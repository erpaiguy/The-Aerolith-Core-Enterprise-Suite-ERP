import { parseLicenceKey } from '@aerolith/shared';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import { errorMessage } from '../lib/format';
import { useSession } from '../session/session';
import { Alert, AuthLayout, Button, Field, Input, toast } from '@aerolith/ui';

/** First run on a device: the licence key unlocks features (docs/03-architecture.md §6). */
export function ActivateScreen() {
  const session = useSession();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = key.trim() ? parseLicenceKey(key) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!parsed?.ok) {
      setError(
        parsed?.reason === 'checksum'
          ? errorMessage('invalid_key_format')
          : 'Enter the licence key from your email.',
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await session.activate(parsed.formatted);
      toast.success('Device activated');
    } catch (err) {
      setError(errorMessage(err instanceof ApiError ? err.code : undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title="Activate this device"
      subtitle="Enter the licence key we emailed when you downloaded the app."
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <Field
          label="Licence key"
          hint="Looks like AERO-XXXXX-XXXXX-XXXXX-XXXXX. Spaces, dashes and lowercase are fine."
          error={
            error ??
            (parsed &&
            !parsed.ok &&
            parsed.reason === 'checksum' &&
            key.replace(/[\s-]/g, '').length >= 20
              ? errorMessage('invalid_key_format')
              : null)
          }
        >
          <Input
            name="licenceKey"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder="AERO-"
            className="font-mono uppercase tracking-wide"
          />
        </Field>
        <Button type="submit" className="w-full" busy={busy}>
          Activate
        </Button>
        {parsed?.ok && <Alert tone="success">Key format looks right.</Alert>}
      </form>
    </AuthLayout>
  );
}
