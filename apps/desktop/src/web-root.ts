// Pure helpers for serving the UI (no Electron imports, so they are unit-testable in plain Node).
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

/** Content-Security-Policy for the UI: only our own code, and network calls only to the configured API. */
export const contentSecurityPolicy = (apiBaseUrl: string): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // blob: = documents previewed inside the app (fetched by our own code, typed by the server's check of the bytes).
    "img-src 'self' data: blob:",
    'frame-src blob:',
    "font-src 'self'",
    `connect-src 'self' ${apiBaseUrl}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');

export function resolveAppPath(webRoot: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const root = normalize(webRoot);
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null; // path traversal
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return extname(decoded) ? null : join(root, 'index.html');
}
