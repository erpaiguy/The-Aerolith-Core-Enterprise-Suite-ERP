// Which API addresses a packaged build may talk to: https anywhere, and plain http only to this computer itself (a
// server or the demo running on the same PC), where nothing travels over a network.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function apiUrlAllowed(url: URL, packaged: boolean): boolean {
  if (!packaged || url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}
