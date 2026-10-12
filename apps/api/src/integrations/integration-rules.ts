// Integration rules (docs/wave6-plan.md step 6), free of the database and the network so they are tested directly.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

export const SCOPES = ['reports:read', 'tally'] as const;
export type Scope = (typeof SCOPES)[number];

/** `aek1.<tenant>.<key id>.<secret>`: the tenant comes from the key, never from the caller. */
export function parseApiKey(raw: string): { tenant: string; id: string; secret: string } | null {
  const m = /^aek1\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  return m ? { tenant: m[1]!, id: m[2]!, secret: m[3]! } : null;
}

/** The webhook signature: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function sign(secret: string, t: number, body: string): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** For receivers (and the tests): the header is valid for this body and not older than `toleranceSeconds`. */
export function verify(
  secret: string,
  header: string,
  body: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = Buffer.from(sign(secret, t, body).split('v1=')[1]!, 'hex');
  const given = Buffer.from(m[2]!, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Minutes to wait after each failed attempt; after the last, the delivery is given up. */
export const RETRY_MINUTES = [1, 5, 30, 120, 720];

export function nextAttempt(attempts: number, now: Date): Date | null {
  const wait = RETRY_MINUTES[attempts - 1];
  return wait === undefined ? null : new Date(now.getTime() + wait * 60_000);
}

/** Loopback, private, link-local, carrier-grade NAT, unique-local and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  return true;
}
