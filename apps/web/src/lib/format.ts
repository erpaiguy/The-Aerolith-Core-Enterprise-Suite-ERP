import { ApiError } from '../api/client';

/**
 * Calendar days from today to the date, in the user's time zone: something due on the 19th, seen on the 9th, is
 * "in 10 d" whatever the hour (counting 24-hour periods made it 11 before mid-afternoon). 0 = today, negative = past.
 */
export function daysUntil(iso: string, now = new Date()): number {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((day(new Date(iso)) - day(now)) / 86_400_000);
}

export const formatDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

export const formatDateTime = (iso: string): string =>
  new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Turns API error codes into sentences people can act on. */
export function errorMessage(
  code: string | undefined,
  fallback = 'Something went wrong. Please try again.',
): string {
  const messages: Record<string, string> = {
    invalid_credentials: 'Incorrect sign-in details.',
    rate_limited: 'Too many attempts. Wait a minute and try again.',
    invalid_key_format: 'This licence key has a typo. Check it and try again.',
    unknown_key: 'Licence key not recognised.',
    device_limit: 'This licence is already active on the maximum number of devices.',
    device_revoked: 'This device was removed from the licence by its owner.',
    licence_revoked: 'This licence has been revoked. Contact support.',
    licence_suspended: 'This licence is suspended. Contact support.',
    licence_read_only: 'Your licence has ended. You can view and export data only.',
    password_too_short: 'Use at least 10 characters.',
    password_too_common: 'That password is too common. Choose something less predictable.',
    password_contains_username: 'Your password must not contain your username.',
    password_unchanged: 'Choose a password different from the current one.',
    link_invalid: 'This link is invalid or has expired. Ask for a new one.',
    invalid_code: 'That code is not correct. Check the time on your phone and try again.',
    seat_cap_reached: 'All seats are in use. Deactivate a user or upgrade your plan.',
    role_cap_reached: 'Your plan does not allow another user with this role.',
    username_taken: 'That username is already taken.',
    invalid_username: 'Use 3-40 letters, digits, dots, dashes or underscores.',
    tenant_db_not_ready: 'Your company database is still being set up. Try again in a few minutes.',
    password_change_required: 'Set a new password to continue.',
    party_name_taken: 'A party with this name already exists.',
    stale_row: 'Someone else changed this record. Reload to see their changes, then edit again.',
    invalid_status_change: 'That status change is not allowed from the current status.',
    reason_required: 'Give a short reason.',
    decision_not_allowed: 'A bid/no-bid decision cannot be recorded at this stage.',
    client_not_found: 'Choose a client from the list.',
    tender_not_found: 'Tender not found.',
    rfq_not_found: 'RFQ not found.',
    boq_not_on_tender: 'Choose a BOQ of this tender.',
    vendor_not_on_rfq: 'That vendor is not on this RFQ.',
    party_not_found: 'Choose a vendor from the list.',
    name_required: "Give the vendor's name.",
    forbidden: 'Your role cannot do this.',
    network_error: 'Cannot reach the server. Check your internet connection.',
  };
  return (code && messages[code]) || fallback;
}

/** Like errorMessage, but also explains form validation errors from the API ("Field: problem"). */
export function describeError(err: unknown): string {
  if (err instanceof ApiError && err.code === 'invalid_request' && Array.isArray(err.body.issues)) {
    const first = err.body.issues[0] as { path?: string; message?: string } | undefined;
    if (first?.message)
      return first.path ? `${labelFor(first.path)}: ${first.message}` : first.message;
  }
  if (!(err instanceof ApiError)) return errorMessage('network_error');
  // A server fault: the dialog has already said so; the line on the screen carries the reference too.
  if (err.status >= 500 && err.status !== 503)
    return `Something went wrong on the server${err.ref ? ` (reference ${err.ref})` : ''}. Try again in a minute.`;
  // A project's records are seen by its team (and those who see every project): to anyone else they do not exist.
  if (err.status === 404 && typeof err.body.message !== 'string')
    return "This isn't here, or it belongs to a project you are not on. Ask the project's lead to add you to its team.";
  // A code without its own sentence here shows the server's message, which says what to do (e.g. "Version 2 is
  // frozen; start revision 3 to price it.").
  return errorMessage(
    err.code,
    typeof err.body.message === 'string' && err.body.message ? err.body.message : undefined,
  );
}

const labelFor = (path: string) =>
  path.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** ₹1,25,00,000 (Indian grouping). Decimal strings from the API, never floats in storage. */
export const formatInr = (value: string | null | undefined): string =>
  value === null || value === undefined || value === '' ? '-' : INR.format(Number(value));

/** ₹12.5 Cr / ₹45 L / ₹80,000: compact amounts for lists. */
export function formatInrShort(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  const n = Number(value);
  if (n >= 1e7) return `₹${trim(n / 1e7)} Cr`;
  if (n >= 1e5) return `₹${trim(n / 1e5)} L`;
  return INR.format(n);
}
const trim = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, ''));

/** <input type="datetime-local"> value in the user's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const fromLocalInput = (value: string): string | null =>
  value ? new Date(value).toISOString() : null;
