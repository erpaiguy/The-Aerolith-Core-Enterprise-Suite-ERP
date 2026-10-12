// Writes capacitor.config.json for one deployment. The phone app opens that deployment's web app, which is the
// installable app with its own offline cache and outbox (apps/web/public/sw.js); the shell adds the store listing,
// the camera and location permissions, and nothing of its own. Run: AEROLITH_SERVER_URL=https://erp.example.in
// pnpm --filter @aerolith/mobile android
import { writeFileSync } from 'node:fs';

const raw = process.env.AEROLITH_SERVER_URL ?? '';
let url;
try {
  url = new URL(raw);
} catch {
  console.error('Set AEROLITH_SERVER_URL to the deployment, for example https://erp.example.in');
  process.exit(1);
}
if (url.protocol !== 'https:') {
  console.error('AEROLITH_SERVER_URL must be https.');
  process.exit(1);
}

const config = {
  appId: process.env.AEROLITH_APP_ID ?? 'in.aerolith.core',
  appName: process.env.AEROLITH_APP_NAME ?? 'Aerolith Core',
  // Shown only before the deployment's page first loads, or when it cannot be reached at all.
  webDir: 'www',
  server: { url: url.origin, cleartext: false, allowNavigation: [url.host] },
  android: { allowMixedContent: false },
};
writeFileSync('capacitor.config.json', `${JSON.stringify(config, null, 2)}\n`);
console.log(`capacitor.config.json written for ${url.origin}`);
