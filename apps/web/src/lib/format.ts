export const daysUntil = (iso: string, now = new Date()): number =>
  Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);

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
    network_error: 'Cannot reach the server. Check your internet connection.',
  };
  return (code && messages[code]) || fallback;
}
