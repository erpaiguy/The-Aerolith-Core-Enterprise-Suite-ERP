// Shared settings for the e2e run. The databases are throwaway: the run drops and recreates them.
export const ADMIN_URL =
  process.env.E2E_PG_ADMIN_URL ?? 'postgres://bench:bench@127.0.0.1:5432/postgres';
export const CONTROL_URL = (() => {
  const u = new URL(ADMIN_URL);
  u.pathname = '/aerolith_e2e';
  return u.toString();
})();
// Fixed test-only encryption key for the e2e API. Never used outside e2e.
export const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
export const WEB_PORT = 4173;
export const API_PORT = 3100;
// The API writes real .eml files here (EMAIL_TRANSPORT=file); the test reads them like an inbox.
export const MAIL_DIR = new URL('./.mail/', import.meta.url).pathname;
