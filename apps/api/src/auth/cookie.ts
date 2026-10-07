// Browser refresh tokens live in an HttpOnly cookie, so page scripts (and any injected script) can never read them
// (docs/09-security.md §3.3). The cookie is scoped to /api/auth and SameSite=Strict; refresh and logout also require
// a custom header, which a cross-site page cannot send without passing our CORS allow-list.
export const REFRESH_COOKIE = 'aerolith_rt';
export const CLIENT_HEADER = 'x-aerolith-client';
const MAX_AGE_SECONDS = 30 * 86_400;

export function refreshCookie(token: string, secure: boolean): string {
  return [
    `${REFRESH_COOKIE}=${token}`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${MAX_AGE_SECONDS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedRefreshCookie(secure: boolean): string {
  return [
    `${REFRESH_COOKIE}=`,
    'Path=/api/auth',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name)
      return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
