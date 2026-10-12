// Browser refresh tokens live in an HttpOnly cookie, so page scripts (and any injected script) can never read them
// (docs/09-security.md §3.3). The cookie is scoped to /api/auth and SameSite=Strict; refresh and logout also require
// a custom header, which a cross-site page cannot send without passing our CORS allow-list.
export const REFRESH_COOKIE = 'aerolith_rt';
export const CLIENT_HEADER = 'x-aerolith-client';
const MAX_AGE_SECONDS = 30 * 86_400;

// The owner console uses its own cookie scoped to /api/owner/auth. It is only ever served on the loopback owner
// listener (http://127.0.0.1:8081, or an SSH tunnel to it), so it never carries Secure: browsers would drop a Secure
// cookie set over plain http on some loopback addresses, and the traffic never leaves the machine.
export const OPERATOR_REFRESH_COOKIE = 'aerolith_ort';
const OPERATOR_MAX_AGE_SECONDS = 12 * 3600;

function cookie(name: string, path: string, value: string, maxAge: number, secure: boolean) {
  return [
    `${name}=${value}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export const refreshCookie = (token: string, secure: boolean): string =>
  cookie(REFRESH_COOKIE, '/api/auth', token, MAX_AGE_SECONDS, secure);

export const clearedRefreshCookie = (secure: boolean): string =>
  cookie(REFRESH_COOKIE, '/api/auth', '', 0, secure);

// Portal users (vendors, subcontractors, clients) keep their own cookie, scoped to the portal's auth routes.
export const PORTAL_REFRESH_COOKIE = 'aerolith_prt';
export const portalRefreshCookie = (token: string, secure: boolean): string =>
  cookie(PORTAL_REFRESH_COOKIE, '/api/portal/auth', token, MAX_AGE_SECONDS, secure);
export const clearedPortalRefreshCookie = (secure: boolean): string =>
  cookie(PORTAL_REFRESH_COOKIE, '/api/portal/auth', '', 0, secure);

export const operatorRefreshCookie = (token: string): string =>
  cookie(OPERATOR_REFRESH_COOKIE, '/api/owner/auth', token, OPERATOR_MAX_AGE_SECONDS, false);

export const clearedOperatorRefreshCookie = (): string =>
  cookie(OPERATOR_REFRESH_COOKIE, '/api/owner/auth', '', 0, false);

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
