// DEVELOPMENT ONLY: prints the newest queued emails with their links decrypted, so the set-password, reset and
// onboarding flows can be tested before the email worker exists. Refuses to run with NODE_ENV=production.
//   pnpm --filter @aerolith/api dev:outbox [-- --limit 10]
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/config.js';
import { open } from '../crypto/secretbox.js';
import { connectControlDb } from '../db/db.module.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.env === 'production') throw new Error('dev:outbox is disabled in production');
  if (config.ephemeralSecrets.includes('CONTROL_PLANE_ENC_KEY')) {
    throw new Error(
      'Set CONTROL_PLANE_ENC_KEY in apps/api/.env; links sealed by the running API cannot be opened otherwise.',
    );
  }
  const { values } = parseArgs({ options: { limit: { type: 'string', default: '10' } } });
  const sql = connectControlDb(config.controlDatabaseUrl);
  try {
    const rows = await sql<
      { to_email: string; template: string; data: Record<string, unknown>; created_at: Date }[]
    >`
      SELECT to_email, template, data, created_at FROM core.email_outbox ORDER BY created_at DESC LIMIT ${Number(values.limit)}`;
    for (const r of rows) {
      const link =
        typeof r.data.link === 'string' ? open(r.data.link, config.controlPlaneEncKey) : null;
      process.stdout.write(
        `${r.created_at.toISOString()}  ${r.template.padEnd(22)} ${r.to_email}${link ? `\n    ${link}` : ''}\n`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
