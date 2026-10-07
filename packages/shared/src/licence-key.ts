// Licence key format shared by the API and the apps: AERO-XXXXX-XXXXX-XXXXX-XXXXX.
// 19 random Crockford base-32 characters + 1 Luhn mod-32 check character, so typos are caught before any lookup.

export const KEY_PREFIX = 'AERO';
export const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const KEY_BODY_LENGTH = 20;

const codeOf = (ch: string): number => {
  const v = KEY_ALPHABET.indexOf(ch);
  if (v < 0) throw new Error(`invalid licence key character: ${ch}`);
  return v;
};

function luhnSum(s: string, startFactor: 1 | 2): number {
  const n = KEY_ALPHABET.length;
  let factor = startFactor;
  let sum = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    let addend = factor * codeOf(s[i] as string);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / n) + (addend % n);
    sum += addend;
  }
  return sum;
}

export function luhnCheckChar(payload: string): string {
  const n = KEY_ALPHABET.length;
  return KEY_ALPHABET[(n - (luhnSum(payload, 2) % n)) % n] as string;
}

export const formatKeyBody = (body: string): string =>
  `${KEY_PREFIX}-${body.match(/.{5}/g)!.join('-')}`;

export type ParsedKey =
  { ok: true; body: string; formatted: string } | { ok: false; reason: 'format' | 'checksum' };

/**
 * Accepts what people actually type: any case, spaces or dashes, with or without the prefix, and the Crockford
 * look-alikes (O for 0, I and L for 1).
 */
export function parseLicenceKey(input: string): ParsedKey {
  let s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.startsWith(KEY_PREFIX) && s.length === KEY_PREFIX.length + KEY_BODY_LENGTH)
    s = s.slice(KEY_PREFIX.length);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== KEY_BODY_LENGTH || [...s].some((c) => !KEY_ALPHABET.includes(c)))
    return { ok: false, reason: 'format' };
  if (luhnSum(s, 1) % KEY_ALPHABET.length !== 0) return { ok: false, reason: 'checksum' };
  return { ok: true, body: s, formatted: formatKeyBody(s) };
}
