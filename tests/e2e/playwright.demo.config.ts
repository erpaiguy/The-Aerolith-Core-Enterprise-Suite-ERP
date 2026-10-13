// The demo walkthrough (docs/demo.md): signs in as every seeded person on an already-running, seeded stack and
// opens every screen they can reach, recording crashes, failed requests and error banners.
//   DEMO_BASE_URL=http://127.0.0.1:8080 DEMO_JSON=../../demo-credentials.json pnpm exec playwright test -c playwright.demo.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './demo',
  timeout: 600_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:8080',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH }
      : {},
  },
});
