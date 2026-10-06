// Licence keys: AERO-XXXXX-XXXXX-XXXXX-XXXXX
// 19 random Crockford base-32 characters (95 bits) + 1 Luhn mod-32 check character, so most typos are caught
// before any server lookup. The key is a tenant locator, not a secret (docs/03-architecture.md §6), but it is still
// stored only as an HMAC for lookup plus an encrypted copy for resending.
import { createHmac, randomInt } from 'node:crypto';

export const KEY_PREFIX = 'AERO';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_LENGTH = 20;

const codeOf = (ch: string): number => {
  const v = ALPHABET.indexOf(ch);
  if (v < 0) throw new Error(`invalid licence key character: ${ch}`);
  return v;
};

function luhnCheckChar(payload: string): string {
  const n = ALPHABET.length;
  let factor = 2;
  let sum = 0;
  for (let i = payload.length - 1; i >= 0; i--) {
    let addend = factor * codeOf(payload[i] as string);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  return ALPHABET[(n - (sum % n)) % n] as string;
}

function luhnValid(body: string): boolean {
  const n = ALPHABET.length;
  let factor = 1;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    let addend = factor * codeOf(body[i] as string);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  return sum % n === 0;
}

export function generateLicenceKey(): string {
  let payload = '';
  for (let i = 0; i < BODY_LENGTH - 1; i++) payload += ALPHABET[randomInt(ALPHABET.length)];
  return formatKey(payload + luhnCheckChar(payload));
}

const formatKey = (body: string): string => `${KEY_PREFIX}-${body.match(/.{5}/g)!.join('-')}`;

export type ParsedKey =
  { ok: true; body: string; formatted: string } | { ok: false; reason: 'format' | 'checksum' };

/**
 * Accepts what people actually type: any case, spaces or dashes, with or without the prefix, and the Crockford
 * look-alikes (O for 0, I and L for 1).
 */
export function parseLicenceKey(input: string): ParsedKey {
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith(KEY_PREFIX) && s.length === KEY_PREFIX.length + BODY_LENGTH)
    s = s.slice(KEY_PREFIX.length);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== BODY_LENGTH || [...s].some((c) => !ALPHABET.includes(c)))
    return { ok: false, reason: 'format' };
  if (!luhnValid(s)) return { ok: false, reason: 'checksum' };
  return { ok: true, body: s, formatted: formatKey(s) };
}

export const licenceKeyHmac = (body: string, pepper: Buffer): string =>
  createHmac('sha256', pepper).update(body).digest('hex');

export const licenceKeyLast4 = (body: string): string => body.slice(-4);
