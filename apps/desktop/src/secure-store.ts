// Refresh token at rest, encrypted with the OS keychain (Windows DPAPI, macOS Keychain, Linux libsecret) through
// Electron's safeStorage (docs/09-security.md §3.3). If no keychain is available the token is kept in memory only,
// so the user signs in again after restarting, rather than storing it in plain text.
import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const tokenFile = () => join(app.getPath('userData'), 'session.bin');
const deviceFile = () => join(app.getPath('userData'), 'device.json');
let memoryToken: string | null = null;

export function getRefreshToken(): string | null {
  if (!safeStorage.isEncryptionAvailable()) return memoryToken;
  if (!existsSync(tokenFile())) return null;
  try {
    return safeStorage.decryptString(readFileSync(tokenFile()));
  } catch {
    rmSync(tokenFile(), { force: true });
    return null;
  }
}

export function setRefreshToken(token: string | null): void {
  if (!safeStorage.isEncryptionAvailable()) {
    memoryToken = token;
    return;
  }
  if (token === null) rmSync(tokenFile(), { force: true });
  else writeFileSync(tokenFile(), safeStorage.encryptString(token), { mode: 0o600 });
}

/** A random id per installation, used for licence device activation. Not derived from hardware. */
export function deviceId(): string {
  try {
    const stored = JSON.parse(readFileSync(deviceFile(), 'utf8')) as { id?: string };
    if (stored.id && /^[0-9a-f-]{36}$/.test(stored.id)) return stored.id;
  } catch {
    // first run
  }
  const id = randomUUID();
  writeFileSync(deviceFile(), JSON.stringify({ id }), { mode: 0o600 });
  return id;
}
