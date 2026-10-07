// Licence keys: generation and storage helpers. The format and checksum live in @aerolith/shared so the apps can
// catch typos before calling the server. The key is a tenant locator, not a secret (docs/03-architecture.md §6), but
// it is still stored only as an HMAC for lookup plus an encrypted copy for resending.
import { KEY_ALPHABET, KEY_BODY_LENGTH, formatKeyBody, luhnCheckChar } from '@aerolith/shared';
import { createHmac, randomInt } from 'node:crypto';

export { KEY_PREFIX, parseLicenceKey, type ParsedKey } from '@aerolith/shared';

export function generateLicenceKey(): string {
  let payload = '';
  for (let i = 0; i < KEY_BODY_LENGTH - 1; i++)
    payload += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  return formatKeyBody(payload + luhnCheckChar(payload));
}

export const licenceKeyHmac = (body: string, pepper: Buffer): string =>
  createHmac('sha256', pepper).update(body).digest('hex');

export const licenceKeyLast4 = (body: string): string => body.slice(-4);
