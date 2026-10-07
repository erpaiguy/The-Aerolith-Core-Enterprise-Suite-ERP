// Serves the bundled web UI on app://aerolith. Unknown paths without a file extension get index.html so client-side
// routes work after a reload. Requests can never escape the web root.
import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { contentSecurityPolicy, resolveAppPath } from './web-root.js';

export function registerSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

export function serveApp(webRoot: string, apiBaseUrl: string): void {
  const csp = contentSecurityPolicy(apiBaseUrl);
  protocol.handle('app', async (request) => {
    const url = new URL(request.url);
    const file = url.host === 'aerolith' ? resolveAppPath(webRoot, url.pathname) : null;
    if (!file) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}
