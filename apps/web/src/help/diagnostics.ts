// A support request's diagnostics (docs/wave9-plan.md step 9b.2): what support needs to find the problem — the version,
// browser or desktop app, platform, page, time and the last requests' references — and nothing else. No passwords,
// tokens, record contents or query strings: the person reads the whole block before it leaves the app.
import type { RequestRecord } from '../api/client';

/** Where support requests go. There is no support service behind the app: an email, or the company's own contact. */
export const SUPPORT_EMAIL = '';

export interface Diagnostics {
  version: string;
  /** 'Desktop app' or 'Browser'. */
  client: string;
  browser: string;
  platform: string;
  /** The page's path, without its query string. */
  page: string;
  /** The help topic's title for the page, when there is one. */
  screen: string | null;
  at: Date;
  requests: RequestRecord[];
}

/** "Chrome 130", "Firefox 131", "Safari 18", "Edge 130", or the first part of the user agent. */
export function browserName(ua: string): string {
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1]}` : null;
  };
  return (
    pick(/Edg\/(\d+)/, 'Edge') ??
    pick(/Electron\/(\d+)/, 'Electron') ??
    pick(/Firefox\/(\d+)/, 'Firefox') ??
    pick(/Chrome\/(\d+)/, 'Chrome') ??
    pick(/Version\/(\d+)[\d.]* .*Safari\//, 'Safari') ??
    (ua.split(' ')[0] || 'Unknown')
  );
}

/** The plain-text block shown to the person, copied and emailed. */
export function diagnosticsText(d: Diagnostics): string {
  const lines = [
    `App version: ${d.version}`,
    `Running in: ${d.client} (${d.browser})`,
    `Platform: ${d.platform || 'unknown'}`,
    `Page: ${d.page.split(/[?#]/)[0]}${d.screen ? ` (${d.screen})` : ''}`,
    `Time: ${d.at.toISOString()}`,
    `Recent requests (newest last):`,
  ];
  if (!d.requests.length) lines.push('  none');
  for (const r of d.requests)
    lines.push(
      `  ${r.at} ${r.method} ${r.path.split(/[?#]/)[0]} ${r.status || 'no answer'}${r.ref ? ` ref ${r.ref}` : ''}`,
    );
  return lines.join('\n');
}

export interface SupportRequest {
  subject: string;
  happened: string;
  expected: string;
}

export function supportBody(r: SupportRequest, diagnostics: string): string {
  return [
    'What happened:',
    r.happened.trim() || '(not given)',
    '',
    'What I expected:',
    r.expected.trim() || '(not given)',
    '',
    '--- Diagnostics ---',
    diagnostics,
  ].join('\n');
}

/** A mailto: link; the address may be empty, for the person to fill in. */
export function mailtoLink(to: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(to).replace(/%40/g, '@')}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(body)}`;
}
