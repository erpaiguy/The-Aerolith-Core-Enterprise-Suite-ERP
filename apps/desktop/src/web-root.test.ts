import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, resolveAppPath } from './web-root.js';

const root = mkdtempSync(join(tmpdir(), 'aerolith-web-'));
mkdirSync(join(root, 'assets'));
writeFileSync(join(root, 'index.html'), '<!doctype html>');
writeFileSync(join(root, 'assets', 'app.js'), '');

describe('resolveAppPath', () => {
  it('serves files inside the web root', () => {
    expect(resolveAppPath(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    expect(resolveAppPath(root, '/index.html')).toBe(join(root, 'index.html'));
  });

  it('falls back to index.html for client-side routes but not for missing files', () => {
    expect(resolveAppPath(root, '/users')).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, '/account/set-password')).toBe(join(root, 'index.html'));
    expect(resolveAppPath(root, '/assets/missing.js')).toBeNull();
  });

  it('refuses to leave the web root', () => {
    for (const p of [
      '/../package.json',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/assets/../../secret.txt',
      '/..%2fpackage.json',
      '/%E0%A4%A',
    ]) {
      const resolved = resolveAppPath(root, p);
      expect(resolved === null || resolved === join(root, 'index.html')).toBe(true);
    }
  });
});

describe('contentSecurityPolicy', () => {
  it('allows only our own code and the configured API', () => {
    const csp = contentSecurityPolicy('https://api.example.in');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' https://api.example.in");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('unsafe-eval');
  });
});
