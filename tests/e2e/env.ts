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

/**
 * Testing an already-running stack (e.g. the Docker Compose stack) instead of starting dev servers:
 *   E2E_BASE_URL       public site, e.g. http://127.0.0.1:8080
 *   E2E_OWNER_URL      owner-console listener, e.g. http://127.0.0.1:8081
 *   E2E_OPERATOR_CMD   command that runs create-operator.js, e.g. "docker compose -f deploy/docker-compose.yml exec -T api node dist/cli/create-operator.js"
 *   E2E_OPERATOR_CWD   folder to run that command in (default: the e2e folder)
 *   E2E_MAIL_DIR       folder where that stack writes .eml files
 */
export const EXTERNAL = Boolean(process.env.E2E_BASE_URL);
export const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${WEB_PORT}`;
export const PUBLIC_API = `${process.env.E2E_BASE_URL ?? `http://127.0.0.1:${API_PORT}`}/api`;
export const OWNER_API = `${process.env.E2E_OWNER_URL ?? `http://127.0.0.1:${API_PORT}`}/api`;
export const INBOX_DIR = process.env.E2E_MAIL_DIR ?? MAIL_DIR;
export const OPERATOR_CMD = process.env.E2E_OPERATOR_CMD?.split(' ').filter(Boolean);
export const OPERATOR_CWD = process.env.E2E_OPERATOR_CWD;
