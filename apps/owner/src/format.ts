import { ApiError, type LicenceState } from './api';

export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export const daysUntil = (iso: string, now = new Date()): number =>
  Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);

/** `yyyy-mm-dd` for <input type="date">, in local time. */
export const dateInputValue = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const licenceTone = (
  state: LicenceState | (string & {}) | undefined,
): 'success' | 'warning' | 'danger' | 'neutral' =>
  state === 'active'
    ? 'success'
    : state === 'grace'
      ? 'warning'
      : state === 'read_only' || state === 'revoked' || state === 'suspended'
        ? 'danger'
        : 'neutral';

export const dbTone = (status: string | undefined): 'success' | 'warning' | 'danger' | 'neutral' =>
  status === 'ready'
    ? 'success'
    : status === 'failed' || status === 'unreachable' || status === 'full'
      ? 'danger'
      : status
        ? 'warning'
        : 'neutral';

/** Turns API error codes into sentences the owner can act on. */
export function errorMessage(err: unknown, fallback = 'Something went wrong. Try again.'): string {
  const code = err instanceof ApiError ? err.code : typeof err === 'string' ? err : undefined;
  const messages: Record<string, string> = {
    invalid_credentials: 'Incorrect email, password or code.',
    rate_limited: 'Too many attempts. Wait a minute and try again.',
    invalid_code: 'That code is not correct. Check the time on your phone and try again.',
    password_too_short: 'Use at least 10 characters.',
    password_too_common: 'That password is too common. Choose something less predictable.',
    password_contains_username: 'Your password must not contain your email name.',
    password_unchanged: 'Choose a password different from the current one.',
    forbidden: 'Your role can view this console but not change anything.',
    trial_already_used: 'This email already has a trial.',
    not_a_trial: 'Only trial licences have an adjustable end date.',
    notice_too_short: 'Shortening a trial needs at least 14 days’ notice.',
    before_start: 'The end date must be after the trial started.',
    unchanged: 'That is already the end date.',
    email_not_retryable: 'Only failed or suppressed emails can be retried.',
    device_not_found: 'That device was already removed.',
    tenant_not_found: 'Tenant not found.',
    owner_auth_required: 'Your session ended. Sign in again.',
    enrollment_token_invalid: 'Authenticator setup timed out. Sign in again.',
    network_error: 'Cannot reach the server. Is the stack running?',
  };
  if (code && messages[code]) return messages[code];
  if (err instanceof ApiError && typeof err.body.message === 'string' && err.status < 500)
    return err.body.message;
  return fallback;
}
