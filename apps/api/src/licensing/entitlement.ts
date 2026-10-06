// Signed entitlement tokens (docs/infra-existing-stack.md §2): apps keep working on a cached token for a few days
// if the licence service is briefly unreachable. Ed25519 signature; the app only ever needs the public key.
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { LicenceState } from './licence-rules.js';

const PREFIX = 'ent1';

export interface Entitlement {
  v: 1;
  lic: string;
  ten: string;
  tier: string;
  seats: number;
  state: LicenceState;
  /** Licence end date (ISO), so the app can show "trial ends on ...". */
  ends: string;
  dev: string;
  iat: number;
  exp: number;
}

export function signEntitlement(payload: Entitlement, privateKey: KeyObject): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = sign(null, Buffer.from(`${PREFIX}.${body}`), privateKey).toString('base64url');
  return `${PREFIX}.${body}.${sig}`;
}

export type VerifiedEntitlement =
  | { ok: true; payload: Entitlement; expired: boolean }
  | { ok: false; reason: 'malformed' | 'bad_signature' };

/** Verifies the signature. Expiry is reported, not rejected, so callers decide (refresh accepts expired tokens). */
export function verifyEntitlement(
  token: string,
  publicKey: KeyObject,
  nowSeconds: number,
): VerifiedEntitlement {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: 'malformed' };
  const [, body, sig] = parts as [string, string, string];
  if (!verify(null, Buffer.from(`${PREFIX}.${body}`), publicKey, Buffer.from(sig, 'base64url'))) {
    return { ok: false, reason: 'bad_signature' };
  }
  let payload: Entitlement;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Entitlement;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.v !== 1 || typeof payload.exp !== 'number') return { ok: false, reason: 'malformed' };
  return { ok: true, payload, expired: payload.exp <= nowSeconds };
}

export const publicKeyOf = (privateKey: KeyObject): KeyObject => createPublicKey(privateKey);
