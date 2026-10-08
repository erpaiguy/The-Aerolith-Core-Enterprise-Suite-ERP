import { defineConfig } from '@playwright/test';
import {
  ADMIN_URL,
  API_PORT,
  BASE_URL,
  CONTROL_URL,
  ENC_KEY,
  EXTERNAL,
  MAIL_DIR,
  WEB_PORT,
} from './env.js';

const api = `../../apps/api/dist`;
const apiEnv = [
  'NODE_ENV=development',
  `PORT=${API_PORT}`,
  `CONTROL_DATABASE_URL=${CONTROL_URL}`,
  `LOCAL_PG_ADMIN_URL=${ADMIN_URL}`,
  `CONTROL_PLANE_ENC_KEY=${ENC_KEY}`,
  `PUBLIC_API_URL=http://127.0.0.1:${WEB_PORT}`,
  `WEBSITE_URL=http://127.0.0.1:${WEB_PORT}`,
  'RATE_LIMIT_SCALE=10',
  'EMAIL_TRANSPORT=file',
  `EMAIL_FILE_DIR=${MAIL_DIR}`,
  `EMAIL_FROM='Aerolith Core <no-reply@aerolith.test>'`,
].join(' ');

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    // Use a pre-installed Chromium when one is provided (sandboxed environments); CI installs its own.
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
  // With E2E_BASE_URL the stack is already running (Docker); otherwise start the API and the web preview here.
  webServer: EXTERNAL
    ? []
    : [
        {
          command: `node reset-db.mjs && env ${apiEnv} node ${api}/cli/migrate-control.js && env ${apiEnv} node ${api}/main.js`,
          url: `http://127.0.0.1:${API_PORT}/api/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          stdout: 'pipe',
        },
        {
          command: `pnpm --filter @aerolith/web exec vite preview --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
          env: { API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}` },
          url: `http://127.0.0.1:${WEB_PORT}`,
          reuseExistingServer: false,
          timeout: 60_000,
        },
      ],
});
